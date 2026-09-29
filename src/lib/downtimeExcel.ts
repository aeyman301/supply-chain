/** Parser for the compiled machine downtime workbook,
 *  "11. COMPILE DATA DOWNTIME LEADPREP 2026.xlsx".
 *
 * The workbook holds one sheet per month, each laid out as:
 *   row 1 : title ("COMPILE DATA DOWNTIME ...")
 *   row 2 : blank
 *   row 3 : header (DATE | TIME FROM | TIME TO | TOTAL D/T (min) | PROBLEM TYPE |
 *            LOCATION | PROBLEM | COMMENT | OPERATOR | MAINTENANCE | REMARK)
 *   row 4+ : one row per downtime event
 *   tail   : a "FOCUS MACHINE" summary block, which is not event data
 *
 * Three things make a naive read silently wrong:
 *
 * 1. The columns are NOT in a fixed order. Most sheets put PROBLEM in column 6,
 *    but "AUGUST 26" carries MODEL | KANBAN NO there and pushes PROBLEM,
 *    COMMENT, OPERATOR, MAINTENANCE and REMARK one and two columns right. Every
 *    column is therefore resolved by its header text, with a positional
 *    fallback for sheets missing a header.
 *
 * 2. Some rows carry only a COMMENT or PROBLEM and no date. They are
 *    continuation lines belonging to the event above, so they are folded into
 *    that event rather than dropped.
 *
 * 3. The date is written in at least four ways across the sheets —
 *    "01/01/2026" (dd/mm/yyyy), "8/3/26" (m/d/yy), "14/Jul/26", and
 *    "3/9/2026 - 8/9/2026" (a range). Day/month order is resolved using the
 *    sheet's own month, which is the only reliable signal.
 */

import * as XLSX from "xlsx";

const MONTHS: Record<string, number> = {
  JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3, MACRH: 3,
  APR: 4, APRIL: 4, MEI: 5, MAY: 5, JUN: 6, JUNE: 6, JUL: 7, JULY: 7,
  AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9, SEPTEMBER: 9, OCT: 10, OCTOBER: 10,
  NOV: 11, NOVEMBER: 11, DEC: 12, DECEMBER: 12,
};

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** One downtime event, possibly with several folded continuation lines. */
export interface DowntimeEvent {
  date: string; // YYYY-MM-DD
  month: string; // YYYY-MM
  sheet: string;
  machine: string; // LOCATION, as written
  problemType: string;
  problem: string;
  comment: string;
  operator: string;
  maintenance: string;
  remark: string;
  timeFrom: string; // kept as written; not parsed
  timeTo: string;
  downtimeMin: number; // 0 when the sheet shows "-" or leaves it blank
  hasMinutes: boolean; // false when the sheet gave no usable figure
  /** continuation lines folded into this event */
  extraComments: number;
}

export interface DowntimeMonthMeta {
  month: string; // YYYY-MM
  sheet: string;
  /** "Total production, hr per m" — hours per machine for the month */
  totalProductionHr: number;
  /** "Total prod machine, hr over" — total machine hours for the month */
  totalMachineHr: number;
  /** "Normal working hr" — regular hours in a shift */
  normalWorkingHr: number;
  otWeekdayHr: number;
  otWeekendHr: number;
  normalWorkingDay: number;
  shift: number;
  machines: number; // "No of AC90 machine"
  totalShift: number;
  /** "Total DTmachine" with facility, in minutes */
  totalDtMachineMin: number;
  /** "Total DT app", in minutes */
  totalDtAppMin: number;
  /** "Total DTmachine" in the "With facility" block, covering every machine. */
  withFacilityMin: number;
  /** downtime summed from the event rows themselves */
  eventTotalMin: number;
  /** The sheet's own DT% cells, in document order: applicator focus, machine
   *  focus, and machine with-facility when the block is present. */
  dtPctApp: number;
  dtPctMachine: number;
  dtPctWithFacility: number;
  /**
   * Loading time available to one machine for one day, from the sheet's own
   * "Normal working hr" x "Shift". This is the denominator OEE availability is
   * measured against. Zero when the sheet does not state both figures.
   */
  basisMinPerMachineDay: number;
}

