import { Router, Request, Response, NextFunction } from 'express';
import { config } from './config';
import {
  cancelFeedback,
  createFeedback,
  createOrg,
  deleteOrg,
  getOrgById,
  getOrgStats,
  hasRecentFeedback,
  listFeedbacks,
  listOrgs,
  listOutbound,
  updateOrg,
} from './db';
import { formatIsraeliPhone, looksLikePhone } from './ocr';
import { FeedbackStatus, Org, OrgManager, OrgPhone, OrgPlan } from './types';
import { businessDayFor, localNow, sendReport } from './report-scheduler';
import { ReportPeriod } from './report';
import { managerPhones, templateParam } from './whatsapp';
import { notifyManagers } from './notify';

function parsePlan(raw: unknown): OrgPlan | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'shared' && raw !== 'dedicated') throw new Error(`סוג חיבור לא תקין: ${raw}`);
  return raw;
}

/**
 * Describes what changed between two versions of an org, active status
 * first since that's the one that actually stops the bot from working.
 * whatsappToken is deliberately never included here — it's a secret.
 */
function describeOrgChanges(before: Org, after: Org): string[] {
  const lines: string[] = [];
  if (before.isActive !== after.isActive) {
    lines.push(
      after.isActive
        ? '✅ הבוט הופעל מחדש — חוזר לעבוד כרגיל.'
        : '⛔ הבוט הושבת — לא ניתן להשתמש בו עד שיופעל מחדש דרך דף הניהול.'
    );
  }
  if (before.name !== after.name) lines.push(`שם המסעדה שונה: "${before.name}" ← "${after.name}"`);
  if (before.managerName !== after.managerName) {
    lines.push(`שם המנהל שונה: "${before.managerName || '—'}" ← "${after.managerName || '—'}"`);
  }
  if (before.managerPhone !== after.managerPhone) {
    lines.push(
      `טלפון המנהל הראשי שונה: ${formatIsraeliPhone(before.managerPhone)} ← ${formatIsraeliPhone(after.managerPhone)}`
    );
  }
  if (before.woltRatingUrl !== after.woltRatingUrl) lines.push('קישור דירוג וולט עודכן.');
  if (before.greetingEmoji !== after.greetingEmoji) {
    lines.push(`אימוג'י המסעדה שונה ל-${after.greetingEmoji || '(ללא)'}`);
  }
  if (before.closingTime !== after.closingTime) {
    lines.push(`שעת סגירה שונתה: ${before.closingTime} ← ${after.closingTime}`);
  }
  if (before.feedbackDelayMinutes !== after.feedbackDelayMinutes) {
    lines.push(`השהיית שליחת פידבק שונתה: ${before.feedbackDelayMinutes} ← ${after.feedbackDelayMinutes} דק'`);
  }
  if (before.templateName !== after.templateName) {
    lines.push(`תבנית WhatsApp שונתה: ${before.templateName} ← ${after.templateName}`);
  }
  if (before.plan !== after.plan) {
    const label = (p: string) => (p === 'dedicated' ? 'ייעודי' : 'משותף');
    lines.push(`סוג החיבור שונה: ${label(before.plan)} ← ${label(after.plan)}`);
  }
  if (before.whatsappPhoneNumberId !== after.whatsappPhoneNumberId) {
    lines.push('מספר ה-WhatsApp הייעודי עודכן.');
  }

  const phoneSet = (list?: { phone: string }[]) =>
    [...(list ?? [])].map((p) => p.phone).sort().join(',');
  if (phoneSet(before.phones) !== phoneSet(after.phones)) {
    lines.push('רשימת הטלפונים המורשים לשליחת לקוחות עודכנה.');
  }
  if (phoneSet(before.managers) !== phoneSet(after.managers)) {
    lines.push('רשימת המנהלים הנוספים עודכנה.');
  }
  return lines;
}

/**
 * Best-effort notice to whoever could receive an alert either before or
 * after this edit — so a manager who was just removed still hears that they
 * no longer will, and one newly added hears about the change that added
 * them. Sent as an approved template, so it reaches managers regardless of
 * whether they've written to the bot recently.
 */
async function notifyOrgChanged(before: Org, after: Org): Promise<void> {
  const changes = describeOrgChanges(before, after);
  if (changes.length === 0) return;
  const recipients = [...new Set([...managerPhones(before), ...managerPhones(after)])];
  try {
    await notifyManagers(
      after,
      {
        kind: 'settings_update',
        template: 'manager_settings_update',
        params: [templateParam(after.name), templateParam(changes.join(' | '))],
        fallbackText: `⚙️ [${after.name}] עודכנו הגדרות הבוט:\n\n${changes.map((c) => `• ${c}`).join('\n')}`,
      },
      recipients
    );
  } catch (err) {
    console.error('[admin] Settings-change notice failed:', err instanceof Error ? err.message : err);
  }
}

