/** Parser for the monthly IPQC output workbooks, e.g.
 *  "09-IPQC  09-SEPT-26.xls"
 *
 * The `IPQC` sheet is laid out as:
 *   row 1-3 : title plus a summary block (total defects, total qty checked, DPM)
 *   row 4   : header row (NO. | DATE | CCW | MONTHLY | SHIFT | MACHINE NO. | ...)
 *   row 5+  : one row per inspected position
 *
 * A new "inspection" starts on any row that carries a DEF QTY. The rows that
 * follow carry only the machine/position detail, and most context columns are
 * left blank as a visual grouping, so they have to be forward-filled.
 *
 * Verified against the Sept 2026 file: 556 inspection groups, sum DEF QTY 1967,
 * sum QTY-CHECK 3,147,355, DPM 624.97 — matching the summary block exactly.
 */

import * as XLSX from "xlsx";

export const IPQC_SHEET = "IPQC";

const MONTHS: Record<string, number> = {
  JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3,
  APR: 4, APRIL: 4, MEI: 5, MAY: 5, JUN: 6, JUNE: 6,
  JUL: 7, JULY: 7, AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11, DEC: 12, DECEMBER: 12,
};

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** One inspected position row. */
export interface IpqcRow {
  no: number;
  date: string; // YYYY-MM-DD
  month: string; // YYYY-MM
  ccw: string; // ISO week number as written in the sheet
  monthLabel: string; // MONTHLY column, e.g. "SEPT"
  shift: string; // MALAM | NORMAL
  machine: string;
  leadCode: string;
  rejectTag: string;
  model: string;
  defectType: string;
  defQty: number;
  qtyCheck: number;
  remark: string;
  action: string;
  /** True when the source row carried its own DEF QTY, i.e. it starts a new
   *  inspection. Continuation rows only add machine/position detail. */
  isInspection: boolean;
}

/** Aggregate for one machine on one day. */
export interface IpqcAgg {
  date: string;
  month: string;
  machine: string;
  shift: string;
  qtyCheck: number;
  defQty: number;
  dpm: number; // defects per million checked
  rejectRatePct: number;
  inspections: number;
  positions: number; // rows inspected, including continuation rows
  leadCodes: string[];
  topDefect: string;
  topDefectQty: number;
}

export interface IpqcParseResult {
  fileName: string;
  month: string;
  monthLabel: string;
  title: string;
  rows: IpqcRow[];
  aggs: IpqcAgg[];
  machines: string[];
  shifts: string[];
  defectTypes: string[];
  totals: {
    rows: number;
    inspections: number;
    defQty: number;
    qtyCheck: number;
    dpm: number;
  };
  /** DPM quoted in the workbook's own summary block, for cross-checking. */
  reportedDpm: number | null;
  reportedDefQty: number | null;
  reportedQtyCheck: number | null;
  warnings: string[];
}

/** Pull the reporting month out of a filename like "09-IPQC  09-SEPT-26.xls".
 *  The leading "09-" is the month number, not the year, so the year has to be
 *  taken from the token next to the month *name*. */
export function detectIpqcMonth(filename: string): string | null {
  const up = filename.toUpperCase();
  // month name plus an optional year that directly follows it, e.g.
  // "09-IPQC  09-SEPT-26" -> SEPT + 26, ignoring the leading "09" day/month number
  const re = /([A-Z]{3,9})[-\s]?(\d{2,4})?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(up)) !== null) {
    const nameTok = m[1];
    const mon = MONTHS[nameTok];
    if (mon === undefined) continue;
    const yearTok = m[2];
    if (yearTok) {
      const y = Number(yearTok);
      const year = y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y;
      return `${year}-${String(mon).padStart(2, "0")}`;
    }
    // month name only (e.g. "IPQC SEPT report") — assume the current year
    return `${new Date().getFullYear()}-${String(mon).padStart(2, "0")}`;
  }
  return null;
}

