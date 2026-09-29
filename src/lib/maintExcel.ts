import * as XLSX from "xlsx";
import type { MaintPart } from "../types";
import { num, str } from "./format";

export interface MaintParseResult {
  parts: MaintPart[];
  warnings: string[];
}

const MONTH_NAMES: Record<string, number> = {
  JANUARY: 1, JAN: 1,
  FEBRUARY: 2, FEB: 2,
  MARCH: 3, MAR: 3,
  APRIL: 4, APR: 4,
  MAY: 5,
  JUNE: 6, JUN: 6,
  JULY: 7, JUL: 7,
  AUGUST: 8, AUG: 8,
  SEPTEMBER: 9, SEPT: 9, SEP: 9,
  OCTOBER: 10, OCT: 10,
  NOVEMBER: 11, NOV: 11,
  DECEMBER: 12, DEC: 12,
};

/**
 * Usage months are mapped from the HEADER row ("QUANTITY USED JAN" etc.).
 * Year assignment: the workbook has a year-marker row above the header (e.g. a
 * cell containing 2023 above the first usage block, 2024 above the next, …).
 * Each usage column takes the nearest year marker at or before its column.
 * Columns before the first marker use PERIOD-year-derived months walking
 * backwards from the newest column (which belongs to the PERIOD year).
 */
function parseUsageColumns(
  headerRow: unknown[],
  dataRow: unknown[],
  markerRow: unknown[] | null,
  periodYear: number
): { usage: Record<string, number> } {
  const cols: { col: number; month: number }[] = [];
  for (let c = 0; c < headerRow.length; c++) {
    const s = str(headerRow[c]).toUpperCase();
    const m = /^QUANTITY\s+USED\s+([A-Z]{3,9})$/.exec(s);
    if (m) {
      const mon = MONTH_NAMES[m[2]];
      if (mon) cols.push({ col: c, month: mon });
    }
  }
  if (cols.length === 0) return { usage: {} };

  // year for each usage column: nearest year marker at or before that column —
  // but the LAST usage column (newest) always belongs to the PERIOD year, and any
  // unmarked tail columns after the last marked block continue sequentially from
  // the newest marked column.
  const lastMarkerCol: number | null = (() => {
    if (!markerRow) return null;
    let best: number | null = null;
    for (let c = 0; c < markerRow.length; c++) {
      const s = str(markerRow[c]);
      if (/^20\d{2}$/.test(s)) best = c;
    }
    return best;
  })();
  const lastMarkerYear: number | null = lastMarkerCol !== null ? num(markerRow?.[lastMarkerCol]) : null;
  const firstCol = cols[0].col;
  const lastCol = cols[cols.length - 1].col;

  // sequential walk-back from the newest column as baseline
  const yearOfIndex = new Array(cols.length);
  let y = periodYear;
  let prevMonth = cols[cols.length - 1].month;
  for (let i = cols.length - 1; i >= 0; i--) {
    if (i !== cols.length - 1 && cols[i].month > prevMonth) y -= 1;
    yearOfIndex[i] = y;
    prevMonth = cols[i].month;
  }

  const usage: Record<string, number> = {};
  for (let i = 0; i < cols.length; i++) {
    const { col, month } = cols[i];
    let year: number;
    if (col === lastCol) {
      year = periodYear; // newest column = PERIOD year
    } else if (
      lastMarkerCol !== null &&
      lastMarkerYear !== null &&
      col >= firstCol &&
      col < lastMarkerCol
    ) {
      // inside the marked blocks: nearest marker at or before the column
      let best: number | null = null;
      for (let c = 0; c <= col && c < (markerRow?.length ?? 0); c++) {
        const s = str(markerRow?.[c]);
        if (/^20\d{2}$/.test(s)) best = Number(s);
      }
      year = best ?? yearOfIndex[i];
    } else if (lastMarkerCol !== null && lastMarkerYear !== null) {
      // tail block after the last marker: continue sequentially from that marker's year
      let lastMarkedMonth = 12;
      for (let c = lastMarkerCol; c >= 0; c--) {
        const m = /^QUANTITY\s+USED\s+([A-Z]{3,9})$/.exec(
          str(headerRow[c]).toUpperCase()
        );
        if (m && MONTH_NAMES[m[1]]) {
          lastMarkedMonth = MONTH_NAMES[m[1]];
          break;
        }
      }
      year = month <= lastMarkedMonth ? lastMarkerYear + 1 : lastMarkerYear;
    } else {
      year = yearOfIndex[i];
    }
    const ym = `${year}-${String(month).padStart(2, "0")}`;
    const q = num(dataRow[col]);
    if (q > 0) usage[ym] = (usage[ym] ?? 0) + q;
  }
  return { usage };
}

