import path from 'path';
import PDFDocument from 'pdfkit';
import { Feedback, Org } from './types';
import { formatIsraeliPhone } from './ocr';

/**
 * Periodic PDF reports for restaurant managers.
 *
 * Two things about Hebrew in pdfkit shaped this file:
 *
 * 1. No manual bidi. pdfkit lays out RTL scripts through fontkit already, so
 *    a logical Hebrew string draws correctly as-is. Reordering it first (with
 *    the Unicode bidi algorithm, say) double-reverses it into gibberish.
 * 2. Hebrew and digits never share one draw call. Where an RTL run meets
 *    digits, fontkit swallows the space between them and glues them together
 *    ("15ללקוחות"). Directional marks — LRM, RLM, NBSP — do not fix it, so
 *    every label and its value are positioned as separate pieces instead.
 * 3. Every Hebrew string is drawn with a trailing space, via `pad()` below.
 */

const HEBREW = /[֐-׿]/;

/**
 * pdfkit drops exactly one space per right-to-left line — the one that ends up
 * leftmost — welding the last two words together ("פילוחדירוגים"). A trailing
 * space is eaten in its place and the real ones survive.
 *
 * Checked against pdfkit's actual output: non-breaking spaces also close the
 * gap but reverse the word order, and LRM/RLM marks change nothing. Latin and
 * numeric cells are left alone, where a trailing space would just shift a
 * right-aligned value off the margin.
 */
function pad(text: string): string {
  return HEBREW.test(text) ? `${text} ` : text;
}

const FONT_DIR = path.join(process.cwd(), 'assets');
const REGULAR = path.join(FONT_DIR, 'NotoSansHebrew-Regular.ttf');
const BOLD = path.join(FONT_DIR, 'NotoSansHebrew-Bold.ttf');

export type ReportPeriod = 'daily' | 'weekly' | 'monthly';

const PERIOD_TITLE: Record<ReportPeriod, string> = {
  daily: 'דוח יומי',
  weekly: 'דוח שבועי',
  monthly: 'דוח חודשי',
};

export interface ReportData {
  org: Org;
  period: ReportPeriod;
  /** Inclusive local-date bounds, YYYY-MM-DD. */
  from: string;
  to: string;
  entries: Feedback[];
}

export interface ReportSummary {
  sent: number;
  answered: number;
  averageRating: number | null;
  distribution: Record<number, number>;
  notes: Feedback[];
}

export function summarize(entries: Feedback[]): ReportSummary {
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let answered = 0;

  for (const entry of entries) {
    if (entry.rating) {
      distribution[entry.rating] = (distribution[entry.rating] ?? 0) + 1;
      total += entry.rating;
      answered++;
    }
  }

  return {
    sent: entries.length,
    answered,
    averageRating: answered ? total / answered : null,
    distribution,
    notes: entries.filter((e) => e.complaint || e.reason || e.rating),
  };
}

function displayDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function shortDateTime(value: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  });
}

// ─── Layout ─────────────────────────────────────────────────────────────────

const PAGE_MARGIN = 45;
const PAGE_WIDTH = 595.28;
const CONTENT_BOTTOM = 745;
const FOOTER_Y = 772;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const RIGHT_EDGE = PAGE_WIDTH - PAGE_MARGIN;

const INK = '#1a1a1a';
const MUTED = '#6f6f6f';
const RULE = '#e0e0e0';
const BAD = '#c0392b';
const OK = '#b7791f';
const GOOD = '#1e8449';

type Doc = PDFKit.PDFDocument;

interface TextOpts {
  size?: number;
  bold?: boolean;
  color?: string;
}

function use(doc: Doc, opts: TextOpts): number {
  const size = opts.size ?? 11;
  doc
    .font(opts.bold ? 'hebBold' : 'heb')
    .fontSize(size)
    .fillColor(opts.color ?? INK);
  return size;
}

/** One right-aligned line. Must be a single script — Hebrew or digits, not both. */
function line(doc: Doc, text: string, y: number, opts: TextOpts = {}): number {
  const size = use(doc, opts);
  doc.text(pad(text), PAGE_MARGIN, y, { width: CONTENT_WIDTH, align: 'right', lineBreak: false });
  return y + size * 1.55;
}

