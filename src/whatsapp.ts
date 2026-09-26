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

/**
 * How the restaurant introduces itself in the opening message: its name plus
 * its own emoji, as one template parameter.
 */
export function restaurantLabel(org: Org): string {
  return [org.name, org.greetingEmoji?.trim()].filter(Boolean).join(' ');
}

/**
 * Every phone that should hear about a negative review or receive the
 * periodic report: the required primary manager plus any additional ones
 * added for partnerships/co-owners. Deduplicated, since the same number
 * typed into both the primary field and the extra list would otherwise
 * receive everything twice.
 */
export function managerPhones(org: Org): string[] {
  const all = [org.managerPhone, ...(org.managers ?? []).map((m) => m.phone)];
  return [...new Set(all.filter(Boolean))];
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
 * The template used before the star-rating flow. Kept only as a bridge: it
 * takes two parameters (customer name in the header, manager name in the body)
 * where `order_rating` takes one, so an org still pointing at it would fail
 * outright if handed the new shape. Delete this once every org has moved.
 */
const LEGACY_TEMPLATE_NAME = 'restaurant_ranking';

export interface TemplateParams {
  /** `order_rating`: the restaurant's name and emoji as one value. */
  restaurantLabel: string;
  /** Legacy template only. */
  customerName: string;
  /** Legacy template only. */
  managerName: string;
}

/**
 * Sends the opening rating request (business-initiated, so it must be an
 * approved template and works outside the 24h window).
 *
 * The approved `order_rating` template carries one body parameter — the
 * restaurant's name together with its emoji, combined into a single value.
 * They are deliberately not two parameters: Meta rejects adjacent variables,
 * and rejects empty parameter values, which a restaurant without an emoji
 * would produce.
 *
 * Returns the wamid so button replies can be routed back to the exact
 * feedback row via context.id.
 */
export async function sendFeedbackTemplate(
  creds: WhatsAppCredentials,
  to: string,
  templateName: string,
  params: TemplateParams
): Promise<string | null> {
  const components =
    templateName === LEGACY_TEMPLATE_NAME
      ? [
          { type: 'header', parameters: [{ type: 'text', text: params.customerName }] },
          { type: 'body', parameters: [{ type: 'text', text: params.managerName }] },
        ]
      : [{ type: 'body', parameters: [{ type: 'text', text: params.restaurantLabel }] }];

  const { data } = await axios.post(
    messagesUrl(creds.phoneNumberId),
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: templateName, language: { code: 'he' }, components },
    },
    { headers: authHeaders(creds.token) }
  );
  return data?.messages?.[0]?.id ?? null;
}

/**
 * Sends an interactive list (session message — only valid within the 24h
 * window opened by a customer message).
 *
 * Used wherever more than three options are offered: reply buttons are capped
 * at three by WhatsApp, and both the five ratings and the five reasons exceed
 * that. Unlike template buttons, list rows may contain emoji.
 */
export async function sendListMessage(
  creds: WhatsAppCredentials,
  to: string,
  bodyText: string,
  buttonLabel: string,
  rows: { id: string; title: string }[]
): Promise<string | null> {
  const { data } = await axios.post(
    messagesUrl(creds.phoneNumberId),
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: { button: buttonLabel, sections: [{ rows }] },
      },
    },
    { headers: authHeaders(creds.token) }
  );
  return data?.messages?.[0]?.id ?? null;
}

/**
 * Uploads a file to WhatsApp and returns its media id.
 *
 * Reports go out as uploaded media rather than a public link: they list
 * customers by name, phone and complaint, and a link would put that behind
 * nothing but a hard-to-guess URL.
 */
export async function uploadMedia(
  creds: WhatsAppCredentials,
  file: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([new Uint8Array(file)], { type: mimeType }), filename);

  const { data } = await axios.post(`${config.graphApiBaseUrl}/${creds.phoneNumberId}/media`, form, {
    headers: { Authorization: `Bearer ${creds.token}` },
  });
  return data.id;
}

/** Sends an already-uploaded document. Session message: needs an open 24h window. */
export async function sendDocument(
  creds: WhatsAppCredentials,
  to: string,
  mediaId: string,
  filename: string,
  caption: string
): Promise<string | null> {
  const { data } = await axios.post(
    messagesUrl(creds.phoneNumberId),
    {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { id: mediaId, filename, caption },
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
