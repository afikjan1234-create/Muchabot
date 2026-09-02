import {
  createFeedback,
  getActiveFeedbackByPhone,
  getFeedbackByWamid,
  updateFeedback,
} from './db';
import { sendTextMessage, sendReplyButtons, downloadMedia, credentialsFor } from './whatsapp';
import {
  extractCustomerFromImage,
  formatIsraeliPhone,
  isReachableOnWhatsApp,
  looksLikePhone,
} from './ocr';
import { Org } from './types';

// ─── Owner (restaurant) flow ────────────────────────────────────────────────
// Ephemeral per-owner conversation state; keyed by the owner's phone so
// multiple restaurants can talk to the bot at the same time.

type PendingOwnerState = (
  | { state: 'waiting_for_name'; customerPhone: string }
  | { state: 'waiting_for_phone' }
  | { state: 'confirming_phone'; customerPhone: string; customerName: string | null }
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
  const { buffer, mimeType } = await downloadMedia(credentialsFor(org), mediaId);
  const extracted = await extractCustomerFromImage(buffer, mimeType);

  if (!extracted.phone) {
    pendingOwnerStates.set(ownerPhone, { state: 'waiting_for_phone', setAt: Date.now() });
    return '⚠️ לא הצלחתי לזהות מספר טלפון בתמונה.\nשלח את המספר ישירות כהודעת טקסט (למשל: 0501234567)';
  }

  // Caption wins over OCR-extracted name — the owner typed it on purpose
  const customerName = caption?.trim() || extracted.name;

  // A number read off a blurry photo gets one human glance before we message
  // it. Scheduling on a misread digit sends this restaurant's feedback request
  // to a stranger, and neither the owner nor the customer would ever find out.
  if (extracted.confidence === 'low') {
    pendingOwnerStates.set(ownerPhone, {
      state: 'confirming_phone',
      customerPhone: extracted.phone,
      customerName: customerName ?? null,
      setAt: Date.now(),
    });
    const nameLine = customerName ? `\nשם: ${customerName}` : '';
    return `🔍 התמונה לא הייתה חדה, אז כדאי לוודא.\nמספר: ${formatIsraeliPhone(extracted.phone)}${nameLine}\n\nהאם זה נכון? השב "כן" לאישור, או שלח את המספר הנכון.`;
  }

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

const CONFIRM_PATTERN = /^(כן|נכון|אישור|מאשר|אוקיי|אוקי|ok|yes|✅|👍)$/i;

const UNREACHABLE_REPLY =
  '⚠️ זה לא נראה כמו מספר נייד ישראלי, ו-WhatsApp לא יוכל להגיע אליו.\nשלח מספר בפורמט 0501234567 (או "ביטול")';

/**
 * Takes a customer phone the owner has vouched for and moves to the next step:
 * scheduling right away when the name is already known, otherwise asking for it.
 */
async function acceptPhone(
  org: Org,
  ownerPhone: string,
  phone: string,
  name: string | null
): Promise<string> {
  if (name) {
    pendingOwnerStates.delete(ownerPhone);
    return scheduleAndConfirm(org, phone, name);
  }
  pendingOwnerStates.set(ownerPhone, {
    state: 'waiting_for_name',
    customerPhone: phone,
    setAt: Date.now(),
  });
  return `✅ מספר: ${formatIsraeliPhone(phone)}\nמה שם הלקוח?`;
}

export async function handleOwnerText(org: Org, ownerPhone: string, text: string): Promise<string> {
  const trimmed = text.trim();

  if (trimmed === 'ביטול') {
    pendingOwnerStates.delete(ownerPhone);
    return 'בוטל. שלח תמונה של הזמנה חדשה כשתרצה.';
  }

  const pending = getPendingState(ownerPhone);

  // Proof-reading a number the bot read off a poor-quality image: either the
  // owner confirms it, or the correction they send replaces it outright.
  if (pending?.state === 'confirming_phone') {
    if (CONFIRM_PATTERN.test(trimmed)) {
      return acceptPhone(org, ownerPhone, pending.customerPhone, pending.customerName);
    }
    const corrected = looksLikePhone(trimmed);
    if (corrected) {
      if (!isReachableOnWhatsApp(corrected)) return UNREACHABLE_REPLY;
      return acceptPhone(org, ownerPhone, corrected, pending.customerName);
    }
    return `לא הבנתי. אם ${formatIsraeliPhone(pending.customerPhone)} נכון — השב "כן".\nאחרת שלח את המספר הנכון, או "ביטול".`;
  }

  if (!pending || pending.state === 'waiting_for_phone') {
    const phone = looksLikePhone(trimmed);
    if (phone) {
      if (!isReachableOnWhatsApp(phone)) return UNREACHABLE_REPLY;
      return acceptPhone(org, ownerPhone, phone, null);
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
  const creds = credentialsFor(org);

  if (feedback.conversationState === 'waiting_feedback') {
    // Order matters: "לא טוב" contains "טוב", so check the manager path first
    if (MANAGER_PATTERNS.test(payload)) {
      const customerName = feedback.customerName || `+${customerPhone}`;
      // Notify the manager immediately — the customer asked to be contacted.
      // This must not depend on them typing a reason (many press and stop).
      await sendTextMessage(
        creds,
        org.managerPhone,
        `📞 [${org.name}] הלקוח ${customerName} (+${customerPhone}) ביקש לפנות למנהל.\nאנא צור/צרי איתו קשר. (אם יפרט מה קרה, אשלח לך את הפירוט בהודעה נפרדת.)`
      );
      await sendTextMessage(
        creds,
        customerPhone,
        'מצטערים לשמוע 😔 מנהל המסעדה יצור איתך קשר בקרוב.\nבינתיים, נשמח אם תספר לנו מה קרה כדי שנוכל להשתפר:'
      );
      await updateFeedback(feedback.id, { conversationState: 'waiting_reason', result: 'manager' });
    } else if (POSITIVE_PATTERNS.test(payload)) {
      await sendTextMessage(
        creds,
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
      await sendReplyButtons(creds, customerPhone, `איך הייתה החוויה שלך מ${org.name}?`, [
        { id: 'FEEDBACK_POSITIVE', title: 'הייתה מעולה! 😊' },
        { id: 'FEEDBACK_MANAGER', title: 'אשמח לדבר עם מנהל' },
      ]);
    }
    return;
  }

  if (feedback.conversationState === 'waiting_reason') {
    const customerName = feedback.customerName || `+${customerPhone}`;
    // Follow-up: the manager was already notified on the button press; now
    // forward the details the customer chose to add.
    await sendTextMessage(
      creds,
      org.managerPhone,
      `⚠️ [${org.name}] פירוט מהלקוח ${customerName} (+${customerPhone}):\n\n"${payload}"\n\nנדרש טיפול אנושי — צור קשר עם הלקוח.`
    );
    await sendTextMessage(
      creds,
      customerPhone,
      `תודה על הפירוט 🙏 מנהל ${org.name} יצור איתך קשר בקרוב לטיפול בנושא.`
    );
    await updateFeedback(feedback.id, {
      status: 'completed',
      conversationState: 'resolved',
      complaint: payload,
    });
  }
}
