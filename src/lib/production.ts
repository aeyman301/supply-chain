/** OEE maths and rollups for the production dashboard.
 *
 * OEE = Availability x Performance x Quality, expressed as a fraction.
 * Each component is stored as a percentage (0-100) so operators can key it in
 * directly; a PLC integration will later supply the same three numbers derived
 * from run time, cycle counts and reject counts. */

import type { ProdDaily } from "../types";

export const OEE_TARGET_PCT = 85;

export interface OeeBreakdown {
  availabilityPct: number;
  performancePct: number;
  qualityPct: number;
  oeePct: number;
}

/** Clamp a percentage into 0-100 and drop non-numeric junk. */
export function clampPct(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

export function computeOee(d: Pick<ProdDaily, "availabilityPct" | "performancePct" | "qualityPct">): OeeBreakdown {
  const availabilityPct = clampPct(d.availabilityPct);
  const performancePct = clampPct(d.performancePct);
  const qualityPct = clampPct(d.qualityPct);
  return {
    availabilityPct,
    performancePct,
    qualityPct,
    oeePct: (availabilityPct / 100) * (performancePct / 100) * (qualityPct / 100) * 100,
  };
}

export interface ProdTotals {
  totalOutput: number;
  rejectQty: number;
  plannedQty: number;
  avgOeePct: number;
  attainmentPct: number;
  rejectRatePct: number;
  downtimeMin: number;
  records: number;
  /** Rows that carry a planned figure — the only ones attainment is measured over. */
  plannedRecords: number;
  /** Output from rows with no plan. Excluded from attainment, disclosed so it is not hidden. */
  unplannedOutput: number;
}

/**
 * Roll a set of daily records up to a period total.
 *
 * Total Output sums. OEE is averaged as a straight mean of the per-record
 * figures, which is the convention used on a shop-floor board. When daily
 * output differs a lot, a target-weighted mean is fairer; switch to it by
 * weighting each record's OEE by its totalOutput.
 *
 * Attainment is deliberately computed over planned rows only. Summing every
 * row's output against the sum of the planned figures would let output from
 * unplanned machines inflate the ratio past 100%, so that output is returned
 * separately as `unplannedOutput` instead of being quietly counted.
 */
export function rollup(rows: ProdDaily[]): ProdTotals {
  const totalOutput = rows.reduce((s, r) => s + num(r.totalOutput), 0);
  const rejectQty = rows.reduce((s, r) => s + num(r.rejectQty), 0);
  const plannedQty = rows.reduce((s, r) => s + num(r.plannedQty), 0);
  const downtimeMin = rows.reduce((s, r) => s + num(r.downtimeMin), 0);
  const avgOeePct = rows.length
    ? rows.reduce((s, r) => s + computeOee(r).oeePct, 0) / rows.length
    : 0;

  const plannedOutput = rows.reduce(
    (s, r) => s + (num(r.plannedQty) > 0 ? num(r.totalOutput) : 0),
    0
  );

  return {
    totalOutput,
    rejectQty,
    plannedQty,
    avgOeePct,
    attainmentPct: plannedQty > 0 ? (plannedOutput / plannedQty) * 100 : 0,
    rejectRatePct: totalOutput + rejectQty > 0 ? (rejectQty / (totalOutput + rejectQty)) * 100 : 0,
    downtimeMin,
    records: rows.length,
    plannedRecords: rows.filter((r) => num(r.plannedQty) > 0).length,
    unplannedOutput: totalOutput - plannedOutput,
  };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function oeeTone(oeePct: number): "ok" | "warn" | "danger" {
  if (oeePct >= OEE_TARGET_PCT) return "ok";
  if (oeePct >= 65) return "warn";
  return "danger";
}

/**
 * Quality as a percentage, derived from an imported IPQC record.
 *
 * IPQC is the source of truth for quality: defects found over quantity checked.
 * Returns null when the record has no meaningful sample size, so the caller can
 * fall back rather than reporting a bogus 100%.
 */
export function qualityFromIpqc(defQty: unknown, qtyCheck: unknown): number | null {
  const checked = Number(qtyCheck);
  if (!Number.isFinite(checked) || checked <= 0) return null;
  const defects = Number(defQty);
  const d = Number.isFinite(defects) ? defects : 0;
  return clampPct(100 - (d / checked) * 100);
}

/** Index imported IPQC records by `DATE::MACHINE` for OEE lookups. */
export function indexIpqcByLine<T extends { date: string; machine: string }>(
  rows: T[]
): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) m.set(ipqcKey(r.date, r.machine), r);
  return m;
}

/**
 * Collapse the spelling drift seen across the IPQC workbooks into one machine.
 *
 * The same physical machine is written several ways — "CM 20-03" and "CM20-03",
 * "BD HW32-01" and "BD HW32-1" — so keying OEE on the raw string would split one
 * machine's output and defects across several rows.
 *
 * Only whitespace and leading zeros are normalised. Trailing digits are left
 * alone so genuinely distinct machines (AC90-1 … AC90-8) stay separate.
 */
export function canonMachine(machine: string): string {
  return (machine ?? "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/\d+/g, (n) => n.replace(/^0+(?=\d)/, ""));
}

export function ipqcKey(date: string, machine: string): string {
  return `${date}::${canonMachine(machine)}`;
}

export function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/** Last n days as YYYY-MM-DD, oldest first, anchored on `end`. */
export function lastNDays(n: number, end = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
