import {
  claimReportRun,
  getReportFeedbacks,
  listOrgs,
  releaseReportRun,
} from './db';
import { buildReportPdf, reportCaption, reportFileName, ReportPeriod } from './report';
import { credentialsFor, managerPhones, sendDocument, uploadMedia } from './whatsapp';
import { Org } from './types';

/**
 * Delivers the daily / weekly / monthly PDF to each restaurant's manager at
 * that restaurant's own closing time.
 *
 * Everything here works in Asia/Jerusalem wall-clock terms, because "the end
 * of the day" is a local idea. The bot's own clock is UTC on Render.
 */

const TIME_ZONE = 'Asia/Jerusalem';

interface LocalNow {
  /** YYYY-MM-DD in the restaurant's timezone. */
  date: string;
  /** HH:MM, 24h, in the restaurant's timezone. */
  hhmm: string;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. The Israeli week ends on Saturday. */
function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

function isLastDayOfMonth(isoDate: string): boolean {
  return addDays(isoDate, 1).slice(5, 7) !== isoDate.slice(5, 7);
}

/**
 * A closing time at or before this belongs to the night of the *previous*
 * calendar day. Restaurants that shut at midnight or 01:00 are closing out
 * the day that just ended, not opening the one whose clock just started.
 */
const AFTER_MIDNIGHT_CUTOFF = '05:00';

export function localNow(now: Date = new Date()): LocalNow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * The calendar day a report covers: the business day that ends at this
 * restaurant's closing time. For a place shutting at 22:00 that is today; for
 * one shutting at midnight or 01:00 it is yesterday, since the clock has
 * already rolled over by the time the doors close.
 */
export function businessDayFor(now: LocalNow, closingTime: string): string {
  return closingTime < AFTER_MIDNIGHT_CUTOFF ? addDays(now.date, -1) : now.date;
}

interface DueReport {
  period: ReportPeriod;
  from: string;
  to: string;
}

/**
 * Which reports this local moment calls for, newest period last.
 *
 * Every period is keyed to the business day being closed out, not to today's
 * wall-clock date — otherwise a restaurant shutting at midnight would report
 * on a day that started twenty seconds ago and is therefore always empty.
 */
export function dueReports(now: LocalNow, closingTime: string): DueReport[] {
  // 'HH:MM' strings compare correctly as text, so no parsing is needed.
  if (now.hhmm < closingTime) return [];

  const day = businessDayFor(now, closingTime);
  const due: DueReport[] = [{ period: 'daily', from: day, to: day }];
  if (weekdayOf(day) === 6) {
    due.push({ period: 'weekly', from: addDays(day, -6), to: day });
  }
  if (isLastDayOfMonth(day)) {
    due.push({ period: 'monthly', from: `${day.slice(0, 8)}01`, to: day });
  }
  return due;
}

export async function sendReport(
  org: Org,
  period: ReportPeriod,
  from: string,
  to: string,
  options: { force?: boolean } = {}
): Promise<'sent' | 'empty' | 'duplicate' | 'failed'> {
  // Claim before building: the insert is the lock that stops a restart or an
  // overlapping poll from delivering the same report twice. A manual send from
  // the dashboard skips the claim — asking for it again is the whole point.
  if (!options.force && !(await claimReportRun(org.id, period, to))) return 'duplicate';

  try {
    const entries = await getReportFeedbacks(org.id, from, to);
    if (entries.length === 0 && !options.force) {
      // A nightly "0 messages" PDF is noise. The claim stays, so this period
      // is considered handled rather than retried every 20 seconds.
      console.log(`[reports] ${org.name} ${period} ${to}: nothing to report`);
      return 'empty';
    }

    const pdf = await buildReportPdf({ org, period, from, to, entries });
    const creds = credentialsFor(org);
    const filename = reportFileName(period, to);
    const mediaId = await uploadMedia(creds, pdf, filename, 'application/pdf');

    // One upload, sent to every manager — and each recipient gets its own
    // try/catch so one manager's lapsed 24h session doesn't sink delivery to
    // the rest. Only retreat to 'failed' (and let the next poll retry) if
    // NOBODY got it; if even one did, retrying would duplicate their copy.
    let deliveredToAnyone = false;
    for (const phone of managerPhones(org)) {
      try {
        await sendDocument(creds, phone, mediaId, filename, reportCaption(org, period, from, to));
        deliveredToAnyone = true;
      } catch (err: any) {
        const detail = err?.response?.data?.error ?? err?.message ?? err;
        console.error(`[reports] ${period} report for ${org.name} to ${phone} failed:`, JSON.stringify(detail));
      }
    }
    if (!deliveredToAnyone) throw new Error('report delivery failed for every manager phone');

    console.log(`[reports] Sent ${period} report for ${org.name} (${entries.length} rows)`);
    return 'sent';
  } catch (err: any) {
    const detail = err?.response?.data?.error ?? err?.message ?? err;
    console.error(`[reports] ${period} report for ${org.name} failed:`, JSON.stringify(detail));
    // Hand the claim back so the next poll retries — a manager's 24h window
    // may simply have been shut at that moment.
    if (!options.force) await releaseReportRun(org.id, period, to);
    return 'failed';
  }
}

export async function checkReports(): Promise<void> {
  const now = localNow();
  const orgs = await listOrgs();

  for (const org of orgs) {
    if (!org.isActive) continue;
    for (const due of dueReports(now, org.closingTime)) {
      await sendReport(org, due.period, due.from, due.to);
    }
  }
}
