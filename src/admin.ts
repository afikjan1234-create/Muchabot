import { Router, Request, Response, NextFunction } from 'express';
import { config } from './config';
import {
  cancelFeedback,
  createFeedback,
  createOrg,
  deleteOrg,
  getOrgById,
  getOrgStats,
  listFeedbacks,
  listOrgs,
  updateOrg,
} from './db';
import { looksLikePhone } from './ocr';
import { FeedbackStatus, OrgPhone } from './types';

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
    const org = await createOrg(
      {
        name: String(b.name),
        managerName: String(b.managerName ?? ''),
        managerPhone,
        woltRatingUrl: String(b.woltRatingUrl ?? ''),
        templateName: b.templateName ? String(b.templateName) : undefined,
        feedbackDelayMinutes:
          b.feedbackDelayMinutes !== undefined && b.feedbackDelayMinutes !== ''
            ? parseInt(b.feedbackDelayMinutes)
            : undefined,
      },
      parsePhones(b.phones)
    );
    res.json(org);
  })
);

adminRouter.put(
  '/orgs/:id',
  handle(async (req, res) => {
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
        templateName: b.templateName,
        feedbackDelayMinutes:
          b.feedbackDelayMinutes !== undefined ? parseInt(b.feedbackDelayMinutes) : undefined,
        isActive: typeof b.isActive === 'boolean' ? b.isActive : undefined,
      },
      b.phones !== undefined ? parsePhones(b.phones) : undefined
    );
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
    const phone = looksLikePhone(String(b.customerPhone ?? ''));
    if (!phone) throw new Error(`מספר לקוח לא תקין: ${b.customerPhone}`);
    const delayMinutes =
      b.delayMinutes !== undefined && b.delayMinutes !== ''
        ? parseInt(b.delayMinutes)
        : org.feedbackDelayMinutes;
    const scheduledAt = new Date(Date.now() + delayMinutes * 60_000);
    const feedback = await createFeedback(org.id, phone, String(b.customerName ?? ''), scheduledAt);
    res.json(feedback);
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
