import { claimDueFeedbacks, resetStuckSending, updateFeedback } from './db';
import { sendFeedbackTemplate, credentialsFor, restaurantLabel, templateParam } from './whatsapp';
import { notifyManagers } from './notify';
import { config } from './config';
import { Feedback } from './types';
import { checkReports } from './report-scheduler';

async function sendOne(feedback: Feedback): Promise<void> {
  const org = feedback.org!;
  const creds = credentialsFor(org);
  try {
    const wamid = await sendFeedbackTemplate(
      creds,
      feedback.customerPhone,
      org.templateName,
      {
        restaurantLabel: restaurantLabel(org),
        customerName: feedback.customerName,
        managerName: org.managerName,
      }
    );
    await updateFeedback(feedback.id, {
      status: 'sent',
      sentAt: new Date(),
      waMessageId: wamid ?? undefined,
      conversationState: 'waiting_feedback',
    });
    console.log(`[scheduler] Sent feedback #${feedback.id} to ${feedback.customerPhone} (${org.name})`);
  } catch (err: any) {
    const detail = JSON.stringify(err?.response?.data?.error ?? err?.message ?? err);
    console.error(`[scheduler] Failed to send #${feedback.id} to ${feedback.customerPhone}:`, detail);
    await updateFeedback(feedback.id, { status: 'error', errorDetail: detail.slice(0, 500) });

    // Best-effort: tell every manager the message never went out.
    try {
      const who = feedback.customerName || feedback.customerPhone;
      await notifyManagers(org, {
        kind: 'send_failed',
        template: 'manager_send_failed',
        params: [org.name, who, feedback.customerPhone].map((v) => templateParam(v)),
        fallbackText: `⚠️ [${org.name}] שליחת הודעת פידבק ל${who} (+${feedback.customerPhone}) נכשלה. בדוק שהמספר תקין ונסה שוב דרך דף הניהול.`,
        feedbackId: feedback.id,
      });
    } catch (notifyErr) {
      console.error('[scheduler] Manager failure notice failed:', notifyErr);
    }
  }
}

let polling = false;

export async function pollOnce(): Promise<void> {
  if (polling) return; // previous tick still running
  polling = true;
  try {
    const due = await claimDueFeedbacks();
    for (const feedback of due) {
      if (!feedback.org) {
        await updateFeedback(feedback.id, { status: 'error', errorDetail: 'org not found' });
        continue;
      }
      // claimDueFeedbacks filters only on the feedback row itself — a row
      // scheduled before the org was disabled is still 'pending' and due,
      // and would otherwise go out anyway. isActive must be re-checked here.
      if (!feedback.org.isActive) {
        await updateFeedback(feedback.id, { status: 'error', errorDetail: 'org is inactive' });
        continue;
      }
      await sendOne(feedback);
    }
    // Closing-time reports ride the same tick; each is claimed once, so
    // polling every 20 seconds costs one cheap check per org.
    await checkReports();
  } catch (err) {
    console.error('[scheduler] Poll failed:', err);
  } finally {
    polling = false;
  }
}

export async function startScheduler(): Promise<void> {
  // Single-process server: anything still in 'sending' at boot is a crash leftover
  const recovered = await resetStuckSending();
  if (recovered > 0) console.log(`[scheduler] Recovered ${recovered} feedbacks stuck in 'sending'`);

  setInterval(() => void pollOnce(), config.pollIntervalMs);
  console.log(`[scheduler] Polling every ${config.pollIntervalMs / 1000}s`);
  void pollOnce();
}