function findPeriod(rows: unknown[][]): { year: number; month: number } {
  const now = new Date();
  for (const row of rows.slice(0, 6)) {
    for (const v of row) {
      // first date like 01/08/2026 in the title = period start
      const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(str(v));
      if (m) return { year: Number(m[3]), month: Number(m[2]) };
    }
  }
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

/** Parse stock values like 12, "14 PCS", "3 BOX" -> numeric qty */
function parseStockQty(v: unknown): number {
  const s = str(v);
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isNaN(n)) return n;
  const m = /(\d+(?:\.\d+)?)/.exec(s);
  return m ? Number(m[1]) : 0;
}

interface SheetSpec {
  keys: string[]; // sheet name match (exact-ish, trimmed)
  category: string;
  headerRow: number; // 1-based
  cols: {
    name: number[];
    partNo?: number[];
    model?: number[];
    location?: number[];
    supplier?: number[];
    min?: number[];
    max?: number[];
    current?: number[];
    qtyToOrder?: number[];
    price?: number[];
    remarks?: number[];
  };
}

const SPECS: SheetSpec[] = [
  {
    keys: ["SPAREPART MACHINE"],
    category: "MACHINE",
    headerRow: 7,
    cols: {
      name: [1], partNo: [2], model: [3], location: [5], supplier: [6],
      min: [7], max: [8], current: [46], qtyToOrder: [48], price: [49], remarks: [50],
    },
  },
  {
    keys: ["SPAREPART APPLICATOR"],
    category: "APPLICATOR",
    headerRow: 8,
    cols: {
      name: [2], partNo: [3], location: [5], supplier: [4],
      min: [6], max: [7], current: [25], qtyToOrder: [27], price: [28], remarks: [34],
    },
  },
  {
    keys: ["POLE STOCK (IE)"],
    category: "POLE (IE)",
    headerRow: 6,
    cols: {
      name: [2], partNo: [3], model: [4],
      min: [5], max: [6], current: [46], qtyToOrder: [47], price: [48], remarks: [49],
    },
  },
  {
    keys: ["SPARE PART BANDGUN (IE)"],
    category: "BANDGUN (IE)",
    headerRow: 7,
    cols: {
      name: [2], partNo: [3], model: [4],
      min: [5], max: [6], current: [48], qtyToOrder: [49], price: [50], remarks: [51],
    },
  },
  {
    keys: ["FACILITIES"],
    category: "FACILITIES",
    headerRow: 6,
    cols: {
      name: [2], model: [4], location: [5],
      min: [6], max: [7], current: [20], qtyToOrder: [21], price: [23], remarks: [24],
    },
  },
  {
    keys: ["PRINTFACILITIES"],
    category: "PRINT FACILITIES",
    headerRow: 6,
    cols: {
      name: [2], location: [4], supplier: [22],
      min: [5], max: [6], current: [20], qtyToOrder: [21], price: [23], remarks: [24],
    },
  },
  {
    keys: ["RAW MATERIAL (IE)"],
    category: "RAW MATERIAL (IE)",
    headerRow: 6,
    cols: {
      name: [2], partNo: [3], model: [4],
      min: [6], max: [7], current: [48], qtyToOrder: [49], price: [50], remarks: [51],
    },
  },
];

function pick(row: unknown[], candidates: number[] | undefined): unknown {
  if (!candidates) return undefined;
  for (const c of candidates) {
    const v = row[c];
    if (v !== null && v !== undefined && v !== "") return v;
  }
  return undefined;
}

