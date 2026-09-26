import {
  createFeedback,
  getActiveFeedbackByPhone,
  getFeedbackByWamid,
  updateFeedback,
} from './db';
import {
  sendTextMessage,
  sendListMessage,
  downloadMedia,
  credentialsFor,
  restaurantLabel,
} from './whatsapp';
import {
  extractCustomerFromImage,
  formatIsraeliPhone,
  isReachableOnWhatsApp,
  looksLikePhone,
} from './ocr';
import {
  LEGACY_MANAGER_BUTTON,
  NEGATIVE_RATING_MAX,
  RATING_OPTIONS,
  REASON_OPTIONS,
  parseRating,
  parseReason,
  ratingRowId,
  reasonRowTitle,
} from './rating';
import { Feedback, Org, WhatsAppCredentials } from './types';

/** Details read off the order screenshot and carried until the row is created. */
interface OrderDetails {
  orderNumber: string | null;
  orderAmount: string | null;
}

// ─── Owner (restaurant) flow ────────────────────────────────────────────────
// Ephemeral per-owner conversation state; keyed by the owner's phone so
// multiple restaurants can talk to the bot at the same time.

type PendingOwnerState = (
  | { state: 'waiting_for_name'; customerPhone: string; order: OrderDetails }
  | { state: 'waiting_for_phone' }
  | {
      state: 'confirming_phone';
      customerPhone: string;
      customerName: string | null;
      order: OrderDetails;
    }
) & { setAt: number };

const pendingOwnerStates = new Map<string, PendingOwnerState>();

// A stale "what's the customer's name?" prompt must not swallow unrelated
// owner texts sent hours later (that's how a complaint once became a
// customer name). Expire pending prompts after 15 minutes.
const PENDING_TTL_MS = 15 * 60_000;

const NO_ORDER: OrderDetails = { orderNumber: null, orderAmount: null };

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

