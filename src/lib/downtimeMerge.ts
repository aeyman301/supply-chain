/** Downtime records, aggregation, and the OEE availability they imply.
 *
 * Mirrors the month-aware import pattern used for the IPQC and maintenance
 * workbooks: a re-import of a month replaces that month rather than
 * accumulating duplicates. */

import type { DowntimeEvent, DowntimeMonthMeta } from "./downtimeExcel";
import { canonMachine, clampPct, ipqcKey } from "./production";

export interface DowntimeRec extends DowntimeEvent {
  id?: string;
  /** `${date}::${machine}::${seq}` — stable across re-imports of the same month */
  key: string;
  source: "XLS";
}

export interface DowntimeMonthRec extends DowntimeMonthMeta {
  id?: string;
  key: string;
  source: "XLS";
}

export interface DowntimeMergePlan {
  upserts: DowntimeRec[];
  staleKeys: string[];
  metaUpserts: DowntimeMonthRec[];
  counts: {
    replaced: number;
    added: number;
    removed: number;
    meta: number;
    metaAdded: number;
    metaUpdated: number;
  };
}

/**
 * Minutes of loading time one machine gets in one day, from the sheet's own
 * "Normal working hr" and "Shift". Falls back to a single 9-hour shift, which
 * is what every sheet in the current workbook states.
 */
export const DEFAULT_BASIS_MIN = 9 * 60;

export function basisForMonth(meta: DowntimeMonthRec | undefined): number {
  const b = meta?.basisMinPerMachineDay ?? 0;
  return b > 0 ? b : DEFAULT_BASIS_MIN;
}

export function planDowntimeMerge(
  events: DowntimeEvent[],
  meta: DowntimeMonthMeta[],
  existing: DowntimeRec[],
  existingMeta: DowntimeMonthRec[]
): DowntimeMergePlan {
  const months = new Set([...events.map((e) => e.month), ...meta.map((m) => m.month)]);
  const inScope = (m: string) => months.has(m);

  // sequence per machine-day so a re-import reproduces the same keys
  const seq = new Map<string, number>();
  const upserts: DowntimeRec[] = [];
  for (const e of events) {
    const k = `${e.date}::${canonMachine(e.machine)}`;
    const n = (seq.get(k) ?? 0) + 1;
    seq.set(k, n);
    upserts.push({ ...e, key: `${k}::${n}`, source: "XLS" });
  }

  const seen = new Set(upserts.map((u) => u.key));
  const staleKeys = existing
    .filter((r) => inScope(r.month))
    .map((r) => r.key)
    .filter((k) => !seen.has(k));

  const existingKeys = new Set(existing.map((r) => r.key));
  const metaUpserts: DowntimeMonthRec[] = meta.map((m) => ({
    ...m,
    key: m.month,
    source: "XLS",
  }));
  const existingMetaKeys = new Set(existingMeta.map((m) => m.key));

  return {
    upserts,
    staleKeys,
    metaUpserts,
    counts: {
      replaced: [...seen].filter((k) => existingKeys.has(k)).length,
      added: [...seen].filter((k) => !existingKeys.has(k)).length,
      removed: staleKeys.length,
      meta: metaUpserts.length,
      metaAdded: metaUpserts.filter((m) => !existingMetaKeys.has(m.key)).length,
      metaUpdated: metaUpserts.filter((m) => existingMetaKeys.has(m.key)).length,
    },
  };
}

export interface DowntimeDailyRec {
  date: string;
  month: string;
  machine: string;
  canon: string;
  events: number;
  downtimeMin: number;
  /** events the sheet left without a minutes figure */
  unknownMinEvents: number;
  /** 100 - downtime / basis, floored at 0 */
  availabilityPct: number;
  basisMin: number;
}

export interface DowntimeRollup {
  events: number;
  downtimeMin: number;
  minutes: number;
  hours: number;
  byMachine: { machine: string; minutes: number; events: number }[];
  byProblem: { label: string; minutes: number; events: number }[];
  /** grouped on the free-text COMMENT column, which is the only description
   *  recorded for most recent months; largely empty, so callers should show
   *  the blank share rather than presenting it as a clean taxonomy */
  byComment: { label: string; minutes: number; events: number }[];
  days: number;
  months: number;
  unknownMinEvents: number;
  dtPct: number;
}

