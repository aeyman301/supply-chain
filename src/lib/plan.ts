import type { ProdPlanGroup } from "../types";
import { canonMachine } from "./production";

/**
 * Machine codes drift between the downtime log and the OEE rows ("AC90-1",
 * "AC90-01", "ac90 1", bare "AC90"), so groups match on a prefix of the
 * canonical name rather than an exact code. Longest match wins, so a narrower
 * group such as "AC90-0" can shadow a broader "AC90".
 */
export function planGroupFor(
  groups: ProdPlanGroup[],
  machine: string
): ProdPlanGroup | null {
  const m = canonMachine(machine);
  if (!m) return null;
  let best: ProdPlanGroup | null = null;
  for (const g of groups) {
    const p = (g.match ?? "").trim().toUpperCase();
    if (!p) continue;
    if (m !== p && !m.startsWith(p)) continue;
    if (!best || p.length > (best.match ?? "").trim().toUpperCase().length) best = g;
  }
  return best;
}

/** Distinct canonical machines covered by a group within `machines`. */
export function planGroupMachines(group: ProdPlanGroup, machines: string[]): string[] {
  const p = (group.match ?? "").trim().toUpperCase();
  const set = new Set<string>();
  for (const raw of machines) {
    const m = canonMachine(raw);
    if (!m) continue;
    if (m === p || m.startsWith(p)) set.add(m);
  }
  return [...set].sort();
}

/**
 * The plan figure to use for one machine-day.
 *
 * A per-machine figure is returned as-is. A whole-group figure is divided by
 * the number of distinct machines the group covers, so the group's total plan
 * is preserved no matter how many of its machines ran that day.
 */
export function resolvePlanQty(
  groups: ProdPlanGroup[],
  machine: string,
  groupMachineCount: number
): number {
  const g = planGroupFor(groups, machine);
  if (!g || !(g.plannedQty > 0)) return 0;
  if (g.perMachine) return g.plannedQty;
  const n = Math.max(1, groupMachineCount);
  return Math.round((g.plannedQty / n) * 100) / 100;
}

/**
 * Seed plan groups the user has already supplied figures for.
 *
 * CM matches the whole line rather than CM20 only: the downtime log carries a
 * bare "CM" plus CM40/CM40-01 alongside the CM20 machines. Group figures are
 * left on "each machine" because the user confirmed 13,600 is the target for
 * each individual AC90 and each individual AC95 — not a family total.
 */
export const DEFAULT_PLAN_GROUPS: ProdPlanGroup[] = [
  { id: "plan-ac90", label: "AC90", match: "AC90", plannedQty: 13600, perMachine: true, order: 0 },
  { id: "plan-ac95", label: "AC95", match: "AC95", plannedQty: 13600, perMachine: true, order: 1 },
  { id: "plan-cm", label: "CM", match: "CM", plannedQty: 6000, perMachine: true, order: 2 },
  { id: "plan-joint", label: "Joint", match: "JOINT", plannedQty: 0, perMachine: true, order: 3 },
  { id: "plan-twist", label: "Twist (3 machines)", match: "TWIST", plannedQty: 5000, perMachine: true, order: 4 },
];