export interface DowntimeSheetResult {
  sheet: string;
  month: string;
  monthLabel: string;
  events: DowntimeEvent[];
  meta: DowntimeMonthMeta | null;
  eventsSkipped: number;
}

export interface DowntimeParseResult {
  fileName: string;
  sheets: DowntimeSheetResult[];
  events: DowntimeEvent[];
  meta: DowntimeMonthMeta[];
  warnings: string[];
  months: string[];
}

function txt(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

/** "1776 (29hr36min)" -> 1776 ; "-" -> 0 */
function parseDowntimeMinutes(v: unknown): { min: number; has: boolean } {
  const s = txt(v);
  if (!s || s === "-" || s === "--") return { min: 0, has: false };
  const m = /^(\d+(?:\.\d+)?)/.exec(s.replace(/,/g, ""));
  if (!m) return { min: 0, has: false };
  return { min: Number(m[1]), has: true };
}

/** Month a sheet name reports, e.g. "MACRH 26" -> 2026-03, "JULY 26 " -> 2026-07. */
export function detectDowntimeMonth(sheetName: string): string | null {
  const up = sheetName.toUpperCase();
  const re = /([A-Z]{3,9})[-\s]?(\d{2,4})?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(up)) !== null) {
    const mon = MONTHS[m[1]];
    if (mon === undefined) continue;
    const yTok = m[2];
    let year = new Date().getFullYear();
    if (yTok) {
      const y = Number(yTok);
      year = y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y;
    }
    return `${year}-${String(mon).padStart(2, "0")}`;
  }
  return null;
}

/**
 * Resolve a sheet's date cell to YYYY-MM-DD.
 *
 * `sheetMonth` disambiguates day/month order, which is genuinely inconsistent
 * across the sheets ("01/01/2026" is dd/mm, "8/3/26" on the August sheet is
 * m/d). Returns null when nothing date-like is present, which is how
 * continuation lines are identified.
 */