/**
 * A Hebrew label at the right edge with its value placed to the left of it.
 * Two draws rather than one string — see the note at the top of this file.
 */
function labelValue(doc: Doc, label: string, value: string, y: number, opts: TextOpts = {}): number {
  const size = use(doc, opts);
  // Measured unpadded so the label still sits flush to the right margin.
  const labelWidth = doc.widthOfString(label);
  doc.text(pad(label), RIGHT_EDGE - labelWidth, y, { lineBreak: false });

  const valueWidth = doc.widthOfString(value);
  doc.text(value, RIGHT_EDGE - labelWidth - 7 - valueWidth, y, { lineBreak: false });
  return y + size * 1.55;
}

function ruleAt(doc: Doc, y: number, color = RULE): void {
  doc.moveTo(PAGE_MARGIN, y).lineTo(RIGHT_EDGE, y).strokeColor(color).lineWidth(0.7).stroke();
}

const BAR_COLOR: Record<number, string> = { 5: GOOD, 4: GOOD, 3: OK, 2: BAD, 1: BAD };

/**
 * One row of the rating histogram. The star is drawn as a polygon: the Hebrew
 * font carries no ★ glyph, and asking for one yields an empty .notdef box.
 */
function star(doc: Doc, cx: number, cy: number, r: number, color: string): void {
  doc.save().fillColor(color);
  for (let i = 0; i < 5; i++) {
    const outer = (i * 4 * Math.PI) / 5 - Math.PI / 2;
    const x = cx + r * Math.cos(outer);
    const y = cy + r * Math.sin(outer);
    if (i === 0) doc.moveTo(x, y);
    else doc.lineTo(x, y);
  }
  doc.closePath().fill('even-odd').restore();
}

function ratingBar(doc: Doc, y: number, stars: number, count: number, max: number): number {
  const color = BAR_COLOR[stars];
  const barMax = 210;
  const barRight = RIGHT_EDGE - 46;
  const width = max > 0 ? (count / max) * barMax : 0;

  use(doc, { size: 10 });
  doc.text(String(stars), RIGHT_EDGE - 12, y, { lineBreak: false });
  star(doc, RIGHT_EDGE - 24, y + 5.5, 5.5, color);

  doc.rect(barRight - barMax, y + 1, barMax, 9).fillColor('#f1f1f1').fill();
  if (width > 0) doc.rect(barRight - width, y + 1, width, 9).fillColor(color).fill();

  use(doc, { size: 9, color: MUTED });
  doc.text(String(count), barRight - barMax - 30, y, { width: 24, align: 'right', lineBreak: false });
  return y + 17;
}

interface Column {
  title: string;
  width: number;
  /** The comment column wraps; every other cell is a single line. */
  wrap?: boolean;
}

function tableHeader(doc: Doc, columns: Column[], y: number): number {
  let x = RIGHT_EDGE;
  use(doc, { size: 9.5, bold: true, color: MUTED });
  for (const col of columns) {
    x -= col.width;
    doc.text(pad(col.title), x, y, { width: col.width - 6, align: 'right', lineBreak: false });
  }
  ruleAt(doc, y + 13);
  return y + 19;
}

function tableRow(doc: Doc, columns: Column[], values: string[], y: number): number {
  const size = 9.5;
  const wrapIndex = columns.findIndex((c) => c.wrap);

  use(doc, { size });
  let height = size * 1.5;
  if (wrapIndex >= 0) {
    const w = columns[wrapIndex].width - 8;
    height = Math.max(height, doc.heightOfString(pad(values[wrapIndex] || '-'), { width: w }) + 3);
  }

  let x = RIGHT_EDGE;
  columns.forEach((col, i) => {
    x -= col.width;
    use(doc, { size });
    const value = pad(values[i] || '-');
    if (i === wrapIndex) {
      doc.text(value, x, y, { width: col.width - 8, align: 'right' });
    } else {
      doc.text(value, x, y, { width: col.width - 6, align: 'right', lineBreak: false });
    }
  });

  return y + height + 5;
}

