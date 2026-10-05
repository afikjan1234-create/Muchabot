import { OutboundKind, recordOutbound } from './db';
import { Org } from './types';
import {
  credentialsFor,
  managerPhones,
  sendDocument,
  sendTemplateMessage,
  sendTextMessage,
} from './whatsapp';

/**
 * Everything the bot says to a restaurant's managers goes through here.
 *
 * Managers are not customers: they don't message the bot in order to receive
 * something, so a free-form text to them only lands if they happened to write
 * to it in the last 24 hours. A manager who didn't — most of them, on most
 * days — silently stopped receiving alerts and reports, and nothing on our
 * side recorded the failure. An approved template has no such window, so each
 * notice is sent as one. The plain-text version is kept only as a fallback
 * for while a template isn't usable (still in review, paused, or missing from
 * a dedicated number's own account).
 */
export interface ManagerNotice {
  kind: OutboundKind;
  template: string;
  params: string[];
  fallbackText: string;
  /** For reports: the PDF travels as the template's document header. */
  document?: { id: string; filename: string; caption: string };
  feedbackId?: number;
}

export interface NoticeFailure {
  phone: string;
  detail: string;
}

function describe(err: any): string {
  return JSON.stringify(err?.response?.data?.error ?? err?.message ?? err);
}

/**
 * Sends the notice to every manager phone, each in its own try/catch so one
 * recipient's failure never stops the rest. Returns the phones that could not
 * be reached by either route.
 */
export async function notifyManagers(
  org: Org,
  notice: ManagerNotice,
  recipients: string[] = managerPhones(org)
): Promise<NoticeFailure[]> {
  const creds = credentialsFor(org);
  const failures: NoticeFailure[] = [];

  for (const phone of recipients) {
    let wamid: string | null = null;
    let via: 'template' | 'text' = 'template';

    try {
      wamid = await sendTemplateMessage(creds, phone, notice.template, notice.params, notice.document);
    } catch (templateErr) {
      console.warn(
        `[notify] ${notice.template} to ${phone} failed (${describe(templateErr)}) — falling back to plain text`
      );
      via = 'text';
      try {
        wamid = notice.document
          ? await sendDocument(
              creds,
              phone,
              notice.document.id,
              notice.document.filename,
              notice.document.caption
            )
          : await sendTextMessage(creds, phone, notice.fallbackText);
      } catch (textErr) {
        failures.push({ phone, detail: describe(textErr) });
        continue;
      }
    }

    if (wamid) {
      await recordOutbound({
        wamid,
        orgId: org.id,
        toPhone: phone,
        kind: notice.kind,
        via,
        feedbackId: notice.feedbackId,
      });
    }
  }
  return failures;
}
