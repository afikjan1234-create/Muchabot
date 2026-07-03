import axios from 'axios';
import Tesseract from 'tesseract.js';
import { config } from './config';

export interface ExtractedCustomer {
  phone: string | null;
  name: string | null;
}

// ─── Phone normalization ───────────────────────────────────────────────────

export function normalizeIsraeliPhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('972')) return digits;
  if (digits.startsWith('0')) return '972' + digits.slice(1);
  return digits;
}

/** Returns a normalized phone if the text looks like an Israeli phone number, else null. */
export function looksLikePhone(text: string): string | null {
  const digits = text.replace(/[\s\-\+\(\)\.]/g, '');
  if (!/^\d{9,12}$/.test(digits)) return null;
  return normalizeIsraeliPhone(digits);
}

// ─── Tesseract local OCR (phone only — eng traineddata can't read Hebrew) ──

const PHONE_PATTERNS = [
  /(97[24][\s\-]?5\d[\s\-]?\d{3}[\s\-]?\d{4})/, // +972-5x…
  /(97[24][\s\-]?[2-9]\d[\s\-]?\d{3}[\s\-]?\d{4})/, // +972 landline
  /(05\d[\s\-]?\d{3}[\s\-]?\d{4})/, // 05X-XXXXXXX
  /(0[2-9][\s\-]?\d{3}[\s\-]?\d{4})/, // 0X-XXXXXXX
  /(\d{10})/,
  /(\d{9})/,
];

async function extractPhoneWithTesseract(buffer: Buffer): Promise<string | null> {
  try {
    const {
      data: { text },
    } = await Tesseract.recognize(buffer, 'eng', { logger: () => {} });
    for (const pattern of PHONE_PATTERNS) {
      const match = text.match(pattern);
      if (match) return normalizeIsraeliPhone(match[1]);
    }
    return null;
  } catch (err) {
    console.error('[ocr] Tesseract failed:', err);
    return null;
  }
}

// ─── Gemini (reads both phone and Hebrew customer name) ────────────────────

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];

function geminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;
}

const GEMINI_PROMPT = `This image is a screenshot from a restaurant's delivery/order system in Israel.
Extract the customer's phone number and the customer's name (the name may be in Hebrew).
Respond with ONLY a JSON object, no markdown fences:
{"phone": "<digits only, or null>", "name": "<customer name, or null>"}`;

async function extractWithGemini(
  imageBuffer: Buffer,
  mimeType: string
): Promise<ExtractedCustomer | null> {
  const parts = [
    { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
    { text: GEMINI_PROMPT },
  ];

  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { data } = await axios.post(
          geminiUrl(model),
          { contents: [{ parts }] },
          { timeout: 20000 }
        );
        const raw: string | undefined = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!raw) return null;
        const jsonText = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(jsonText);
        const phoneRaw = typeof parsed.phone === 'string' ? parsed.phone.trim() : '';
        const nameRaw = typeof parsed.name === 'string' ? parsed.name.trim() : '';
        return {
          phone: phoneRaw && phoneRaw.toLowerCase() !== 'null' ? normalizeIsraeliPhone(phoneRaw) : null,
          name: nameRaw && nameRaw.toLowerCase() !== 'null' ? nameRaw : null,
        };
      } catch (err: any) {
        const status = err.response?.status;
        console.error(`[gemini] ${model} attempt ${attempt} failed:`, status ?? err.message);
        if ((status === 503 || status === 429) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          break;
        }
      }
    }
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
  if (config.geminiApiKey) {
    const result = await extractWithGemini(imageBuffer, mimeType);
    if (result?.phone) {
      console.log('[ocr] Gemini extracted:', result.phone, result.name ?? '(no name)');
      return result;
    }
    console.log('[ocr] Gemini found nothing, falling back to Tesseract');
  }

  const phone = await extractPhoneWithTesseract(imageBuffer);
  if (phone) console.log('[ocr] Tesseract found phone:', phone);
  return { phone, name: null };
}