/** Detect the snapshot month from a maintenance workbook filename (e.g. "SEPT 2026"). */
export function detectSnapshotMonth(filename: string): string {
  const up = filename.toUpperCase();
  const re =
    /\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER|JAN|FEB|MAR|APR|JUN|JUL|AUG|SEPT|SEP|OCT|NOV|DEC)\s*,?\s*(\d{4})\b/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(up))) {
    const mon = MONTH_NAMES[m[1]];
    if (mon) last = `${m[2]}-${String(mon).padStart(2, "0")}`;
  }
  if (last) return last;
  const m2 = /^(\d{1,2})\.\s/.exec(filename.trim());
  const y = up.match(/(20\d{2})/);
  if (m2 && y) {
    const mon = Number(m2[1]);
    if (mon >= 1 && mon <= 12) return `${y[1]}-${String(mon).padStart(2, "0")}`;
  }
  return new Date().toISOString().slice(0, 7);
}

export async function parseMaintenanceWorkbook(
  file: File,
  fallbackMonth?: string
): Promise<MaintParseResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { cellDates: true });
  const warnings: string[] = [];
  const parts: MaintPart[] = [];

  // The workbook title dates can be stale (e.g. "DATE :17/01/2024" on a Sept-2026
  // sheet). The filename month is the most trustworthy anchor for usage-year mapping.
  const fileMonth = fallbackMonth ?? detectSnapshotMonth(file.name);
  const fileYear = Number(fileMonth.slice(0, 4));

  for (const spec of SPECS) {
    const sheetName = wb.SheetNames.find(
      (n) => spec.keys.some((k) => n.trim().toUpperCase().includes(k)) && !n.includes("(2)")
    );
    if (!sheetName) {
      warnings.push(`Sheet matching "${spec.keys[0]}" not found — skipped.`);
      continue;
    }
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      header: 1,
      defval: null,
    });
    const sheetPeriod = findPeriod(rows);
    // trust the filename month when the sheet's own title date is stale
    const period =
      sheetPeriod.year < fileYear ? { year: fileYear, month: Number(fileMonth.slice(5, 7)) } : sheetPeriod;
    const headerRowCells = rows[spec.headerRow - 1] ?? [];
    // year markers usually sit 1-2 rows above the header (e.g. "2023 | 2024 | 2025")
    const markerRow =
      rows[spec.headerRow - 2] ??
      rows[spec.headerRow - 3] ??
      null;

    for (let i = spec.headerRow; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const name = str(pick(row, spec.cols.name));
      if (!name) continue;
      // sheet layouts differ: row numbers live in col 0 (MACHINE, POLE) or col 1 (others)
      const noCell = str(row[0]) || str(row[1]);
      if (!/^\d+$/.test(noCell)) continue; // skip subtotal/blank separator rows

      const current = parseStockQty(pick(row, spec.cols.current));
      const min = num(pick(row, spec.cols.min));
      const max = num(pick(row, spec.cols.max));
      const { usage } = parseUsageColumns(headerRowCells, row, markerRow, period.year);
      const usageAny = Object.values(usage).some((v) => v > 0);
      if (!name && !usageAny && current === 0 && min === 0) continue;

      parts.push({
        category: spec.category,
        no: noCell,
        name,
        partNo: str(pick(row, spec.cols.partNo)) || name,
        machineModel: str(pick(row, spec.cols.model)),
        location: str(pick(row, spec.cols.location)),
        supplier: str(pick(row, spec.cols.supplier)),
        minStock: min,
        maxStock: max,
        currentStock: current,
        qtyToOrder: num(pick(row, spec.cols.qtyToOrder)),
        price: num(pick(row, spec.cols.price)),
        remarks: str(pick(row, spec.cols.remarks)),
        usage,
        monthStock: {},
        updatedAt: Date.now(),
      });
    }
  }

  if (parts.length === 0)
    warnings.push("No spare parts parsed. Check that this is the Maintenance stock workbook.");

  return { parts, warnings };
}
