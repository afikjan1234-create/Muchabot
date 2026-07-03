import { claimDueFeedbacks, resetStuckSending, updateFeedback } from './db';
import { sendFeedbackTemplate, sendTextMessage, credentialsFor } from './whatsapp';
import { config } from './config';
import { Feedback } from './types';

async function sendOne(feedback: Feedback): Promise<void> {
  const org = feedback.org!;
  const creds = credentialsFor(org);
  try {
    const wamid = await sendFeedbackTemplate(
      creds,
      feedback.customerPhone,
      org.templateName,
      org.managerName,
      feedback.customerName
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

    // Best-effort: tell the restaurant manager the message never went out
    try {
      await sendTextMessage(
        creds,
        org.managerPhone,
        `⚠️ [${org.name}] שליחת הודעת פידבק ל${feedback.customerName || feedback.customerPhone} (+${feedback.customerPhone}) נכשלה. בדוק שהמספר תקין ונסה שוב דרך דף הניהול.`
      );
    } catch {
      // Manager notification is best-effort only
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
      await sendOne(feedback);
    }
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
