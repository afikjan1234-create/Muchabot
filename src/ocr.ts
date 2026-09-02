import axios from 'axios';
import Tesseract from 'tesseract.js';
import { config } from './config';
import { ocrVariants, ImageVariant } from './image';

export interface ExtractedCustomer {
  phone: string | null;
  name: string | null;
  /**
   * 'low' means the details were read but not cleanly enough to act on
   * unattended — the owner is asked to confirm before anything is scheduled.
   */
  confidence: 'high' | 'low';
}

// ─── Phone normalization ───────────────────────────────────────────────────

export function normalizeIsraeliPhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('972')) return digits;
  if (digits.startsWith('0')) return '972' + digits.slice(1);
  return digits;
}

/**
 * A number that can actually receive the feedback message: an Israeli mobile.
 * Order screens are full of other numbers — the restaurant's own landline, an
 * order id, a total, a courier's extension — and a landline reaching this far
 * means we grabbed the wrong one, since WhatsApp cannot deliver to it.
 */
export function isMobileNumber(normalized: string): boolean {
  return /^9725\d{8}$/.test(normalized);
}

/**
 * Whether the feedback message could actually reach this number. Israeli
 * landlines are rejected outright; anything non-Israeli is left alone, since a
 * customer with a foreign number is rare but real and we cannot judge its shape.
 */
export function isReachableOnWhatsApp(normalized: string): boolean {
  if (normalized.startsWith('972')) return isMobileNumber(normalized);
  return normalized.length >= 9;
}

/**
 * Back to the local 05X-XXXXXXX form. Only ever for display: an owner asked to
 * proof-read a number spots a wrong digit in the shape they use every day,
 * not in a 972-prefixed run of twelve digits.
 */
export function formatIsraeliPhone(normalized: string): string {
  const match = normalized.match(/^972(\d{2})(\d{3})(\d{4})$/);
  if (!match) return `+${normalized}`;
  return `0${match[1]}-${match[2]}${match[3]}`;
}

/** Returns a normalized phone if the text looks like an Israeli phone number, else null. */
export function looksLikePhone(text: string): string | null {
  const digits = text.replace(/[\s\-\+\(\)\.]/g, '');
  if (!/^\d{9,12}$/.test(digits)) return null;
  return normalizeIsraeliPhone(digits);
}

// ─── Tesseract local OCR (phone only — eng traineddata can't read Hebrew) ──

// Ordered strongest-signal-first: a match on a full mobile pattern is worth
// trusting, while the bare digit-run patterns at the end are last-ditch and
// only ever produce a low-confidence result.
const STRICT_PHONE_PATTERNS = [
  /(97[24][\s\-]?5\d[\s\-]?\d{3}[\s\-]?\d{4})/, // +972-5x…
  /(05\d[\s\-]?\d{3}[\s\-]?\d{4})/, // 05X-XXXXXXX
];

const LOOSE_PHONE_PATTERNS = [
  /(97[24][\s\-]?[2-9]\d[\s\-]?\d{3}[\s\-]?\d{4})/, // +972 landline
  /(0[2-9][\s\-]?\d{3}[\s\-]?\d{4})/, // 0X-XXXXXXX
  /(\d{10})/,
  /(\d{9})/,
];

function matchPhone(text: string): { phone: string; strict: boolean } | null {
  for (const pattern of STRICT_PHONE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return { phone: normalizeIsraeliPhone(match[1]), strict: true };
  }
  for (const pattern of LOOSE_PHONE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return { phone: normalizeIsraeliPhone(match[1]), strict: false };
  }
  return null;
}

/**
 * Local fallback for when the vision model is unavailable (no key, quota
 * exhausted, outage). Reads digits only — `eng` traineddata cannot produce a
 * Hebrew name — so the owner is always asked for the name afterwards.
 */
async function extractPhoneWithTesseract(
  variants: ImageVariant[]
): Promise<{ phone: string; strict: boolean } | null> {
  let loose: { phone: string; strict: boolean } | null = null;

  for (const variant of variants) {
    try {
      const {
        data: { text },
      } = await Tesseract.recognize(variant.buffer, 'eng', { logger: () => {} });
      const match = matchPhone(text);
      if (match?.strict) {
        console.log(`[ocr] Tesseract (${variant.name}) read phone: ${match.phone}`);
        return match;
      }
      // Keep the first loose hit but let a later, cleaner variant beat it.
      if (match && !loose) loose = match;
    } catch (err) {
      console.error(`[ocr] Tesseract failed on ${variant.name}:`, err);
    }
  }

  if (loose) console.log(`[ocr] Tesseract read phone (unverified shape): ${loose.phone}`);
  return loose;
}

// ─── Gemini (reads both phone and Hebrew customer name) ────────────────────

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];

function geminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;
}

const GEMINI_PROMPT = `This image records a delivery/takeaway order from an Israeli restaurant system.
It may be a clean screenshot, or a photo of a screen taken at an angle in poor
light — blurry, glared, or low resolution. Read it as carefully as you can.

Extract two details about the CUSTOMER who placed the order:
1. phone — the customer's phone number
2. name  — the customer's name (usually written in Hebrew)

Rules:
- Israeli mobile numbers are 10 digits starting with 05 (e.g. 052-1234567), or
  the same number written internationally as +972 with the leading 0 dropped.
- The screen usually shows several numbers: the restaurant's own phone, an
  order number, a price, a courier's number, a street number. Return only the
  number belonging to the customer. If you cannot tell which one that is,
  return null rather than the most prominent number.
- Never guess a digit you cannot actually see. A single wrong digit sends this
  restaurant's message to an uninvolved stranger, which is far worse than
  returning null and being asked again.
- The name is the customer's, not the restaurant's, the courier's, or the
  delivery app's.
- Set "confident" to true only if every digit of the phone is clearly legible
  and you are sure the number and name belong to the customer.

Respond with ONLY a JSON object, no markdown fences:
{"phone": "<digits only, or null>", "name": "<customer name, or null>", "confident": true|false}`;