export const adminRouter = Router();

// ─── Auth ───────────────────────────────────────────────────────────────────

function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.header('x-admin-key');
  if (key !== config.adminKey) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

adminRouter.use(requireAdminKey);

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      console.error('[admin]', err);
      res.status(500).json({ error: err?.message ?? 'internal error' });
    });
  };
}

// ─── Orgs ───────────────────────────────────────────────────────────────────

function parsePhones(raw: unknown): OrgPhone[] {
  if (!Array.isArray(raw)) return [];
  const phones: OrgPhone[] = [];
  for (const item of raw) {
    const normalized = looksLikePhone(String(item?.phone ?? ''));
    if (!normalized) throw new Error(`מספר טלפון לא תקין: ${item?.phone}`);
    phones.push({ phone: normalized, label: String(item?.label ?? '') });
  }
  return phones;
}

function parseManagers(raw: unknown): OrgManager[] {
  if (!Array.isArray(raw)) return [];
  const managers: OrgManager[] = [];
  for (const item of raw) {
    const normalized = looksLikePhone(String(item?.phone ?? ''));
    if (!normalized) throw new Error(`מספר טלפון מנהל לא תקין: ${item?.phone}`);
    managers.push({ phone: normalized, name: String(item?.name ?? '') });
  }
  return managers;
}

adminRouter.get(
  '/orgs',
  handle(async (_req, res) => {
    res.json(await listOrgs());
  })
);

adminRouter.post(
  '/orgs',
  handle(async (req, res) => {
    const b = req.body;
    if (!b?.name || !b?.managerPhone) throw new Error('חסר שם מסעדה או טלפון מנהל');
    const managerPhone = looksLikePhone(String(b.managerPhone));
    if (!managerPhone) throw new Error(`טלפון מנהל לא תקין: ${b.managerPhone}`);
    if (b.plan === 'dedicated' && !String(b.whatsappPhoneNumberId ?? '').trim()) {
      throw new Error('חיבור ייעודי דורש Phone Number ID');
    }
    const org = await createOrg(
      {
        name: String(b.name),
        managerName: String(b.managerName ?? ''),
        managerPhone,
        woltRatingUrl: String(b.woltRatingUrl ?? ''),
        greetingEmoji: String(b.greetingEmoji ?? '').trim(),
        closingTime: b.closingTime ? String(b.closingTime).trim() : undefined,
        templateName: b.templateName ? String(b.templateName) : undefined,
        feedbackDelayMinutes:
          b.feedbackDelayMinutes !== undefined && b.feedbackDelayMinutes !== ''
            ? parseInt(b.feedbackDelayMinutes)
            : undefined,
        plan: parsePlan(b.plan),
        whatsappPhoneNumberId: b.whatsappPhoneNumberId ? String(b.whatsappPhoneNumberId).trim() : null,
        whatsappToken: b.whatsappToken ? String(b.whatsappToken).trim() : null,
      },
      parsePhones(b.phones),
      parseManagers(b.managers)
    );

    // Best-effort welcome, as a template so it reaches managers who have
    // never written to this number.
    try {
      await notifyManagers(org, {
        kind: 'welcome',
        template: 'manager_welcome',
        params: [templateParam(org.name)],
        fallbackText: `🎉 הבוט הוגדר בהצלחה עבור ${org.name}!\nמעכשיו תקבל/י כאן התראות על ביקורות שליליות ודוחות תקופתיים.`,
      });
    } catch (err) {
      console.error('[admin] Welcome notice failed:', err instanceof Error ? err.message : err);
    }

    res.json(org);
  })
);

/**
 * Sends a report now, regardless of closing time or whether today's already
 * went out — the dashboard's "send me this" button, and how the E2E suite
 * exercises delivery without waiting for a clock.
 */
adminRouter.post(
  '/orgs/:id/report',
  handle(async (req, res) => {
    const org = await getOrgById(req.params.id);
    if (!org) throw new Error('מסעדה לא נמצאה');

    const period = (req.body?.period ?? 'daily') as ReportPeriod;
    if (!['daily', 'weekly', 'monthly'].includes(period)) {
      throw new Error(`תקופה לא תקינה: ${period}`);
    }
    // Same day the automatic run would cover, so a manual send and the
    // scheduled one agree for a restaurant that closes after midnight.
    const day = businessDayFor(localNow(), org.closingTime);
    const to = String(req.body?.to ?? day);
    const from = String(req.body?.from ?? to);

    const result = await sendReport(org, period, from, to, { force: true });
    res.json({ result, period, from, to });
  })
);

