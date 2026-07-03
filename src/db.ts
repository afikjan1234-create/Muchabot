import { createClient } from '@supabase/supabase-js';
import { config } from './config';
import { Feedback, FeedbackStatus, Org, OrgPhone, OrgPlan } from './types';

// Windows/undici occasionally drops connections to Supabase ("fetch failed").
// Retry only network-level failures (connection never established) — HTTP
// error responses are returned normally and never retried.
const fetchWithRetry: typeof fetch = async (input, init) => {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr;
};

const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false },
  global: { fetch: fetchWithRetry },
});

// ─── Row mapping ────────────────────────────────────────────────────────────

function toOrg(row: Record<string, any>): Org {
  return {
    id: row.id,
    name: row.name,
    managerName: row.manager_name,
    managerPhone: row.manager_phone,
    woltRatingUrl: row.wolt_rating_url,
    templateName: row.template_name,
    feedbackDelayMinutes: row.feedback_delay_minutes,
    isActive: row.is_active,
    createdAt: row.created_at,
    phones: Array.isArray(row.org_phones)
      ? row.org_phones.map((p: any) => ({ phone: p.phone, label: p.label }))
      : undefined,
    plan: row.plan ?? 'shared',
    whatsappPhoneNumberId: row.whatsapp_phone_number_id ?? null,
    whatsappToken: row.whatsapp_token ?? null,
  };
}

function toFeedback(row: Record<string, any>): Feedback {
  return {
    id: row.id,
    orgId: row.org_id,
    customerPhone: row.customer_phone,
    customerName: row.customer_name,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    waMessageId: row.wa_message_id,
    status: row.status,
    conversationState: row.conversation_state,
    result: row.result,
    complaint: row.complaint,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    org: row.orgs ? toOrg(row.orgs) : undefined,
  };
}

function fail(op: string, error: { message: string } | null): never {
  throw new Error(`[db] ${op} failed: ${error?.message ?? 'unknown error'}`);
}

// ─── Orgs ───────────────────────────────────────────────────────────────────

export async function getOrgByOwnerPhone(phone: string): Promise<Org | null> {
  const { data, error } = await supabase
    .from('org_phones')
    .select('phone, orgs(*)')
    .eq('phone', phone)
    .maybeSingle();
  if (error) fail('getOrgByOwnerPhone', error);
  if (!data?.orgs) return null;
  const org = toOrg(data.orgs as any);
  return org.isActive ? org : null;
}

export async function getOrgById(id: string): Promise<Org | null> {
  const { data, error } = await supabase
    .from('orgs')
    .select('*, org_phones(phone, label)')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('getOrgById', error);
  return data ? toOrg(data) : null;
}

export async function listOrgs(): Promise<Org[]> {
  const { data, error } = await supabase
    .from('orgs')
    .select('*, org_phones(phone, label)')
    .order('created_at', { ascending: true });
  if (error) fail('listOrgs', error);
  return (data ?? []).map(toOrg);
}

export interface OrgInput {
  name: string;
  managerName: string;
  managerPhone: string;
  woltRatingUrl: string;
  templateName?: string;
  feedbackDelayMinutes?: number;
  isActive?: boolean;
  plan?: OrgPlan;
  whatsappPhoneNumberId?: string | null;
  whatsappToken?: string | null;
}

function orgInputToRow(input: Partial<OrgInput>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row.name = input.name;
  if (input.managerName !== undefined) row.manager_name = input.managerName;
  if (input.managerPhone !== undefined) row.manager_phone = input.managerPhone;
  if (input.woltRatingUrl !== undefined) row.wolt_rating_url = input.woltRatingUrl;
  if (input.templateName !== undefined) row.template_name = input.templateName;
  if (input.feedbackDelayMinutes !== undefined) row.feedback_delay_minutes = input.feedbackDelayMinutes;
  if (input.isActive !== undefined) row.is_active = input.isActive;
  if (input.plan !== undefined) row.plan = input.plan;
  if (input.whatsappPhoneNumberId !== undefined) row.whatsapp_phone_number_id = input.whatsappPhoneNumberId;
  if (input.whatsappToken !== undefined) row.whatsapp_token = input.whatsappToken;
  return row;
}

export async function createOrg(input: OrgInput, phones: OrgPhone[]): Promise<Org> {
  const { data, error } = await supabase
    .from('orgs')
    .insert(orgInputToRow(input))
    .select()
    .single();
  if (error) fail('createOrg', error);
  await setOrgPhones(data.id, phones);
  return (await getOrgById(data.id))!;
}

export async function updateOrg(id: string, input: Partial<OrgInput>, phones?: OrgPhone[]): Promise<Org> {
  const row = orgInputToRow(input);
  if (Object.keys(row).length > 0) {
    const { error } = await supabase.from('orgs').update(row).eq('id', id);
    if (error) fail('updateOrg', error);
  }
  if (phones) await setOrgPhones(id, phones);
  return (await getOrgById(id))!;
}

export async function deleteOrg(id: string): Promise<void> {
  const { error } = await supabase.from('orgs').delete().eq('id', id);
  if (error) fail('deleteOrg', error);
}