function topN(minutes: Map<string, number>, counts: Map<string, number>, n: number) {
  return [...minutes.entries()]
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ label: k, minutes: v, events: counts.get(k) ?? 0 }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, n);
}

/** Downtime rolled up per machine per day — the grain OEE availability needs. */
export function downtimeDaily(
  events: DowntimeRec[],
  metaByMonth: Map<string, DowntimeMonthRec>
): DowntimeDailyRec[] {
  const byKey = new Map<string, DowntimeDailyRec>();

  for (const e of events) {
    const canon = canonMachine(e.machine);
    const k = `${e.date}::${canon}`;
    let d = byKey.get(k);
    if (!d) {
      const basis = basisForMonth(metaByMonth.get(e.month));
      d = {
        date: e.date,
        month: e.month,
        machine: e.machine,
        canon,
        events: 0,
        downtimeMin: 0,
        unknownMinEvents: 0,
        availabilityPct: 100,
        basisMin: basis,
      };
      byKey.set(k, d);
    }
    d.events++;
    d.downtimeMin += e.hasMinutes ? e.downtimeMin : 0;
    if (!e.hasMinutes) d.unknownMinEvents++;
    // keep the spelling the technicians use most
    if (e.machine.length > d.machine.length) d.machine = e.machine;
  }

  const out = [...byKey.values()];
  for (const d of out) {
    d.availabilityPct = clampPct(100 - (d.downtimeMin / d.basisMin) * 100);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.canon.localeCompare(b.canon));
}

export function downtimeRollup(events: DowntimeRec[]): DowntimeRollup {
  let minutes = 0;
  let unknownMinEvents = 0;
  const byMachine = new Map<string, number>();
  const byProblem = new Map<string, number>();
  const byComment = new Map<string, number>();
  const mCount = new Map<string, number>();
  const pCount = new Map<string, number>();
  const cCount = new Map<string, number>();
  const days = new Set<string>();
  const months = new Set<string>();

  for (const e of events) {
    days.add(e.date);
    months.add(e.month);
    const m = canonMachine(e.machine) || "(blank)";
    byMachine.set(m, (byMachine.get(m) ?? 0) + e.downtimeMin);
    mCount.set(m, (mCount.get(m) ?? 0) + 1);

    const p = e.problem || "(blank)";
    byProblem.set(p, (byProblem.get(p) ?? 0) + e.downtimeMin);
    pCount.set(p, (pCount.get(p) ?? 0) + 1);

    const t = e.comment || "(blank)";
    byComment.set(t, (byComment.get(t) ?? 0) + e.downtimeMin);
    cCount.set(t, (cCount.get(t) ?? 0) + 1);

    if (e.hasMinutes) minutes += e.downtimeMin;
    else unknownMinEvents++;
  }

  return {
    events: events.length,
    downtimeMin: minutes,
    minutes,
    hours: minutes / 60,
    byMachine: topN(byMachine, mCount, 8).map((o) => ({
      machine: o.label,
      minutes: o.minutes,
      events: o.events,
    })),
    byProblem: topN(byProblem, pCount, 8),
    byComment: topN(byComment, cCount, 10),
    days: days.size,
    months: months.size,
    unknownMinEvents,
    dtPct: 0,
  };
}

/** Availability for one machine-day, or null when the log says nothing about it. */
export function availabilityFromDowntime(
  date: string,
  machine: string,
  daily: Map<string, DowntimeDailyRec>
): number | null {
  const d = daily.get(`${date}::${canonMachine(machine)}`);
  return d ? d.availabilityPct : null;
}

/** Daily downtime keyed by `DATE::MACHINE`, for OEE availability lookups. */
export function indexDowntimeDaily(
  events: DowntimeRec[],
  metaByMonth: Map<string, DowntimeMonthRec>
): Map<string, DowntimeDailyRec> {
  return new Map(downtimeDaily(events, metaByMonth).map((d) => [ipqcKey(d.date, d.canon), d]));
}
