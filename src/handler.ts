import {
  createFeedback,
  getActiveFeedbackByPhone,
  getFeedbackByWamid,
  updateFeedback,
} from './db';
import { sendTextMessage, sendReplyButtons, downloadMedia } from './whatsapp';
import { extractCustomerFromImage, looksLikePhone } from './ocr';
import { Org } from './types';

// ─── Owner (restaurant) flow ────────────────────────────────────────────────
// Ephemeral per-owner conversation state; keyed by the owner's phone so
// multiple restaurants can talk to the bot at the same time.

type PendingOwnerState = (
  | { state: 'waiting_for_name'; customerPhone: string }
  | { state: 'waiting_for_phone' }
) & { setAt: number };

const pendingOwnerStates = new Map<string, PendingOwnerState>();

// A stale "what's the customer's name?" prompt must not swallow unrelated
// owner texts sent hours later (that's how a complaint once became a
// customer name). Expire pending prompts after 15 minutes.
const PENDING_TTL_MS = 15 * 60_000;

function getPendingState(ownerPhone: string): PendingOwnerState | undefined {
  const pending = pendingOwnerStates.get(ownerPhone);
  if (!pending) return undefined;
  if (Date.now() - pending.setAt > PENDING_TTL_MS) {
    pendingOwnerStates.delete(ownerPhone);
    return undefined;
  }
  return pending;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('he-IL', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  });
}

async function scheduleAndConfirm(org: Org, customerPhone: string, customerName: string): Promise<string> {
  const scheduledAt = new Date(Date.now() + org.feedbackDelayMinutes * 60_000);
  await createFeedback(org.id, customerPhone, customerName, scheduledAt);
  return `✅ נקלט: ${customerName} (+${customerPhone})\nהודעת פידבק מטעם ${org.name} תישלח ב-${formatTime(scheduledAt)}.`;
}

export async function handleOwnerImage(
  org: Org,
  ownerPhone: string,
  mediaId: string,
  caption: string | null
): Promise<string> {
  const { buffer, mimeType } = await downloadMedia(mediaId);
  const extracted = await extractCustomerFromImage(buffer, mimeType);

  if (!extracted.phone) {
    pendingOwnerStates.set(ownerPhone, { state: 'waiting_for_phone', setAt: Date.now() });
    return '⚠️ לא הצלחתי לזהות מספר טלפון בתמונה.\nשלח את המספר ישירות כהודעת טקסט (למשל: 0501234567)';
  }

  // Caption wins over OCR-extracted name — the owner typed it on purpose
  const customerName = caption?.trim() || extracted.name;
  if (customerName) {
    return scheduleAndConfirm(org, extracted.phone, customerName);
  }

  pendingOwnerStates.set(ownerPhone, {
    state: 'waiting_for_name',
    customerPhone: extracted.phone,
    setAt: Date.now(),
  });
  return `✅ זוהה מספר: +${extracted.phone}\nמה שם הלקוח?`;
}

export async function handleOwnerText(org: Org, ownerPhone: string, text: string): Promise<string> {
  const trimmed = text.trim();

  if (trimmed === 'ביטול') {
    pendingOwnerStates.delete(ownerPhone);
    return 'בוטל. שלח תמונה של הזמנה חדשה כשתרצה.';
  }

  const pending = getPendingState(ownerPhone);

  if (!pending || pending.state === 'waiting_for_phone') {
    const phone = looksLikePhone(trimmed);
    if (phone) {
      pendingOwnerStates.set(ownerPhone, { state: 'waiting_for_name', customerPhone: phone, setAt: Date.now() });
      return `✅ מספר: +${phone}\nמה שם הלקוח?`;
    }
    if (pending?.state === 'waiting_for_phone') {
      return 'לא זיהיתי מספר טלפון תקין. שלח את המספר בפורמט: 0501234567 (או "ביטול")';
    }
    return `שלום! כאן בוט הפידבק של ${org.name} 🤖\nשלח תמונה של פרטי ההזמנה (טלפון + שם לקוח), או הקלד מספר טלפון ישירות.`;
  }

  // waiting_for_name
  const customerName = trimmed;
  const { customerPhone } = pending;
  pendingOwnerStates.delete(ownerPhone);
  return scheduleAndConfirm(org, customerPhone, customerName);
}

// ─── Customer flow ──────────────────────────────────────────────────────────

// Matches both the template button payloads/texts and our interactive re-prompt button ids
const MANAGER_PATTERNS = /מנהל|לא טוב|תלונ|NEGATIVE|FEEDBACK_MANAGER/i;
const POSITIVE_PATTERNS = /מעולה|מצוין|מצויין|טוב|נהנ|POSITIVE|FEEDBACK_POSITIVE/i;

export async function handleCustomerMessage(
  customerPhone: string,
  payload: string,
  contextWamid: string | null
): Promise<void> {
  // Button replies carry the wamid of the template they answer — exact routing.
  // Free-text replies fall back to the latest sent feedback for this phone.
  let feedback = contextWamid ? await getFeedbackByWamid(contextWamid) : null;
  if (!feedback || !feedback.org) {
    feedback = await getActiveFeedbackByPhone(customerPhone);
  }
  if (!feedback?.org || !feedback.conversationState) {
    console.log(`[handler] Ignoring message from ${customerPhone} — no active feedback`);
    return;
  }
  const org = feedback.org;

  if (feedback.conversationState === 'waiting_feedback') {
    // Order matters: "לא טוב" contains "טוב", so check the manager path first
    if (MANAGER_PATTERNS.test(payload)) {
      await sendTextMessage(
        customerPhone,
        'מצטערים לשמוע 😔 נשמח אם תספר לנו מה קרה כדי שנוכל להשתפר:'
      );
      await updateFeedback(feedback.id, { conversationState: 'waiting_reason', result: 'manager' });
    } else if (POSITIVE_PATTERNS.test(payload)) {
      await sendTextMessage(
        customerPhone,
        `תודה רבה! 🙏 שמחים שנהנית מ${org.name}!\n\nנשמח אם תדרג אותנו בוולט ⭐⭐⭐⭐⭐:\n${org.woltRatingUrl}`
      );
      await updateFeedback(feedback.id, {
        status: 'completed',
        conversationState: 'resolved',
        result: 'positive',
      });
    } else {
      // Free text that isn't clearly positive/negative — re-prompt with buttons
      // (allowed: the customer's message opened a 24h session window)
      await sendReplyButtons(customerPhone, `איך הייתה החוויה שלך מ${org.name}?`, [
        { id: 'FEEDBACK_POSITIVE', title: 'הייתה מעולה! 😊' },
        { id: 'FEEDBACK_MANAGER', title: 'אשמח לדבר עם מנהל' },
      ]);
    }
    return;
  }

  if (feedback.conversationState === 'waiting_reason') {
    const customerName = feedback.customerName || `+${customerPhone}`;
    await sendTextMessage(
      org.managerPhone,
      `⚠️ [${org.name}] פנייה מלקוח ${customerName} (+${customerPhone}):\n\n"${payload}"\n\nנדרש טיפול אנושי — צור קשר עם הלקוח.`
    );
    await sendTextMessage(
      customerPhone,
      `תודה על הפידבק 🙏 מנהל ${org.name} יצור איתך קשר בקרוב לטיפול בנושא.`
    );
    await updateFeedback(feedback.id, {
      status: 'completed',
      conversationState: 'resolved',
      complaint: payload,
    });
  }
}