/** "1-Sep" / "01-Sep" -> day number, given the reporting month's year+month. */
function parseDay(cell: string, month: string): string | null {
  const t = cell.trim();
  if (!t) return null;
  const m = /^(\d{1,2})\s*[-/]?\s*([A-Za-z]{3,9})?$/.exec(t);
  if (!m) return null;
  const day = Number(m[1]);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  const [y, mo] = month.split("-").map(Number);
  const nameMon = m[2] ? MONTHS[m[2].toUpperCase()] : undefined;
  const useMonth = nameMon ?? mo;
  const useYear = nameMon && nameMon !== mo ? y : y;
  return `${useYear}-${String(useMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function txt(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function fmtInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export async function parseIpqcWorkbook(file: File | Blob): Promise<IpqcParseResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const warnings: string[] = [];

  const sheetName =
    wb.SheetNames.find((n) => n.trim().toUpperCase() === IPQC_SHEET) ?? wb.SheetNames[0];
  if (!sheetName) throw new Error("Workbook has no sheets");
  const ws = wb.Sheets[sheetName];

  const grid = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: true,
  }) as unknown[][];

  // ---- locate the header row -------------------------------------------------
  const C = {
    no: -1, date: -1, ccw: -1, month: -1, shift: -1, machine: -1, lead: -1,
    tag: -1, model: -1, defect: -1, defQty: -1, qtyCheck: -1, remark: -1, action: -1,
  };
  let headerIdx = -1;
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    const r = grid[i].map(txt);
    const hasNo = r.some((c) => /^no\.?$/i.test(c));
    const hasMachine = r.some((c) => /machine\s*no/i.test(c));
    const hasDefQty = r.some((c) => /def\s*qty/i.test(c));
    if (hasNo && hasMachine && hasDefQty) {
      headerIdx = i;
      r.forEach((c, idx) => {
        if (/^no\.?$/i.test(c)) C.no = idx;
        else if (/^date$/i.test(c)) C.date = idx;
        else if (/ccw|week/i.test(c)) C.ccw = idx;
        else if (/monthly/i.test(c)) C.month = idx;
        else if (/shift/i.test(c)) C.shift = idx;
        else if (/machine\s*no/i.test(c)) C.machine = idx;
        else if (/lead\s*code/i.test(c)) C.lead = idx;
        else if (/reject\s*tag/i.test(c)) C.tag = idx;
        else if (/^model$/i.test(c)) C.model = idx;
        else if (/defect\s*type/i.test(c)) C.defect = idx;
        else if (/def\s*qty/i.test(c)) C.defQty = idx;
        else if (/qty[-\s]*check/i.test(c)) C.qtyCheck = idx;
        else if (/remark/i.test(c)) C.remark = idx;
        else if (/action/i.test(c)) C.action = idx;
      });
      break;
    }
  }
  if (headerIdx < 0) throw new Error(`Could not find the IPQC header row on sheet "${sheetName}"`);
  if (C.defQty < 0) throw new Error("Header row is missing the DEF QTY column");

  /* ------------------------------------------------------------------
   * Past QTY-CHECK the header and the data drift apart in this workbook:
   * the header calls column 14 "REMARK" but the P1/P2 values actually sit
   * in column 13, with column 12 permanently blank. Anchor on the numbered
   * data rows and pick, for each optional trailing column, the offset that
   * actually holds values — claiming indices left to right so two headers
   * never land on the same data column.
   * ------------------------------------------------------------------ */
  const dataRowIdx: number[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const v = C.no >= 0 ? txt(grid[i]?.[C.no]) : "";
    if (/^\d+$/.test(v)) dataRowIdx.push(i);
  }
  const alignThreshold = Math.max(3, Math.floor(dataRowIdx.length * 0.02));
  const claimed = new Set<number>([C.no, C.date, C.ccw, C.month, C.shift, C.machine, C.lead, C.tag, C.model, C.defect, C.defQty, C.qtyCheck].filter((i) => i >= 0));

  for (const key of ["model", "tag", "remark", "action"] as const) {
    const c = C[key];
    if (c < 0) continue;
    let bestOff = 0;
    let bestHits = 0;
    for (let d = -2; d <= 2; d++) {
      const idx = c + d;
      if (idx < 0 || claimed.has(idx)) continue;
      let hits = 0;
      for (const ri of dataRowIdx) if (txt(grid[ri]?.[idx]) !== "") hits++;
      if (hits > bestHits) {
        bestHits = hits;
        bestOff = d;
      }
    }
    if (bestOff !== 0 && bestHits >= alignThreshold) {
      C[key] = c + bestOff;
      claimed.add(c + bestOff);
    } else {
      claimed.add(c);
    }
  }

  // ---- summary block above the header ---------------------------------------
  const title = grid
    .slice(0, headerIdx)
    .map((r) => r.map(txt).join(" ").replace(/[∑Σ]/g, "").trim())
    .find((s) => s.length > 3) ?? "";
  let reportedDefQty: number | null = null;
  let reportedQtyCheck: number | null = null;
  let reportedDpm: number | null = null;

  // The summary sits on the row labelled "DPM": <defects> <qty checked> DPM <dpm>
  for (let i = 0; i < headerIdx; i++) {
    const r = grid[i].map((v) => (typeof v === "number" ? v : txt(v)));
    const dpmAt = r.findIndex((c) => txt(c).toUpperCase() === "DPM");
    if (dpmAt < 0) continue;
    const after = r.slice(dpmAt + 1).map(num).filter((n) => n > 0);
    if (after.length) reportedDpm = after[0];
    // the two figures before the DPM label are total defects and total qty
    // checked; a stray column after the DPM value is not part of the pair
    const before = r.slice(0, dpmAt).map(num).filter((n) => n > 0).sort((a, b) => a - b);
    if (before.length >= 2) {
      reportedDefQty = before[0];
      reportedQtyCheck = before[before.length - 1];
    } else {
      const ints = [...before, ...after.slice(1)].sort((a, b) => a - b);
      if (ints.length >= 2) {
        reportedDefQty = ints[0];
        reportedQtyCheck = ints[ints.length - 1];
      }
    }
    break;
  }

  // ---- reporting month -------------------------------------------------------
  // `name` lives on File.prototype, so "name" in file is the correct test here.
  const fileName = "name" in file ? (file as File).name : "";
  let month: string | null = detectIpqcMonth(fileName);
  const monthLabels = new Set<string>();
  for (let i = headerIdx + 1; i < grid.length; i++) {
    if (C.month >= 0) {
      const v = txt(grid[i]?.[C.month]).toUpperCase();
      if (v && MONTHS[v] !== undefined) monthLabels.add(v);
    }
  }
  const firstMonthLabel = [...monthLabels][0];
  if (!month) {
    // fall back to the MONTHLY column, using the newest year we can infer
    const year = new Date().getFullYear();
    if (firstMonthLabel) month = `${year}-${String(MONTHS[firstMonthLabel]).padStart(2, "0")}`;
    else warnings.push("Could not determine the reporting month; defaulted to the current month.");
  }
  if (!month) month = new Date().toISOString().slice(0, 7);
  const monthLabel =
    firstMonthLabel ?? MONTH_ABBR[Number(month.split("-")[1]) - 1]?.toUpperCase() ?? "";

  // ---- data rows -------------------------------------------------------------
  const rows: IpqcRow[] = [];
  // forward-filled context
  let fDate = "";
  let fMonth = "";
  let fCcw = "";
  let fShift = "";
  let fMachine = "";
  let fLead = "";
  let fTag = "";
  let fModel = "";
  let fDefect = "";
  let fRemark = "";
  let fAction = "";
  let dateWarned = false;

  // The main table ends at the last row that carries a DATE. Everything after
  // it is trailing padding: machine-position rows with no date, then a machine
  // name lookup list. Some months also append a second, unrelated table.
  let lastDateIdx = headerIdx;
  for (let i = headerIdx + 1; i < grid.length; i++) {
    if (C.date >= 0 && txt(grid[i]?.[C.date]) !== "") lastDateIdx = i;
  }

  for (let i = headerIdx + 1; i <= lastDateIdx; i++) {
    const r = grid[i] ?? [];
    const noCell = C.no >= 0 ? txt(r[C.no]) : "";
    const dateCell = C.date >= 0 ? txt(r[C.date]) : "";
    const defCell = txt(r[C.defQty]);
    const chkCell = C.qtyCheck >= 0 ? txt(r[C.qtyCheck]) : "";
    // A data row is anything carrying a sequence number, its own date, or a
    // quantity. A fair number of inspection rows are left unnumbered, so
    // requiring NO. would silently drop them. The trailing machine-name lookup
    // list has none of these and is correctly ignored.
    const numbered = /^\d+$/.test(noCell);
    if (!numbered && !dateCell && !defCell && !chkCell) continue;

    if (dateCell) {
      const parsed = parseDay(dateCell, month);
      if (parsed) {
        fDate = parsed;
      } else {
        if (!dateWarned) {
          warnings.push(`Unrecognised date "${dateCell}" — skipped.`);
          dateWarned = true;
        }
        continue;
      }
    }
    if (C.month >= 0) { const v = txt(r[C.month]); if (v) fMonth = v; }
    if (C.ccw >= 0) { const v = txt(r[C.ccw]); if (v) fCcw = v; }
    if (C.shift >= 0) { const v = txt(r[C.shift]); if (v) fShift = v; }
    if (C.machine >= 0) { const v = txt(r[C.machine]); if (v) fMachine = v; }
    if (C.lead >= 0) { const v = txt(r[C.lead]); if (v) fLead = v; }
    if (C.tag >= 0) { const v = txt(r[C.tag]); if (v) fTag = v; }
    if (C.model >= 0) { const v = txt(r[C.model]); if (v) fModel = v; }
    if (C.defect >= 0) { const v = txt(r[C.defect]); if (v) fDefect = v; }
    if (C.remark >= 0) { const v = txt(r[C.remark]); if (v) fRemark = v; }
    if (C.action >= 0) { const v = txt(r[C.action]); if (v) fAction = v; }

    const defQty = num(defCell);
    const qtyCheck = num(chkCell);
    // An inspection starts on any row carrying a quantity. Most groups are
    // marked by DEF QTY, but a handful record only a QTY-CHECK, and rows with
    // both blank are just machine/position detail for the group above.
    const isInspection = defCell !== "" || chkCell !== "";

    rows.push({
      no: numbered ? Number(noCell) : 0, // 0 = present but unnumbered in the sheet
      date: fDate,
      month,
      ccw: fCcw,
      monthLabel: fMonth,
      shift: fShift,
      machine: fMachine,
      leadCode: fLead,
      rejectTag: fTag,
      model: fModel,
      defectType: fDefect,
      defQty: isInspection ? defQty : 0,
      qtyCheck: isInspection ? qtyCheck : 0,
      remark: fRemark,
      action: fAction,
      isInspection,
    });
  }

  if (rows.length === 0) throw new Error("No IPQC data rows found");

  // ---- aggregates ------------------------------------------------------------
  const inspections = rows.filter((r) => r.isInspection);
  const defQty = rows.reduce((s, r) => s + r.defQty, 0);
  const qtyCheck = rows.reduce((s, r) => s + r.qtyCheck, 0);
  const dpm = qtyCheck > 0 ? (defQty / qtyCheck) * 1_000_000 : 0;

  const key = (d: string, m: string) => `${d}::${m.toUpperCase()}`;
  const map = new Map<string, IpqcAgg & { defectQty: Map<string, number> }>();
  for (const r of rows) {
    if (!r.machine) continue;
    const k = key(r.date, r.machine);
    let a = map.get(k);
    if (!a) {
      a = {
        date: r.date, month: r.month, machine: r.machine, shift: r.shift,
        qtyCheck: 0, defQty: 0, dpm: 0, rejectRatePct: 0, inspections: 0,
        positions: 0, leadCodes: [], topDefect: "", topDefectQty: 0,
        defectQty: new Map(),
      };
      map.set(k, a);
    }
    // every row counts as an inspected position, so machines that were checked
    // but produced no defects still show up
    a.positions += 1;
    if (!r.isInspection) continue;
    a.qtyCheck += r.qtyCheck;
    a.defQty += r.defQty;
    if (r.leadCode && !a.leadCodes.includes(r.leadCode)) a.leadCodes.push(r.leadCode);
    if (r.defectType) {
      a.inspections += 1;
      const next = (a.defectQty.get(r.defectType) ?? 0) + r.defQty;
      a.defectQty.set(r.defectType, next);
      if (next > a.topDefectQty) {
        a.topDefectQty = next;
        a.topDefect = r.defectType;
      }
    }
  }

  const aggs: IpqcAgg[] = [...map.values()].map(({ defectQty, ...a }) => ({
    ...a,
    dpm: a.qtyCheck > 0 ? (a.defQty / a.qtyCheck) * 1_000_000 : 0,
    rejectRatePct: a.qtyCheck > 0 ? (a.defQty / a.qtyCheck) * 100 : 0,
    leadCodes: a.leadCodes.sort(),
  }));
  aggs.sort((a, b) => a.date.localeCompare(b.date) || a.machine.localeCompare(b.machine));

  // ---- cross-checks ----------------------------------------------------------
  // These workbooks carry a hand-maintained summary block, and in several months
  // it is stale (April's title still says FEBRUARY, August's says JULY). So a
  // disagreement is reported as advisory, not treated as a parse failure.
  const notes: string[] = [];
  if (reportedDefQty !== null && reportedDefQty > 0 && Math.abs(reportedDefQty - defQty) > 0.5) {
    notes.push(
      `total defects ${fmtInt(defQty)} vs ${fmtInt(reportedDefQty)} in the sheet's summary`
    );
  }
  if (reportedQtyCheck !== null && reportedQtyCheck > 0 && Math.abs(reportedQtyCheck - qtyCheck) > 0.5) {
    notes.push(
      `total qty checked ${fmtInt(qtyCheck)} vs ${fmtInt(reportedQtyCheck)} in the sheet's summary`
    );
  }
  if (reportedDpm !== null && reportedDpm > 0 && dpm > 0) {
    const drift = Math.abs(reportedDpm - dpm) / reportedDpm;
    if (drift > 0.02) {
      notes.push(`DPM ${dpm.toFixed(2)} vs ${reportedDpm.toFixed(2)} in the sheet's summary`);
    }
  }
  if (notes.length) {
    warnings.push(
      "Figures below are computed from the data rows. The workbook's own summary " +
        "block disagrees (" + notes.join("; ") + ") — the summary may be stale."
    );
  }

  return {
    fileName: fileName || "workbook",
    month,
    monthLabel,
    title,
    rows,
    aggs,
    machines: [...new Set(rows.map((r) => r.machine).filter(Boolean))].sort(),
    shifts: [...new Set(rows.map((r) => r.shift).filter(Boolean))].sort(),
    defectTypes: [...new Set(rows.map((r) => r.defectType).filter(Boolean))].sort(),
    totals: {
      rows: rows.length,
      inspections: inspections.length,
      defQty,
      qtyCheck,
      dpm,
    },
    reportedDpm,
    reportedDefQty,
    reportedQtyCheck,
    warnings,
  };
}
