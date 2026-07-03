import axios from 'axios';
import { config } from './config';
import { Org, WhatsAppCredentials } from './types';

/**
 * Resolves which WhatsApp number/token to send on behalf of an org:
 * orgs with their own phone_number_id use it (plus their own token, only if
 * one is set — needed when that number lives under a separate Meta Business
 * Manager). A custom token is only ever applied together with a custom
 * phoneNumberId; a leftover token from a former dedicated setup must not
 * silently pair with the shared platform number after downgrading.
 */
export function credentialsFor(org: Org): WhatsAppCredentials {
  if (!org.whatsappPhoneNumberId) {
    return { token: config.whatsappToken, phoneNumberId: config.whatsappPhoneNumberId };
  }
  return {
    token: org.whatsappToken || config.whatsappToken,
    phoneNumberId: org.whatsappPhoneNumberId,
  };
}

const messagesUrl = (phoneNumberId: string) => `${config.graphApiBaseUrl}/${phoneNumberId}/messages`;

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/** Sends a plain text message. Returns the wamid of the sent message. */
export async function sendTextMessage(
  creds: WhatsAppCredentials,
  to: string,
  text: string
): Promise<string | null> {
  const { data } = await axios.post(
    messagesUrl(creds.phoneNumberId),
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text, preview_url: false },
    },
    { headers: authHeaders(creds.token) }
  );
  return data?.messages?.[0]?.id ?? null;
}

/**
 * Sends the feedback template (business-initiated, works outside the 24h window).
 * Verified param layout of the approved `restaurant_ranking` template:
 *   header {{1}} = CUSTOMER name  → greeting "<customer> היקר/ה"
 *   body   {{1}} = MANAGER name   → "מדבר <manager> מצוות שירות הלקוחות…"
 * Returns the wamid so button replies can be routed back to the exact
 * feedback row via context.id.
 */
export async function sendFeedbackTemplate(
  creds: WhatsAppCredentials,
  to: string,
  templateName: string,
  managerName: string,
  customerName: string
): Promise<string | null> {
  const { data } = await axios.post(
    messagesUrl(creds.phoneNumberId),
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'he' },
        components: [
          {
            type: 'header',
            parameters: [{ type: 'text', text: customerName }],
          },
          {
            type: 'body',
            parameters: [{ type: 'text', text: managerName }],
          },
        ],
      },
    },
    { headers: authHeaders(creds.token) }
  );
  return data?.messages?.[0]?.id ?? null;
}

/**
 * Sends interactive reply buttons (session message — only valid within the
 * 24h window opened by a customer message). Used to re-prompt customers who
 * answered with free text instead of pressing a button.
 */
export async function sendReplyButtons(
  creds: WhatsAppCredentials,
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[]
): Promise<string | null> {
  const { data } = await axios.post(
    messagesUrl(creds.phoneNumberId),
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    },
    { headers: authHeaders(creds.token) }
  );
  return data?.messages?.[0]?.id ?? null;
}

export async function downloadMedia(
  creds: WhatsAppCredentials,
  mediaId: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const { data: meta } = await axios.get(`${config.graphApiBaseUrl}/${mediaId}`, {
    headers: authHeaders(creds.token),
  });

  const response = await axios.get<ArrayBuffer>(meta.url, {
    headers: { Authorization: `Bearer ${creds.token}` },
    responseType: 'arraybuffer',
  });

  return {
    buffer: Buffer.from(response.data),
    mimeType: meta.mime_type ?? 'image/jpeg',
  };
}