adminRouter.put(
  '/orgs/:id',
  handle(async (req, res) => {
    const before = await getOrgById(req.params.id);
    if (!before) throw new Error('מסעדה לא נמצאה');

    const b = req.body;
    const managerPhone =
      b.managerPhone !== undefined ? looksLikePhone(String(b.managerPhone)) : undefined;
    if (b.managerPhone !== undefined && !managerPhone) {
      throw new Error(`טלפון מנהל לא תקין: ${b.managerPhone}`);
    }
    const org = await updateOrg(
      req.params.id,
      {
        name: b.name,
        managerName: b.managerName,
        managerPhone: managerPhone ?? undefined,
        woltRatingUrl: b.woltRatingUrl,
        greetingEmoji:
          b.greetingEmoji !== undefined ? String(b.greetingEmoji).trim() : undefined,
        closingTime: b.closingTime !== undefined ? String(b.closingTime).trim() : undefined,
        templateName: b.templateName,
        feedbackDelayMinutes:
          b.feedbackDelayMinutes !== undefined ? parseInt(b.feedbackDelayMinutes) : undefined,
        isActive: typeof b.isActive === 'boolean' ? b.isActive : undefined,
        plan: parsePlan(b.plan),
        whatsappPhoneNumberId:
          b.whatsappPhoneNumberId !== undefined
            ? String(b.whatsappPhoneNumberId).trim() || null
            : undefined,
        whatsappToken:
          b.whatsappToken !== undefined ? String(b.whatsappToken).trim() || null : undefined,
      },
      b.phones !== undefined ? parsePhones(b.phones) : undefined,
      b.managers !== undefined ? parseManagers(b.managers) : undefined
    );
    await notifyOrgChanged(before, org);
    res.json(org);
  })
);

adminRouter.delete(
  '/orgs/:id',
  handle(async (req, res) => {
    await deleteOrg(req.params.id);
    res.json({ ok: true });
  })
);

// ─── Feedbacks ──────────────────────────────────────────────────────────────

adminRouter.get(
  '/feedbacks',
  handle(async (req, res) => {
    const feedbacks = await listFeedbacks({
      orgId: req.query.orgId ? String(req.query.orgId) : undefined,
      status: req.query.status ? (String(req.query.status) as FeedbackStatus) : undefined,
      limit: req.query.limit ? parseInt(String(req.query.limit)) : 200,
    });
    res.json(feedbacks);
  })
);

adminRouter.post(
  '/feedbacks',
  handle(async (req, res) => {
    const b = req.body;
    const org = await getOrgById(String(b?.orgId ?? ''));
    if (!org) throw new Error('מסעדה לא נמצאה');
    if (!org.isActive) throw new Error('המסעדה מושבתת — הפעל אותה מחדש לפני שליחת פידבק');
    const phone = looksLikePhone(String(b.customerPhone ?? ''));
    if (!phone) throw new Error(`מספר לקוח לא תקין: ${b.customerPhone}`);
    if (await hasRecentFeedback(org.id, phone)) {
      throw new Error('ללקוח הזה כבר נשלחה הודעת פידבק ב-12 השעות האחרונות');
    }
    const delayMinutes =
      b.delayMinutes !== undefined && b.delayMinutes !== ''
        ? parseInt(b.delayMinutes)
        : org.feedbackDelayMinutes;
    const scheduledAt = new Date(Date.now() + delayMinutes * 60_000);
    const feedback = await createFeedback(org.id, phone, String(b.customerName ?? ''), scheduledAt);
    res.json(feedback);
  })
);

/** Recent notices sent to managers, with whether each actually arrived. */
adminRouter.get(
  '/notifications',
  handle(async (req, res) => {
    res.json(
      await listOutbound({
        orgId: req.query.orgId ? String(req.query.orgId) : undefined,
        limit: req.query.limit ? parseInt(String(req.query.limit)) : 100,
      })
    );
  })
);

adminRouter.post(
  '/feedbacks/:id/cancel',
  handle(async (req, res) => {
    const ok = await cancelFeedback(parseInt(req.params.id));
    if (!ok) throw new Error('אפשר לבטל רק משוב שעדיין לא נשלח');
    res.json({ ok: true });
  })
);

// ─── Stats ──────────────────────────────────────────────────────────────────

adminRouter.get(
  '/stats',
  handle(async (_req, res) => {
    res.json(await getOrgStats());
  })
);