async function scheduleAndConfirm(
  org: Org,
  customerPhone: string,
  customerName: string,
  order: OrderDetails
): Promise<string> {
  const scheduledAt = new Date(Date.now() + org.feedbackDelayMinutes * 60_000);
  await createFeedback(org.id, customerPhone, customerName, scheduledAt, order);
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
  const order: OrderDetails = {
    orderNumber: extracted.orderNumber,
    orderAmount: extracted.orderAmount,
  };

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
      order,
      setAt: Date.now(),
    });
    const nameLine = customerName ? `\nשם: ${customerName}` : '';
    return `🔍 התמונה לא הייתה חדה, אז כדאי לוודא.\nמספר: ${formatIsraeliPhone(extracted.phone)}${nameLine}\n\nהאם זה נכון? השב "כן" לאישור, או שלח את המספר הנכון.`;
  }

  if (customerName) {
    return scheduleAndConfirm(org, extracted.phone, customerName, order);
  }

  pendingOwnerStates.set(ownerPhone, {
    state: 'waiting_for_name',
    customerPhone: extracted.phone,
    order,
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
  name: string | null,
  order: OrderDetails
): Promise<string> {
  if (name) {
    pendingOwnerStates.delete(ownerPhone);
    return scheduleAndConfirm(org, phone, name, order);
  }
  pendingOwnerStates.set(ownerPhone, {
    state: 'waiting_for_name',
    customerPhone: phone,
    order,
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
      return acceptPhone(
        org,
        ownerPhone,
        pending.customerPhone,
        pending.customerName,
        pending.order
      );
    }
    const corrected = looksLikePhone(trimmed);
    if (corrected) {
      if (!isReachableOnWhatsApp(corrected)) return UNREACHABLE_REPLY;
      return acceptPhone(org, ownerPhone, corrected, pending.customerName, pending.order);
    }
    return `לא הבנתי. אם ${formatIsraeliPhone(pending.customerPhone)} נכון — השב "כן".\nאחרת שלח את המספר הנכון, או "ביטול".`;
  }

  if (!pending || pending.state === 'waiting_for_phone') {
    const phone = looksLikePhone(trimmed);
    if (phone) {
      if (!isReachableOnWhatsApp(phone)) return UNREACHABLE_REPLY;
      return acceptPhone(org, ownerPhone, phone, null, NO_ORDER);
    }
    if (pending?.state === 'waiting_for_phone') {
      return 'לא זיהיתי מספר טלפון תקין. שלח את המספר בפורמט: 0501234567 (או "ביטול")';
    }
    return `שלום! כאן בוט הפידבק של ${org.name} 🤖\nשלח תמונה של פרטי ההזמנה (טלפון + שם לקוח), או הקלד מספר טלפון ישירות.`;
  }

  // waiting_for_name
  const customerName = trimmed;
  const { customerPhone, order } = pending;
  pendingOwnerStates.delete(ownerPhone);
  return scheduleAndConfirm(org, customerPhone, customerName, order);
}

// ─── Customer flow ──────────────────────────────────────────────────────────

const MISSING = '—';

/**
 * The alert a manager gets for any rating of 3 or below. Sent the moment the
 * customer picks a reason rather than waiting for them to type an explanation,
 * because most press the button and stop there — waiting would mean the
 * manager never hears about the complaint at all.
 */
function managerAlert(
  org: Org,
  feedback: Feedback,
  rating: number | null,
  reason: string | null
): string {
  return [
    `🔴 משוב שלילי — ${org.name}`,
    '',
    `שם לקוח: ${feedback.customerName || MISSING}`,
    `טלפון: ${formatIsraeliPhone(feedback.customerPhone)}`,
    `מספר הזמנה: ${feedback.orderNumber || MISSING}`,
    `סכום הזמנה: ${feedback.orderAmount || MISSING}`,
    `דירוג: ${rating ? `${rating}/5` : MISSING}`,
    `סיבת הבעיה: ${reason || MISSING}`,
    '',
    'נדרש טיפול אנושי — צור קשר עם הלקוח.',
  ].join('\n');
}

/**
 * Every list message sent mid-conversation must re-anchor `wa_message_id` to
 * itself. WhatsApp echoes back whichever message the customer's reply is
 * threaded to as `context.id` — if that id isn't the one on file, the lookup
 * misses and falls back to "most recent active row for this phone", which is
 * exactly how an unrelated stale conversation can get mistaken for this one.
 */
async function askForReason(
  org: Org,
  creds: WhatsAppCredentials,
  to: string,
  feedbackId: number
): Promise<void> {
  const wamid = await sendListMessage(
    creds,
    to,
    'מצטערים לשמוע 🙏\nנשמח להבין מה היה פחות טוב כדי שנוכל להשתפר:',
    'בחירת סיבה',
    REASON_OPTIONS.map((o) => ({ id: o.id, title: reasonRowTitle(o, org.greetingEmoji) }))
  );
  // One write, not two: the list is already visible to the customer the
  // instant this call returns, so a reply can arrive before a second,
  // separate "now set conversationState" write would have landed — a real
  // race that briefly left the row looking like it was still on the
  // previous step. Bundling the wamid and the state into a single update
  // closes that window instead of widening it.
  await updateFeedback(feedbackId, {
    conversationState: 'waiting_reason',
    ...(wamid ? { waMessageId: wamid } : {}),
  });
}

async function askForRating(
  org: Org,
  creds: WhatsAppCredentials,
  to: string,
  feedbackId: number
): Promise<void> {
  const wamid = await sendListMessage(
    creds,
    to,
    `היי 👋 כאן ${restaurantLabel(org)}\nנשמח לדעת איך הייתה ההזמנה שלך היום ❤️\nאיך היית מדרג את ההזמנה?`,
    'בחירת דירוג',
    RATING_OPTIONS.map((o) => ({ id: ratingRowId(o.rating), title: o.label }))
  );
  if (wamid) await updateFeedback(feedbackId, { waMessageId: wamid });
}

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
    // Routing fell through to the "most recent active row for this phone"
    // guess rather than an exact reply-thread match — worth a log line, since
    // a stale row surfacing here again is exactly how the last mix-up looked.
    if (feedback) {
      console.log(
        `[handler] ${customerPhone}: contextWamid did not resolve, falling back to #${feedback.id} (state=${feedback.conversationState})`
      );
    }
  }
  if (!feedback?.org || !feedback.conversationState) {
    console.log(`[handler] Ignoring message from ${customerPhone} — no active feedback`);
    return;
  }
  const org = feedback.org;
  const creds = credentialsFor(org);

  // ── Step 1: the 1-5 rating ──
  if (feedback.conversationState === 'waiting_feedback') {
    const rating = parseRating(payload);

    // Legacy template only: "I'd like to speak to a manager" is a request
    // rather than a score, so it goes to the reason list with no rating set.
    if (rating === null && payload.includes(LEGACY_MANAGER_BUTTON)) {
      await updateFeedback(feedback.id, { result: 'manager' });
      await askForReason(org, creds, customerPhone, feedback.id);
      return;
    }

    if (rating === null) {
      // Anything that isn't one of the five answers — offer them again. This
      // has to be a list: WhatsApp caps interactive reply buttons at three.
      await askForRating(org, creds, customerPhone, feedback.id);
      return;
    }

    await updateFeedback(feedback.id, {
      rating,
      result: rating > NEGATIVE_RATING_MAX ? 'positive' : 'manager',
    });

    if (rating === 5) {
      await sendTextMessage(
        creds,
        customerPhone,
        `תודה רבה! 🙏 שמחים שנהנית מ${org.name}!\n\nנשמח אם תדרג אותנו בוולט ⭐⭐⭐⭐⭐:\n${org.woltRatingUrl}`
      );
      await updateFeedback(feedback.id, { status: 'completed', conversationState: 'resolved' });
      return;
    }

    if (rating === 4) {
      // Good but not perfect: worth learning from, not worth alerting anyone.
      await sendTextMessage(creds, customerPhone, 'מה לדעתך יכול היה להפוך את ההזמנה למושלמת? 😊');
      await updateFeedback(feedback.id, { conversationState: 'waiting_note' });
      return;
    }

    await askForReason(org, creds, customerPhone, feedback.id);
    return;
  }

  // ── Step 2 (ratings 1-3): which aspect went wrong ──
  if (feedback.conversationState === 'waiting_reason') {
    const rating = feedback.rating;
    const reason = parseReason(payload);
    const reasonLabel = reason ? reason.title : null;

    await updateFeedback(feedback.id, {
      conversationState: 'waiting_note',
      ...(reasonLabel ? { reason: reasonLabel } : {}),
    });
    console.log(
      `[handler] #${feedback.id} (${customerPhone}) reason picked -> alerting manager ${org.managerPhone}`
    );
    await sendTextMessage(creds, org.managerPhone, managerAlert(org, feedback, rating, reasonLabel));

    if (reason) {
      await sendTextMessage(creds, customerPhone, 'אם תרצה, ספר לנו בקצרה מה קרה.');
      return;
    }

    // Someone who types instead of picking has already said what went wrong —
    // take it as the explanation rather than asking the same question again.
    await sendTextMessage(creds, org.managerPhone, `📝 [${org.name}] הלקוח הוסיף:\n\n"${payload}"`);
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
    return;
  }

  // ── Step 3: the optional free-text note ──
  if (feedback.conversationState === 'waiting_note') {
    const negative = (feedback.rating ?? 0) <= NEGATIVE_RATING_MAX;
    await updateFeedback(feedback.id, {
      status: 'completed',
      conversationState: 'resolved',
      complaint: payload,
    });

    if (negative) {
      // The manager already has the alert; this is the detail they were told
      // might follow.
      await sendTextMessage(
        creds,
        org.managerPhone,
        `📝 [${org.name}] הערה מהלקוח ${feedback.customerName || MISSING} (${formatIsraeliPhone(feedback.customerPhone)}):\n\n"${payload}"`
      );
      await sendTextMessage(
        creds,
        customerPhone,
        `תודה על הפירוט 🙏 מנהל ${org.name} יצור איתך קשר בקרוב לטיפול בנושא.`
      );
      return;
    }

    // Rating 4: kept for the restaurant to learn from, no alert by design.
    await sendTextMessage(
      creds,
      customerPhone,
      'תודה רבה על המשוב! 🙏 נעביר אותו לצוות — בזכות הערות כאלה אנחנו משתפרים.'
    );
  }
}