export function parseDowntimeDate(v: unknown, sheetMonth: string | null): string | null {
  const s = txt(v);
  if (!s) return null;
  // a range such as "3/9/2026 - 8/9/2026" describes one event spanning days
  const first = s.split(/\s+-\s+|\s*to\s+/)[0];
  if (/fokus|total|monitoring|target|rekap/i.test(s)) return null;

  const sheetMon = sheetMonth ? Number(sheetMonth.split("-")[1]) : null;
  const sheetYear = sheetMonth ? Number(sheetMonth.split("-")[0]) : null;

  // month name, e.g. "14/Jul/26"
  const named = /([A-Za-z]{3,9})\D{0,3}(\d{2,4})?/.exec(first);
  if (named && MONTHS[named[1].toUpperCase()] !== undefined) {
    const mon = MONTHS[named[1].toUpperCase()];
    const day = Number(/\d{1,2}/.exec(first)?.[0] ?? NaN);
    if (!Number.isFinite(day) || day < 1 || day > 31) return null;
    let year = sheetYear ?? new Date().getFullYear();
    if (named[2]) {
      const y = Number(named[2]);
      year = y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y;
    }
    return `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const nums = first.match(/\d+/g);
  if (!nums || nums.length < 2) return null;
  const a = Number(nums[0]);
  const b = Number(nums[1]);
  const yTok = nums[2];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  let year = sheetYear ?? new Date().getFullYear();
  if (yTok) {
    const y = Number(yTok);
    year = y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y;
  }

  let day: number;
  let mon: number;
  if (a > 12 && b <= 12) {
    day = a; mon = b; // unambiguous dd/mm
  } else if (b > 12 && a <= 12) {
    mon = a; day = b; // unambiguous m/dd
  } else if (sheetMon === a && sheetMon !== b) {
    mon = a; day = b; // the sheet's own month settles it
  } else if (sheetMon === b) {
    mon = b; day = a;
  } else {
    mon = b; day = a; // fall back to the local dd/mm convention
  }

  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Column indices for one sheet, resolved from its header text. */
interface ColMap {
  date: number; timeFrom: number; timeTo: number; minutes: number;
  problemType: number; location: number; problem: number; comment: number;
  operator: number; maintenance: number; remark: number;
  byHeader: boolean;
}

const DEFAULT_COLS: ColMap = {
  date: 0, timeFrom: 1, timeTo: 2, minutes: 3, problemType: 4, location: 5,
  problem: 6, comment: 7, operator: 8, maintenance: 9, remark: 10, byHeader: false,
};

const HEADER_ALIASES: [keyof Omit<ColMap, "byHeader">, string[]][] = [
  ["date", ["DATE"]],
  ["timeFrom", ["TIME FROM", "FROM"]],
  ["timeTo", ["TIME TO", "TO"]],
  ["minutes", ["TOTAL D/T", "TOTAL DT", "TOTAL DOWNTIME", "DOWNTIME", "TOTAL"]],
  ["problemType", ["PROBLEM TYPE", "TYPE"]],
  ["location", ["LOCATION", "MACHINE", "MACHINE NO"]],
  ["problem", ["PROBLEM", "ISSUE"]],
  ["comment", ["COMMENT", "ACTION", "SOLUTION"]],
  ["operator", ["OPERATOR"]],
  ["maintenance", ["MAINTENANCE", "TECHNICIAN"]],
  ["remark", ["REMARK", "REMARKS", "NOTE"]],
];

function mapColumns(header: unknown[]): ColMap {
  const upper = header.map((c) => txt(c).toUpperCase());
  const out: ColMap = { ...DEFAULT_COLS };
  let matched = 0;
  for (const [field, aliases] of HEADER_ALIASES) {
    // An exact header match always wins. Prefix matching alone is unsafe here:
    // "PROBLEM" is a prefix of "PROBLEM TYPE", so a prefix-only search would
    // bind the PROBLEM field to the PROBLEM TYPE column and silently drop the
    // real problem text.
    let idx = -1;
    for (const a of aliases) {
      idx = upper.indexOf(a);
      if (idx >= 0) break;
    }
    if (idx < 0) {
      // then the longest alias, so a more specific header is preferred
      for (const a of [...aliases].sort((x, y) => y.length - x.length)) {
        idx = upper.findIndex((h) => h !== "" && h.startsWith(a));
        if (idx >= 0) break;
      }
    }
    if (idx >= 0) {
      out[field] = idx;
      matched++;
    }
  }
  out.byHeader = matched >= 5;
  return out;
}

/** Index of the header row, i.e. the first row containing a DATE cell. */
function findHeaderRow(grid: unknown[][]): number {
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const row = grid[i] ?? [];
    if (row.some((c) => txt(c).toUpperCase() === "DATE")) return i;
  }
  return -1;
}

const FOOTER_RE = /fokus|total dt|total prod|with facility|monitoring|target downtime|rekap|jumlah/i;

/** The summary block that closes every sheet. Its first label ends the data. */
function isFooterRow(row: unknown[]): boolean {
  for (let i = 0; i < Math.min(row.length, 6); i++) {
    if (FOOTER_RE.test(txt(row[i]))) return true;
  }
  return false;
}

/**
 * Read a value that belongs to a label cell.
 *
 * The footer block is a hand-built mini-table and is laid out two different
 * ways across the sheets, so both are handled:
 *   "Total DTmachine:" | 460   -> value to the RIGHT of the label
 *   "Normal working hr" ... / 9 -> value on a LATER row, same column
 */
function labelledValue(
  grid: unknown[][],
  labels: string[],
  opts: { exact?: boolean; afterRow?: number } = {}
): number {
  const exact = opts.exact ?? false;
  const from = opts.afterRow ?? 0;
  for (let r = from; r < grid.length; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const cell = txt(row[c]).toLowerCase();
      if (!cell) continue;
      const hit = exact ? labels.includes(cell) : labels.some((l) => cell.startsWith(l));
      if (!hit) continue;

      // same row, to the right
      for (let j = c + 1; j < Math.min(row.length, c + 4); j++) {
        const s = txt(row[j]);
        if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
      }
      // same column, on one of the next few rows
      for (let i = r + 1; i < Math.min(grid.length, r + 5); i++) {
        const s = txt(grid[i]?.[c]);
        if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
      }
    }
  }
  return 0;
}

/** "Total: 43 shift" is written as one free-standing cell. */
function totalShiftCell(grid: unknown[][]): number {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const m = /^total:\s*(\d+)\s*shift$/i.exec(txt(row[c]));
      if (m) return Number(m[1]);
    }
  }
  return 0;
}

function extractMeta(
  grid: unknown[][],
  sheet: string,
  month: string
): DowntimeMonthMeta {
  // The block repeats itself: a "FOCUS MACHINE AC90 ONLY" section, then the
  // machine-hour basis, then a "With facility" section covering every machine.
  // Availability is computed against the machine-hour basis with the wider
  // "with facility" downtime.
  const withFacilityRow = grid.findIndex((r) =>
    (r ?? []).some((c) => txt(c).toLowerCase().startsWith("with facility"))
  );
  const withFacilityMin =
    withFacilityRow >= 0
      ? labelledValue(grid, ["total dtmachine", "total dt machine"], {
          afterRow: withFacilityRow,
        })
      : 0;

  // every "DT%" cell, in the order the sheet writes them
  const dtPcts: number[] = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (txt(row[c]).toLowerCase() !== "dt%") continue;
      for (let i = r + 1; i < Math.min(grid.length, r + 5); i++) {
        const s = txt(grid[i]?.[c]);
        if (/^\d+(\.\d+)?$/.test(s)) {
          dtPcts.push(Number(s));
          break;
        }
      }
    }
  }

  const normalWorkingHr = labelledValue(grid, ["normal working hr"]);
  const shift = labelledValue(grid, ["shift"], { exact: true });

  return {
    month,
    sheet,
    totalProductionHr: labelledValue(grid, ["total production, hr", "total production hr"]),
    totalMachineHr: labelledValue(grid, ["total prod machine", "total production machine"]),
    normalWorkingHr,
    otWeekdayHr: labelledValue(grid, ["ot weekday hr"]),
    otWeekendHr: labelledValue(grid, ["ot weekend hr"]),
    normalWorkingDay: labelledValue(grid, ["normal working day"]),
    shift,
    machines: labelledValue(grid, ["no of ac90 machine", "no of machine"]),
    totalShift: totalShiftCell(grid),
    totalDtMachineMin: labelledValue(grid, ["total dtmachine", "total dt machine"]),
    totalDtAppMin: labelledValue(grid, ["total dt app", "total dtapplicator"]),
    withFacilityMin,
    eventTotalMin: 0,
    dtPctApp: dtPcts[0] ?? 0,
    dtPctMachine: dtPcts[1] ?? 0,
    dtPctWithFacility: dtPcts[2] ?? 0,
    basisMinPerMachineDay:
      normalWorkingHr > 0 && shift > 0 ? normalWorkingHr * shift * 60 : 0,
  };
}

function parseSheet(
  grid: unknown[][],
  sheet: string,
  month: string,
  warnings: string[]
): DowntimeSheetResult {
  const hIdx = findHeaderRow(grid);
  const empty: DowntimeSheetResult = {
    sheet, month, monthLabel: "", events: [], meta: null, eventsSkipped: 0,
  };
  if (hIdx < 0) return empty;

  const C = mapColumns(grid[hIdx] ?? []);
  if (!C.byHeader) {
    warnings.push(
      `${sheet}: header row did not match the expected columns; columns were assumed by position.`
    );
  }

  const monthLabel = MONTH_ABBR[Number(month.split("-")[1]) - 1]?.toUpperCase() ?? "";
  const events: DowntimeEvent[] = [];
  let skipped = 0;
  let offMonth = 0;

  for (let i = hIdx + 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    if (!row.some((c) => txt(c) !== "")) continue;
    if (isFooterRow(row)) break;

    const date = parseDowntimeDate(row[C.date], month);
    if (date) {
      const { min, has } = parseDowntimeMinutes(row[C.minutes]);
      events.push({
        date,
        month: date.slice(0, 7),
        sheet,
        machine: txt(row[C.location]),
        problemType: txt(row[C.problemType]),
        problem: txt(row[C.problem]),
        comment: txt(row[C.comment]),
        operator: txt(row[C.operator]),
        maintenance: txt(row[C.maintenance]),
        remark: txt(row[C.remark]),
        timeFrom: txt(row[C.timeFrom]),
        timeTo: txt(row[C.timeTo]),
        downtimeMin: min,
        hasMinutes: has,
        extraComments: 0,
      });
      if (!date.startsWith(month + "-")) offMonth++;
      continue;
    }

    // no date: a continuation line belonging to the event above
    const prev = events[events.length - 1];
    if (!prev) {
      skipped++;
      continue;
    }
    const extra = [txt(row[C.comment]), txt(row[C.problem])].filter(Boolean).join("; ");
    if (extra) {
      prev.comment = prev.comment ? `${prev.comment}; ${extra}` : extra;
      prev.extraComments++;
    }
  }

  if (offMonth > 0) {
    warnings.push(
      `${sheet}: ${offMonth} event(s) carry a date outside ${monthLabel} — check the date column.`
    );
  }
  const noMinutes = events.filter((e) => !e.hasMinutes).length;
  if (noMinutes > 0) {
    warnings.push(
      `${sheet}: ${noMinutes} event(s) have no downtime minutes in the sheet and are treated as unknown.`
    );
  }

  const meta = extractMeta(grid, sheet, month);
  meta.eventTotalMin = events.reduce((s, e) => s + e.downtimeMin, 0);

  // The summary block at the foot of each sheet is frequently a stale copy from
  // another month (June, July, August and September all carry totals that
  // belong to a different sheet), so it is never used as a source. The dated
  // log rows above it are, and any disagreement is reported rather than
  // reconciled.
  const sheetTotal = meta.withFacilityMin || meta.totalDtMachineMin;
  if (sheetTotal > 0 && Math.abs(sheetTotal - meta.eventTotalMin) > 1) {
    warnings.push(
      `${sheet}: the log rows total ${meta.eventTotalMin.toLocaleString()} min, but the sheet's own ` +
        `summary says ${sheetTotal.toLocaleString()} min. The log rows are used; the summary block ` +
        `looks out of date.`
    );
  }

  return { sheet, month, monthLabel, events, meta, eventsSkipped: skipped };
}

export async function parseDowntimeWorkbook(file: File | Blob): Promise<DowntimeParseResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const warnings: string[] = [];
  const sheets: DowntimeSheetResult[] = [];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) continue; // entirely empty sheet
    const grid = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: false,
      defval: "",
    }) as unknown[][];
    if (grid.length === 0) continue;

    const month = detectDowntimeMonth(name);
    if (!month) {
      // a summary or scratch sheet, e.g. "Bellmouth issue"
      continue;
    }
    const res = parseSheet(grid, name, month, warnings);
    if (res.events.length === 0 && !res.meta?.totalMachineHr) continue;
    sheets.push(res);
  }

  if (sheets.length === 0) {
    throw new Error(
      "No monthly downtime sheets were found. Expected sheets named after a month, e.g. \"JANUARY 26\"."
    );
  }

  const events = sheets.flatMap((s) => s.events);
  const meta = sheets
    .filter((s) => s.meta)
    .map((s) => s.meta!);

  return {
    fileName: "name" in file ? (file as File).name : "",
    sheets,
    events,
    meta,
    warnings,
    months: [...new Set(events.map((e) => e.month))].sort(),
  };
}
