import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

export const config = {
  whatsappToken: required('WHATSAPP_TOKEN'),
  whatsappPhoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID'),
  webhookVerifyToken: required('WEBHOOK_VERIFY_TOKEN'),
  supabaseUrl: required('SUPABASE_URL'),
  supabaseKey: required('SUPABASE_KEY'),
  adminKey: required('ADMIN_KEY'),
  // Optional — OCR falls back to local Tesseract when missing
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  port: parseInt(process.env.PORT ?? '3000'),
  // Overridable so tests can point at a mock Graph API server
  graphApiBaseUrl: process.env.GRAPH_API_BASE_URL ?? 'https://graph.facebook.com/v19.0',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '20000'),
};