interface GeminiReading {
  phone: string | null;
  name: string | null;
  confident: boolean;
}

function parseGeminiReading(raw: string): GeminiReading | null {
  // Models occasionally wrap JSON in fences despite the instruction, and
  // occasionally add a sentence around it — pull out the object itself.
  const stripped = raw.replace(/```json|```/g, '').trim();
  const jsonText = stripped.slice(stripped.indexOf('{'), stripped.lastIndexOf('}') + 1);
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText);
    const phoneRaw = typeof parsed.phone === 'string' ? parsed.phone.trim() : '';
    const nameRaw = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    const phone =
      phoneRaw && phoneRaw.toLowerCase() !== 'null' ? normalizeIsraeliPhone(phoneRaw) : null;
    return {
      // A landline (or a mangled number) is not something we can message —
      // treat it as "not found" so the owner is asked instead.
      phone: phone && isReachableOnWhatsApp(phone) ? phone : null,
      name: nameRaw && nameRaw.toLowerCase() !== 'null' ? nameRaw : null,
      confident: parsed.confident === true,
    };
  } catch (err) {
    console.error('[gemini] Could not parse response as JSON:', raw.slice(0, 200));
    return null;
  }
}

/** One call. Returns null on transport/parse failure; `retryable` marks overload. */
async function callGemini(
  variant: ImageVariant,
  model: string
): Promise<{ reading: GeminiReading | null; retryable: boolean }> {
  try {
    const { data } = await axios.post(
      geminiUrl(model),
      {
        contents: [
          {
            parts: [
              { inlineData: { mimeType: variant.mimeType, data: variant.buffer.toString('base64') } },
              { text: GEMINI_PROMPT },
            ],
          },
        ],
      },
      { timeout: 25000 }
    );
    const raw: string | undefined = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return { reading: raw ? parseGeminiReading(raw) : null, retryable: false };
  } catch (err: any) {
    const status = err.response?.status;
    console.error(`[gemini] ${model} on ${variant.name} failed:`, status ?? err.message);
    return { reading: null, retryable: status === 503 || status === 429 };
  }
}

/**
 * Works through the image renditions until the customer's details come back
 * complete. A clean screenshot resolves on the first call; a bad photo gets
 * progressively more aggressive preprocessing, and partial reads are merged
 * across attempts so a phone from one pass can pair with a name from another.
 */
async function extractWithGemini(variants: ImageVariant[]): Promise<ExtractedCustomer | null> {
  const best: ExtractedCustomer = { phone: null, name: null, confidence: 'low' };

  // Cap the work: enough renditions to rescue a bad photo, few enough that a
  // hopeless image doesn't hold up the owner's reply or burn through quota.
  for (const variant of variants.slice(0, 3)) {
    let { reading, retryable } = await callGemini(variant, GEMINI_MODELS[0]);

    // The flash models are the ones that get overloaded; a sibling model is a
    // better use of the retry than hammering the same one.
    if (!reading && retryable) {
      ({ reading } = await callGemini(variant, GEMINI_MODELS[1]));
    }
    if (!reading) continue;

    if (reading.phone && !best.phone) {
      best.phone = reading.phone;
      best.confidence = reading.confident ? 'high' : 'low';
    }
    if (reading.name && !best.name) best.name = reading.name;

    if (best.phone && best.name && best.confidence === 'high') {
      console.log(`[ocr] Gemini read ${best.phone} / ${best.name} from ${variant.name}`);
      return best;
    }
  }

  if (best.phone) {
    console.log(
      `[ocr] Gemini best effort: ${best.phone} / ${best.name ?? '(no name)'} (${best.confidence})`
    );
    return best;
  }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Extracts customer phone + name from an order screenshot.
 * Gemini first (reads Hebrew names too); local Tesseract as fallback for the
 * phone when Gemini is unavailable or has no API key configured.
 */
export async function extractCustomerFromImage(
  imageBuffer: Buffer,
  mimeType: string
): Promise<ExtractedCustomer> {
  const variants = await ocrVariants(imageBuffer, mimeType);

  if (config.geminiApiKey) {
    const result = await extractWithGemini(variants);
    if (result?.phone) return result;
    console.log('[ocr] Gemini found nothing, falling back to Tesseract');
  } else {
    console.warn('[ocr] GEMINI_API_KEY is not set — running digits-only OCR, names cannot be read');
  }

  const match = await extractPhoneWithTesseract(variants);

  // A digit run that isn't a reachable number means the OCR latched onto an
  // order id or a price, or garbled the real number. Asking the owner to
  // proof-read something unusable wastes their time — ask them to type it.
  if (!match || !isReachableOnWhatsApp(match.phone)) {
    if (match) console.log(`[ocr] Discarded unreachable Tesseract read: ${match.phone}`);
    return { phone: null, name: null, confidence: 'low' };
  }

  // Tesseract never yields a name, and only a full mobile-shaped match is
  // solid enough to schedule against without the owner confirming it.
  return {
    phone: match.phone,
    name: null,
    confidence: match.strict && isMobileNumber(match.phone) ? 'high' : 'low',
  };
}
