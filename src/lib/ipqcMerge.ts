/** Merge IPQC workbook results into Firebase, following the same month-aware
 * pattern as the maintenance import: a re-import of the same month replaces
 * that month rather than accumulating duplicates. */

import type { IpqcAgg, IpqcParseResult } from "./ipqcExcel";

export interface IpqcDailyRec extends IpqcAgg {
  id?: string;
  key: string; // `${date}::${machine}`
  source: "XLS";
}

export interface IpqcMergePlan {
  /** keys already in Firebase that this month replaces */
  replaceKeys: string[];
  /** records to write */
  upserts: IpqcDailyRec[];
  /** records present in Firebase for this month that are gone from the workbook */
  staleKeys: string[];
  counts: { replaced: number; added: number; removed: number };
}

const keyOf = (date: string, machine: string) =>
  `${date}::${machine.trim().toUpperCase()}`;

export function planIpqcMerge(
  parsed: IpqcParseResult,
  existing: IpqcDailyRec[]
): IpqcMergePlan {
  const month = parsed.month;
  const inMonth = existing.filter((r) => r.month === month);
  const existingByKey = new Map(inMonth.map((r) => [r.key, r]));

  const upserts: IpqcDailyRec[] = [];
  const seen = new Set<string>();

  for (const a of parsed.aggs) {
    const key = keyOf(a.date, a.machine);
    seen.add(key);
    upserts.push({ ...a, key, source: "XLS" });
  }

  const staleKeys = inMonth
    .map((r) => r.key)
    .filter((k) => !seen.has(k));

  return {
    replaceKeys: [...seen],
    upserts,
    staleKeys,
    counts: {
      replaced: upserts.length - Math.max(0, upserts.length - [...seen].filter((k) => existingByKey.has(k)).length),
      added: [...seen].filter((k) => !existingByKey.has(k)).length,
      removed: staleKeys.length,
    },
  };
}

/** Roll daily aggregates up to a period total, mirroring the production
 *  dashboard's shape so the two views agree. */
export interface IpqcTotals {
  qtyCheck: number;
  defQty: number;
  dpm: number;
  rejectRatePct: number;
  machineDays: number;
}

export function ipqcRollup(rows: IpqcDailyRec[]): IpqcTotals {
  const qtyCheck = rows.reduce((s, r) => s + num(r.qtyCheck), 0);
  const defQty = rows.reduce((s, r) => s + num(r.defQty), 0);
  return {
    qtyCheck,
    defQty,
    dpm: qtyCheck > 0 ? (defQty / qtyCheck) * 1_000_000 : 0,
    rejectRatePct: qtyCheck > 0 ? (defQty / qtyCheck) * 100 : 0,
    machineDays: rows.length,
  };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