// ─── Document ───────────────────────────────────────────────────────────────

export function buildReportPdf(data: ReportData): Promise<Buffer> {
  const summary = summarize(data.entries);
  const range =
    data.from === data.to
      ? displayDate(data.to)
      : `${displayDate(data.from)} - ${displayDate(data.to)}`;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('heb', REGULAR);
    doc.registerFont('hebBold', BOLD);

    // ── Title: restaurant, then period, then dates — each its own line so no
    // draw call ever mixes Hebrew with digits. ──
    let y = PAGE_MARGIN;
    y = line(doc, data.org.name, y, { size: 21, bold: true });
    y = line(doc, PERIOD_TITLE[data.period], y, { size: 13, color: MUTED });
    y = line(doc, range, y, { size: 11, color: MUTED });
    y += 8;
    ruleAt(doc, y);
    y += 15;

    // ── Summary ──
    y = line(doc, 'סיכום', y, { size: 14, bold: true });
    y += 3;
    y = labelValue(doc, 'הודעות שנשלחו ללקוחות', String(summary.sent), y);
    y = labelValue(doc, 'לקוחות שדירגו', String(summary.answered), y);
    if (summary.averageRating !== null) {
      y = labelValue(doc, 'ממוצע דירוג', `${summary.averageRating.toFixed(2)} / 5`, y, { bold: true });
    } else {
      y = line(doc, 'לא התקבלו דירוגים בתקופה זו', y, { color: MUTED });
    }
    y += 14;

    // ── Distribution ──
    y = line(doc, 'פילוח דירוגים', y, { size: 14, bold: true });
    y += 6;
    const maxCount = Math.max(1, ...Object.values(summary.distribution));
    for (const stars of [5, 4, 3, 2, 1]) {
      y = ratingBar(doc, y, stars, summary.distribution[stars] ?? 0, maxCount);
    }
    y += 14;

    // ── Detail table ──
    y = line(doc, 'פירוט דירוגים והערות', y, { size: 14, bold: true });
    y += 6;

    const columns: Column[] = [
      { title: 'תאריך', width: 60 },
      { title: 'לקוח', width: 78 },
      { title: 'טלפון', width: 74 },
      { title: 'דירוג', width: 38 },
      { title: 'סיבה', width: 70 },
      { title: 'הערה', width: CONTENT_WIDTH - 60 - 78 - 74 - 38 - 70, wrap: true },
    ];

    if (summary.notes.length === 0) {
      y = line(doc, 'לא התקבלו תגובות בתקופה זו.', y, { color: MUTED });
    } else {
      y = tableHeader(doc, columns, y);
      for (const entry of summary.notes) {
        if (y > CONTENT_BOTTOM) {
          doc.addPage();
          y = tableHeader(doc, columns, PAGE_MARGIN);
        }
        y = tableRow(
          doc,
          columns,
          [
            shortDateTime(entry.sentAt ?? entry.createdAt),
            entry.customerName || '-',
            formatIsraeliPhone(entry.customerPhone),
            entry.rating ? `${entry.rating}/5` : '-',
            entry.reason || '-',
            entry.complaint || '-',
          ],
          y
        );
        ruleAt(doc, y - 4, '#f2f2f2');
      }
    }

    use(doc, { size: 8, color: MUTED });
    doc.text(pad('הופק אוטומטית'), PAGE_MARGIN, FOOTER_Y, {
      width: CONTENT_WIDTH,
      align: 'right',
      lineBreak: false,
    });

    doc.end();
  });
}

export function reportFileName(period: ReportPeriod, to: string): string {
  return `report-${period}-${to}.pdf`;
}

export function reportCaption(org: Org, period: ReportPeriod, from: string, to: string): string {
  const range =
    from === to ? displayDate(to) : `${displayDate(from)} - ${displayDate(to)}`;
  return `📊 ${PERIOD_TITLE[period]} — ${org.name}\n${range}`;
}
