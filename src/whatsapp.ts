import axios from 'axios';
import { config } from './config';

const messagesUrl = () => `${config.graphApiBaseUrl}/${config.whatsappPhoneNumberId}/messages`;

function authHeaders() {
  return {
    Authorization: `Bearer ${config.whatsappToken}`,
    'Content-Type': 'application/json',
  };
}

/** Sends a plain text message. Returns the wamid of the sent message. */
export async function sendTextMessage(to: string, text: string): Promise<string | null> {
  const { data } = await axios.post(
    messagesUrl(),
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text, preview_url: false },
    },
    { headers: authHeaders() }
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
  to: string,
  templateName: string,
  managerName: string,
  customerName: string
): Promise<string | null> {
  const { data } = await axios.post(
    messagesUrl(),
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
    { headers: authHeaders() }
  );
  return data?.messages?.[0]?.id ?? null;
}

/**
 * Sends interactive reply buttons (session message — only valid within the
 * 24h window opened by a customer message). Used to re-prompt customers who
 * answered with free text instead of pressing a button.
 */
export async function sendReplyButtons(
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[]
): Promise<string | null> {
  const { data } = await axios.post(
    messagesUrl(),
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
    { headers: authHeaders() }
  );
  return data?.messages?.[0]?.id ?? null;
}

export async function downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const { data: meta } = await axios.get(`${config.graphApiBaseUrl}/${mediaId}`, {
    headers: authHeaders(),
  });

  const response = await axios.get<ArrayBuffer>(meta.url, {
    headers: { Authorization: `Bearer ${config.whatsappToken}` },
    responseType: 'arraybuffer',
  });

  return {
    buffer: Buffer.from(response.data),
    mimeType: meta.mime_type ?? 'image/jpeg',
  };
}