async function setOrgPhones(orgId: string, phones: OrgPhone[]): Promise<void> {
  const { error: delError } = await supabase.from('org_phones').delete().eq('org_id', orgId);
  if (delError) fail('setOrgPhones/delete', delError);
  if (phones.length === 0) return;
  const { error } = await supabase
    .from('org_phones')
    .insert(phones.map((p) => ({ phone: p.phone, org_id: orgId, label: p.label ?? '' })));
  if (error) fail('setOrgPhones/insert', error);
}

// ─── Feedbacks ──────────────────────────────────────────────────────────────

export async function createFeedback(
  orgId: string,
  customerPhone: string,
  customerName: string,
  scheduledAt: Date
): Promise<Feedback> {
  const { data, error } = await supabase
    .from('feedbacks')
    .insert({
      org_id: orgId,
      customer_phone: customerPhone,
      customer_name: customerName,
      scheduled_at: scheduledAt.toISOString(),
    })
    .select('*, orgs(*)')
    .single();
  if (error) fail('createFeedback', error);
  return toFeedback(data);
}

export async function getFeedbackByWamid(wamid: string): Promise<Feedback | null> {
  const { data, error } = await supabase
    .from('feedbacks')
    .select('*, orgs(*)')
    .eq('wa_message_id', wamid)
    .maybeSingle();
  if (error) fail('getFeedbackByWamid', error);
  return data ? toFeedback(data) : null;
}

export async function getActiveFeedbackByPhone(customerPhone: string): Promise<Feedback | null> {
  const { data, error } = await supabase
    .from('feedbacks')
    .select('*, orgs(*)')
    .eq('customer_phone', customerPhone)
    .in('status', ['sent'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail('getActiveFeedbackByPhone', error);
  return data ? toFeedback(data) : null;
}

/**
 * Atomically claim all due pending feedbacks (pending → sending).
 * PostgREST executes this as a single UPDATE ... RETURNING, so two pollers
 * can never claim the same row.
 */
export async function claimDueFeedbacks(): Promise<Feedback[]> {
  const { data, error } = await supabase
    .from('feedbacks')
    .update({ status: 'sending' })
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .select('*, orgs(*)');
  if (error) fail('claimDueFeedbacks', error);
  return (data ?? []).map(toFeedback);
}

/** Recover rows stuck in 'sending' after a crash. Call once at startup only. */
export async function resetStuckSending(): Promise<number> {
  const { data, error } = await supabase
    .from('feedbacks')
    .update({ status: 'pending' })
    .eq('status', 'sending')
    .select('id');
  if (error) fail('resetStuckSending', error);
  return data?.length ?? 0;
}

export async function updateFeedback(
  id: number,
  fields: {
    status?: FeedbackStatus;
    sentAt?: Date;
    waMessageId?: string;
    conversationState?: Exclude<Feedback['conversationState'], null>;
    result?: 'positive' | 'manager';
    complaint?: string;
    errorDetail?: string;
  }
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (fields.status !== undefined) row.status = fields.status;
  if (fields.sentAt !== undefined) row.sent_at = fields.sentAt.toISOString();
  if (fields.waMessageId !== undefined) row.wa_message_id = fields.waMessageId;
  if (fields.conversationState !== undefined) row.conversation_state = fields.conversationState;
  if (fields.result !== undefined) row.result = fields.result;
  if (fields.complaint !== undefined) row.complaint = fields.complaint;
  if (fields.errorDetail !== undefined) row.error_detail = fields.errorDetail;
  const { error } = await supabase.from('feedbacks').update(row).eq('id', id);
  if (error) fail('updateFeedback', error);
}

export async function listFeedbacks(filters: {
  orgId?: string;
  status?: FeedbackStatus;
  limit?: number;
}): Promise<Feedback[]> {
  let query = supabase
    .from('feedbacks')
    .select('*, orgs(*)')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 100);
  if (filters.orgId) query = query.eq('org_id', filters.orgId);
  if (filters.status) query = query.eq('status', filters.status);
  const { data, error } = await query;
  if (error) fail('listFeedbacks', error);
  return (data ?? []).map(toFeedback);
}

export async function cancelFeedback(id: number): Promise<boolean> {
  const { data, error } = await supabase
    .from('feedbacks')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id');
  if (error) fail('cancelFeedback', error);
  return (data?.length ?? 0) > 0;
}

export interface OrgStats {
  orgId: string;
  name: string;
  total: number;
  pending: number;
  awaitingReply: number;
  positive: number;
  managerRequests: number;
  errors: number;
}

export async function getOrgStats(): Promise<OrgStats[]> {
  const { data, error } = await supabase.from('org_stats').select('*');
  if (error) fail('getOrgStats', error);
  return (data ?? []).map((row: any) => ({
    orgId: row.org_id,
    name: row.name,
    total: row.total,
    pending: row.pending,
    awaitingReply: row.awaiting_reply,
    positive: row.positive,
    managerRequests: row.manager_requests,
    errors: row.errors,
  }));
}
