import type { MaintPart } from "../types";

const MONTHS: Record<string, number> = {
  JAN: 1, JANUARY: 1,
  FEB: 2, FEBRUARY: 2,
  MAR: 3, MARCH: 3,
  APR: 4, APRIL: 4,
  MAY: 5,
  JUN: 6, JUNE: 6,
  JUL: 7, JULY: 7,
  AUG: 8, AUGUST: 8,
  SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OCT: 10, OCTOBER: 10,
  NOV: 11, NOVEMBER: 11,
  DEC: 12, DECEMBER: 12,
};

/** Detect the snapshot month (YYYY-MM) from a maintenance workbook filename
 * e.g. "9. STOCK SEPT 2026 STOCK MAINTENANCE & IE REV 02.xlsx" -> "2026-09".
 * Falls back to the current month. */
export function detectSnapshotMonth(filename: string): string {
  const up = filename.toUpperCase();
  const re = /\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPT?EMBER|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER|JAN|FEB|MAR|APR|JUN|JUL|AUG|SEPT|SEP|OCT|NOV|DEC)\s*,?\s*(\d{4})\b/g;
  let m: RegExpExecArray | null;
  let last: { ym: string; idx: number } | null = null;
  while ((m = re.exec(up))) {
    const mon = MONTHS[m[1]];
    if (!mon) continue;
    last = { ym: `${m[2]}-${String(mon).padStart(2, "0")}`, idx: m.index };
  }
  if (last) return last.ym;

  // fallback: leading "9." style month number + a year anywhere in the name
  const m2 = /^(\d{1,2})\.\s/.exec(filename.trim());
  const y = up.match(/(20\d{2})/);
  if (m2 && y) {
    const mon = Number(m2[1]);
    if (mon >= 1 && mon <= 12) return `${y[1]}-${String(mon).padStart(2, "0")}`;
  }
  return new Date().toISOString().slice(0, 7);
}

export interface MergeOutcome {
  add: MaintPart[];
  update: { id: string; rec: MaintPart }[];
  updatedCount: number;
  addedCount: number;
}

/**
 * Merge a monthly maintenance workbook into the existing parts list.
 * Parts are matched by category + partNo (same physical part = updated in place,
 * never duplicated). The current stock is snapshotted under `month`.
 */
export function mergeMaintImport(
  existing: (MaintPart & { id?: string })[],
  incoming: MaintPart[],
  month: string
): MergeOutcome {
  const keyOf = (p: { category: string; partNo: string; name: string }) =>
    `${p.category}::${(p.partNo || p.name).trim().toUpperCase()}`;

  const byKey = new Map<string, MaintPart & { id?: string }>();
  for (const p of existing) byKey.set(keyOf(p), p);

  const seen = new Set<string>();
  const out: MergeOutcome = { add: [], update: [], updatedCount: 0, addedCount: 0 };

  for (const inc of incoming) {
    const key = keyOf(inc);
    seen.add(key);
    const prev = byKey.get(key);
    if (prev && prev.id) {
      const rec: MaintPart = {
        ...prev,
        no: inc.no || prev.no,
        name: inc.name || prev.name,
        machineModel: inc.machineModel || prev.machineModel,
        location: inc.location || prev.location,
        supplier: inc.supplier || prev.supplier,
        minStock: inc.minStock || prev.minStock,
        maxStock: inc.maxStock || prev.maxStock,
        currentStock: inc.currentStock,
        qtyToOrder: inc.qtyToOrder,
        price: inc.price || prev.price,
        remarks: inc.remarks || prev.remarks,
        usage: { ...prev.usage, ...inc.usage }, // newest file wins on overlapping months
        monthStock: { ...(prev.monthStock ?? {}), [month]: inc.currentStock },
        updatedAt: Date.now(),
      };
      out.update.push({ id: prev.id, rec });
      out.updatedCount++;
    } else {
      out.add.push({
        ...inc,
        monthStock: { ...(inc.monthStock ?? {}), [month]: inc.currentStock },
      });
      out.addedCount++;
    }
  }

  // parts that disappeared from the newest file are kept (historical), but their
  // latest stock snapshot for this month is marked 0 only if they had one before —
  // simplest: leave untouched.
  void seen;
  return out;
}
