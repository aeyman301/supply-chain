import { useMemo, useState } from "react";
import { Badge, Card, DataTable, Modal, type Column } from "../components/ui";
import { dbPush, dbRemove, dbUpdate } from "../lib/db";
import { fmtNum, fmtQty } from "../lib/format";
import { ipqcRollup, type IpqcDailyRec } from "../lib/ipqcMerge";
import { indexDowntimeDaily, type DowntimeDailyRec } from "../lib/downtimeMerge";
import {
  DEFAULT_PLAN_GROUPS,
  planGroupFor,
  planGroupMachines,
  resolvePlanQty,
} from "../lib/plan";
import {
  OEE_TARGET_PCT,
  canonMachine,
  clampPct,
  computeOee,
  indexIpqcByLine,
  ipqcKey,
  lastNDays,
  oeeTone,
  qualityFromIpqc,
  rollup,
  shortDate,
} from "../lib/production";
import { useDb } from "../db-context";
import type { ProdDaily, ProdPlanGroup } from "../types";

/** A ProdDaily row after the IPQC and downtime workbooks have been applied. */
type ScoredRow = ProdDaily & {
  qualityFrom: "IPQC" | "MANUAL";
  availabilityFrom: "DOWNTIME" | "MANUAL";
  outputFrom: "IPQC" | "MANUAL";
  rejectFrom: "IPQC" | "MANUAL";
  planFrom: "ROW" | "GROUP" | "NONE";
  planGroup: string | null;
  basisMin: number | null;
  ipqc: IpqcDailyRec | null;
  downtime: DowntimeDailyRec | null;
};

const RANGES = [
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "90", label: "90 days", days: 90 },
] as const;

const EMPTY = {
  date: new Date().toISOString().slice(0, 10),
  line: "",
  product: "",
  plannedQty: 0,
  totalOutput: 0,
  rejectQty: 0,
  availabilityPct: 100,
  performancePct: 100,
  qualityPct: 100,
  downtimeMin: 0,
};

export default function Production() {
  const db = useDb();
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("7");
  const [edit, setEdit] = useState<Partial<ProdDaily> | null>(null);
  const [busy, setBusy] = useState(false);

  const days = RANGES.find((r) => r.key === range)!.days;
  const from = lastNDays(days)[0];

  const rows = useMemo(
    () =>
      db.prodDaily
        .filter((r) => r.date >= from)
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")),
    [db.prodDaily, from]
  );

  /* ---- quality comes from the imported IPQC workbooks where possible ---- */
  const ipqcIndex = useMemo(
    () => indexIpqcByLine<IpqcDailyRec>(db.prodIpqc ?? []),
    [db.prodIpqc]
  );

  /* ---- availability comes from the imported downtime workbook ---- */
  const downtimeMetaByMonth = useMemo(
    () => new Map((db.downtimeMeta ?? []).map((m) => [m.month, m])),
    [db.downtimeMeta]
  );
  const downtimeDaily = useMemo(
    () => indexDowntimeDaily(db.downtime ?? [], downtimeMetaByMonth),
    [db.downtime, downtimeMetaByMonth]
  );

  /* ---- standing plan figures keyed on the Production page ---- */
  const planGroups = useMemo(
    () => [...(db.prodPlan ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [db.prodPlan]
  );

  // distinct machines each group covers inside the selected range, so a
  // whole-group figure can be divided without hard-coding machine counts
  const planGroupCounts = useMemo(() => {
    const machines = rows.map((r) => r.line);
    const counts = new Map<string, number>();
    for (const g of planGroups) {
      if (g.id) counts.set(g.id, planGroupMachines(g, machines).length);
    }
    return counts;
  }, [planGroups, rows]);

  // each OEE row paired with the figures that will actually be used
  const scored = useMemo(
    () =>
      rows.map((r) => {
        const ip = ipqcIndex.get(ipqcKey(r.date, r.line));
        const fromIpqc = ip ? qualityFromIpqc(ip.defQty, ip.qtyCheck) : null;
        const qualityPct = fromIpqc ?? clampPct(r.qualityPct);

        const dt = downtimeDaily.get(ipqcKey(r.date, r.line));
        const availabilityPct = dt ? dt.availabilityPct : clampPct(r.availabilityPct);
        const downtimeMin = dt ? dt.downtimeMin : Number(r.downtimeMin) || 0;

        // a figure typed on the row always wins; the group is the fallback
        const g = planGroupFor(planGroups, r.line);
        const groupQty = g
          ? resolvePlanQty(planGroups, r.line, (g.id && planGroupCounts.get(g.id)) || 1)
          : 0;
        const ownQty = Number(r.plannedQty) || 0;
        const plannedQty = ownQty > 0 ? ownQty : groupQty;

        // the plant reads the IPQC sheet as the output record: QTY-CHECK is the
        // quantity the line produced, DEF QTY is the reject. IPQC wins over the
        // row, the same way it already wins for Quality.
        const ipChk = ip ? Number(ip.qtyCheck) || 0 : 0;
        const ipDef = ip ? Number(ip.defQty) || 0 : 0;
        const useIpqcQty = ipChk > 0;
        const totalOutput = useIpqcQty ? ipChk : Number(r.totalOutput) || 0;
        const rejectQty = ip ? ipDef : Number(r.rejectQty) || 0;

        return {
          ...r,
          plannedQty,
          totalOutput,
          rejectQty,
          qualityPct, // rollup()/computeOee() read this field
          availabilityPct,
          downtimeMin,
          qualityFrom: (fromIpqc !== null ? "IPQC" : "MANUAL") as "IPQC" | "MANUAL",
          availabilityFrom: (dt ? "DOWNTIME" : "MANUAL") as "DOWNTIME" | "MANUAL",
          outputFrom: (useIpqcQty ? "IPQC" : "MANUAL") as "IPQC" | "MANUAL",
          rejectFrom: (ip ? "IPQC" : "MANUAL") as "IPQC" | "MANUAL",
          planFrom: (ownQty > 0 ? "ROW" : groupQty > 0 ? "GROUP" : "NONE") as
            | "ROW"
            | "GROUP"
            | "NONE",
          planGroup: g?.label ?? null,
          basisMin: dt?.basisMin ?? null,
          ipqc: ip ?? null,
          downtime: dt ?? null,
        };
      }),
    [rows, ipqcIndex, downtimeDaily, planGroups, planGroupCounts]
  );

  const totalsScored = useMemo(() => rollup(scored), [scored]);
  const ipqcBacked = scored.filter((r) => r.qualityFrom === "IPQC").length;
  const downtimeBacked = scored.filter((r) => r.availabilityFrom === "DOWNTIME").length;
  const outputBacked = scored.filter((r) => r.outputFrom === "IPQC").length;
  const rejectBacked = scored.filter((r) => r.rejectFrom === "IPQC").length;
  const assumedAp = scored.filter((r) => r.assumedAp).length;

  // Daily series for the sparkline, oldest first
  const byDate = useMemo(() => {
    const map = new Map<string, ScoredRow[]>();
    for (const r of scored) {
      const arr = map.get(r.date) ?? [];
      arr.push(r);
      map.set(r.date, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [scored]);

  const lines = useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of [...db.prodDaily.map((r) => r.line), ...(db.prodIpqc ?? []).map((r) => r.machine)]) {
      const k = canonMachine(l);
      if (k && !seen.has(k)) seen.set(k, l);
    }
    return [...seen.values()].sort();
  }, [db.prodDaily, db.prodIpqc]);

  /** Create an OEE row for every machine-day present in IPQC but not yet
   *  scored. Quality comes from the workbook; A and P start at 100% and are
   *  flagged as assumed until someone enters the real figures. */
  /** Create an OEE row for every machine-day the downtime log covers but that
   *  has no OEE row yet. Availability comes from the log; Quality from IPQC
   *  where it covers the same machine-day. Performance is still assumed. */
  const seedFromDowntime = async () => {
    const have = new Set(db.prodDaily.map((r) => ipqcKey(r.date, r.line)));
    const todo = [...downtimeDaily.values()].filter((d) => !have.has(ipqcKey(d.date, d.canon)));

    if (todo.length === 0) {
      alert("No new machine-days to add — every downtime record already has an OEE row.");
      return;
    }
    const withIpqc = todo.filter((d) => ipqcIndex.has(ipqcKey(d.date, d.canon))).length;
    const totalMin = todo.reduce((s, d) => s + d.downtimeMin, 0);
    if (
      !confirm(
        `Create ${fmtQty(todo.length)} OEE record(s) from the downtime log?\n\n` +
          `Availability is taken from the log — ${fmtQty(totalMin)} minutes of downtime across ` +
          `the period, measured against each machine-day's loading time.\n` +
          `Quality is taken from the IPQC workbooks for ${fmtQty(withIpqc)} of them; the rest ` +
          `fall back to the quality figure you type in.\n\n` +
          `Performance starts at 100% and is marked as assumed — neither workbook records cycle ` +
          `counts, so it must be entered manually until the PLC integration lands.\n\n` +
          `Only machine-days in the selected date range are included.`
      )
    )
      return;

    setBusy(true);
    try {
      for (const d of todo) {
        const ip = ipqcIndex.get(ipqcKey(d.date, d.canon));
        await dbPush("prodDaily", {
          date: d.date,
          line: d.machine,
          product: "",
          plannedQty: 0,
          totalOutput: Number(ip?.qtyCheck) || 0,
          rejectQty: Number(ip?.defQty) || 0,
          availabilityPct: d.availabilityPct,
          performancePct: 100,
          qualityPct: qualityFromIpqc(ip?.defQty, ip?.qtyCheck) ?? 100,
          assumedAp: true,
          downtimeMin: d.downtimeMin,
          source: "MANUAL",
          updatedAt: Date.now(),
        });
      }
    } catch (e: any) {
      alert("Could not create records: " + (e?.message ?? "unknown error"));
    } finally {
      setBusy(false);
    }
  };

  const seedFromIpqc = async () => {
    const have = new Set(db.prodDaily.map((r) => ipqcKey(r.date, r.line)));

    // fold the workbook's spelling drift ("CM 20-03" / "CM20-03") into one
    // machine, summing defects and quantity checked across the variants
    type Group = { date: string; name: string; spellings: Map<string, number>; def: number; chk: number };
    const groups = new Map<string, Group>();
    for (const ip of db.prodIpqc ?? []) {
      if (ip.date < from) continue;
      const k = ipqcKey(ip.date, ip.machine);
      const g = groups.get(k) ?? {
        date: ip.date,
        name: ip.machine,
        spellings: new Map<string, number>(),
        def: 0,
        chk: 0,
      };
      g.spellings.set(ip.machine, (g.spellings.get(ip.machine) ?? 0) + 1);
      g.def += Number(ip.defQty) || 0;
      g.chk += Number(ip.qtyCheck) || 0;
      // prefer the spelling the inspectors use most often
      if (g.spellings.get(ip.machine)! > (g.spellings.get(g.name) ?? 0)) g.name = ip.machine;
      groups.set(k, g);
    }

    const todo = [...groups.entries()].filter(([k]) => !have.has(k));
    if (todo.length === 0) {
      alert("No new IPQC machine-days to add — every imported record already has an OEE row.");
      return;
    }
    const withSample = todo.filter(([, g]) => g.chk > 0).length;
    if (
      !confirm(
        `Create ${todo.length} OEE record(s) from the imported IPQC workbooks?\n\n` +
          `Quality is taken from the workbooks (${withSample} of these have a sample size; ` +
          `the rest fall back to the quality figure you type in). Availability is taken from the ` +
          `downtime log wherever it covers that machine and date.\n\n` +
          `Performance starts at 100% and is marked as assumed — the IPQC and downtime files ` +
          `record defects, quantity checked and stoppage minutes, but no cycle counts, so it must ` +
          `be entered manually until the PLC integration lands.`
      )
    )
      return;

    setBusy(true);
    try {
      for (const [, g] of todo) {
        await dbPush("prodDaily", {
          date: g.date,
          line: g.name,
          product: "",
          plannedQty: 0,
          totalOutput: g.chk,
          rejectQty: g.def,
          availabilityPct: 100,
          performancePct: 100,
          qualityPct: qualityFromIpqc(g.def, g.chk) ?? 0,
          assumedAp: true,
          downtimeMin: 0,
          source: "MANUAL",
          updatedAt: Date.now(),
        });
      }
    } catch (e: any) {
      alert("Could not create records: " + (e?.message ?? "unknown error"));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!edit) return;
    const date = (edit.date ?? "").trim();
    const line = (edit.line ?? "").trim();
    if (!date) return alert("Date is required");
    if (!line) return alert("Line / machine is required");

    const rec: ProdDaily = {
      date,
      line,
      product: (edit.product ?? "").trim(),
      plannedQty: Number(edit.plannedQty) || 0,
      totalOutput: Number(edit.totalOutput) || 0,
      rejectQty: Number(edit.rejectQty) || 0,
      availabilityPct: editDowntime ? editDowntime.availabilityPct : clampPct(edit.availabilityPct),
      performancePct: clampPct(edit.performancePct),
      // keep the fallbacks in step with the workbooks so they stay correct if an
      // import is ever removed
      qualityPct: editIpqcQuality ?? clampPct(edit.qualityPct),
      assumedAp: edit.assumedAp,
      downtimeMin: editDowntime ? editDowntime.downtimeMin : Number(edit.downtimeMin) || 0,
      source: edit.source ?? "MANUAL",
      updatedAt: Date.now(),
    };

    setBusy(true);
    try {
      // one record per line per day, so re-keying a day updates in place
      const existing = db.prodDaily.find((r) => r.date === rec.date && r.line === rec.line);
      if (existing?.id) await dbUpdate(`prodDaily/${existing.id}`, rec);
      else await dbPush("prodDaily", rec);
      setEdit(null);
    } catch (e: any) {
      alert("Could not save: " + (e?.message ?? "unknown error"));
    } finally {
      setBusy(false);
    }
  };

  const del = async (r: ProdDaily) => {
    if (!confirm(`Delete the ${r.line} record for ${r.date}?`)) return;
    setBusy(true);
    try {
      await dbRemove(`prodDaily/${r.id}`);
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<ScoredRow>[] = [
    { key: "date", header: "Date", value: (r) => r.date, render: (r) => r.date },
    { key: "line", header: "Line", value: (r) => r.line, render: (r) => <span className="font-medium">{r.line}</span> },
    { key: "product", header: "Product", value: (r) => r.product, render: (r) => r.product || "-" },
    { key: "planned", header: "Planned", value: (r) => r.plannedQty, align: "right", render: (r) => (
      <div className="flex flex-col gap-0.5 items-end">
        <span className="font-medium">{r.plannedQty > 0 ? fmtQty(r.plannedQty) : "-"}</span>
        {r.planFrom !== "NONE" && (
          <span className="text-[10px] text-slate-500">
            {r.planFrom === "GROUP" ? r.planGroup : "row"}
          </span>
        )}
      </div>
    ) },
    {
      key: "output",
      header: "Total Output",
      value: (r) => r.totalOutput,
      align: "right",
      render: (r) => (
        <div className="flex flex-col gap-0.5 items-end">
          <span className="font-semibold">{fmtQty(r.totalOutput)}</span>
          {r.outputFrom === "IPQC" && <span className="text-[10px] text-slate-500">QTY-CHECK</span>}
        </div>
      ),
    },
    {
      key: "reject",
      header: "Reject",
      value: (r) => r.rejectQty,
      align: "right",
      render: (r) => (
        <div className="flex flex-col gap-0.5 items-end">
          <span>{fmtQty(r.rejectQty)}</span>
          {r.rejectFrom === "IPQC" && <span className="text-[10px] text-slate-500">DEF QTY</span>}
        </div>
      ),
    },
    {
      key: "oee",
      header: "OEE",
      value: (r) => fmtNum(computeOee(r).oeePct, 1),
      align: "right",
      render: (r) => {
        const o = computeOee(r).oeePct;
        return (
          <span
            className={
              oeeTone(o) === "ok"
                ? "text-emerald-400 font-semibold"
                : oeeTone(o) === "warn"
                  ? "text-amber-400 font-semibold"
                  : "text-rose-400 font-semibold"
            }
          >
            {fmtNum(o, 1)}%
          </span>
        );
      },
    },
    {
      key: "apq",
      header: "A / P / Q",
      value: (r) => {
        const o = computeOee(r);
        return `${fmtNum(o.availabilityPct, 0)} / ${fmtNum(o.performancePct, 0)} / ${fmtNum(o.qualityPct, 1)}`;
      },
      render: (r) => {
        const o = computeOee(r);
        return (
          <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">
            {fmtNum(o.availabilityPct, 0)} / {fmtNum(o.performancePct, 0)} /{" "}
            {fmtNum(o.qualityPct, 1)}
          </span>
        );
      },
    },
    {
      key: "qsrc",
      header: "Quality",
      value: (r) => r.qualityFrom,
      render: (r) => (
        <div className="flex flex-col gap-0.5 items-start">
          <Badge tone={r.qualityFrom === "IPQC" ? "info" : "default"}>{r.qualityFrom}</Badge>
          {r.assumedAp && <span className="text-[10px] text-amber-400">A/P assumed</span>}
        </div>
      ),
    },
    {
      key: "asrc",
      header: "Availability",
      value: (r) => r.availabilityFrom,
      render: (r) => (
        <div className="flex flex-col gap-0.5 items-start">
          <Badge tone={r.availabilityFrom === "DOWNTIME" ? "info" : "default"}>
            {r.availabilityFrom}
          </Badge>
          {r.assumedAp && r.availabilityFrom !== "DOWNTIME" && (
            <span className="text-[10px] text-amber-400">assumed</span>
          )}
        </div>
      ),
    },
    {
      key: "source",
      header: "Source",
      value: (r) => r.source,
      render: (r) => <Badge tone={r.source === "PLC" ? "info" : "default"}>{r.source}</Badge>,
    },
    {
      key: "act",
      header: "",
      value: () => "",
      render: (r) => (
        <div className="flex gap-1 justify-end">
          <button
            className="btn-secondary !py-1 !px-2"
            onClick={() => setEdit({ ...r })}
          >
            Edit
          </button>
          <button className="btn-secondary !py-1 !px-2" onClick={() => del(r)}>
            Delete
          </button>
        </div>
      ),
    },
  ];

  /** While editing, the workbook row that will override the typed quality. */
  const editIpqc =
    edit?.date && edit?.line
      ? (ipqcIndex.get(ipqcKey(edit.date, edit.line)) as IpqcDailyRec | undefined)
      : undefined;
  const editIpqcQuality = editIpqc ? qualityFromIpqc(editIpqc.defQty, editIpqc.qtyCheck) : null;

  /** Downtime record for the machine-day being edited, if the log covers it. */
  const editDowntime =
    edit?.date && edit?.line
      ? (downtimeDaily.get(ipqcKey(edit.date, edit.line)) as DowntimeDailyRec | undefined)
      : undefined;

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Production Dashboard</h1>
          <p className="text-sm text-slate-500">
            OEE and total output. Availability comes from the imported downtime log and Quality
            from the IPQC workbooks; Performance is keyed in by hand.
          </p>
        </div>
        <div className="flex gap-2">
          <select
            className="input max-w-32"
            value={range}
            onChange={(e) => setRange(e.target.value as (typeof RANGES)[number]["key"])}
          >
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <button className="btn-secondary" disabled={busy} onClick={seedFromDowntime}>
            Create OEE rows from downtime
          </button>
          <button className="btn-secondary" disabled={busy} onClick={seedFromIpqc}>
            Create OEE rows from IPQC
          </button>
          <button className="btn-primary" onClick={() => setEdit({ ...EMPTY })}>
            + Add entry
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-slate-500">OEE</div>
          <div
            className={
              totalsScored.records === 0
                ? "text-2xl font-bold mt-1 text-slate-600"
                : oeeTone(totalsScored.avgOeePct) === "ok"
                  ? "text-2xl font-bold mt-1 text-emerald-400"
                  : oeeTone(totalsScored.avgOeePct) === "warn"
                    ? "text-2xl font-bold mt-1 text-amber-400"
                    : "text-2xl font-bold mt-1 text-rose-400"
            }
          >
            {totalsScored.records === 0 ? "-" : `${fmtNum(totalsScored.avgOeePct, 1)}%`}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Target {OEE_TARGET_PCT}% · avg of {fmtQty(totalsScored.records)} record(s)
          </div>
        </div>

        <div className="card">
          <div className="text-xs uppercase tracking-wide text-slate-500">Total Output</div>
          <div className="text-2xl font-bold mt-1 text-sky-300">
            {totalsScored.records === 0 ? "-" : fmtQty(totalsScored.totalOutput)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {totalsScored.plannedQty > 0
              ? `${fmtNum(totalsScored.attainmentPct, 1)}% of ${fmtQty(totalsScored.plannedQty)} planned`
              : "No plan set"}
          </div>
          {totalsScored.unplannedOutput > 0 && (
            <div className="text-xs text-slate-500 mt-0.5" title="Output from machine-days with no planned figure. Excluded from attainment so it cannot inflate the percentage.">
              excl. {fmtQty(Math.round(totalsScored.unplannedOutput))} unplanned
            </div>
          )}
        </div>

        <div className="card">
          <div className="text-xs uppercase tracking-wide text-slate-500">Reject Rate</div>
          <div className="text-2xl font-bold mt-1 text-amber-400">
            {totalsScored.records === 0 ? "-" : `${fmtNum(totalsScored.rejectRatePct, 1)}%`}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {fmtQty(totalsScored.rejectQty)} rejected unit(s)
          </div>
        </div>

        <div className="card">
          <div className="text-xs uppercase tracking-wide text-slate-500">Downtime</div>
          <div className="text-2xl font-bold mt-1">
            {totalsScored.records === 0 ? "-" : `${fmtQty(totalsScored.downtimeMin)} min`}
          </div>
          <div className="text-xs text-slate-500 mt-1">Recorded in period</div>
        </div>
      </div>

      <OeeBreakdownCard
        rows={scored}
        ipqcBacked={ipqcBacked}
        downtimeBacked={downtimeBacked}
        outputBacked={outputBacked}
        rejectBacked={rejectBacked}
        assumedAp={assumedAp}
      />

      <IpqcCard rows={(db.prodIpqc ?? []).filter((r) => r.date >= from)} />

      <PlanCard groups={planGroups} rowMachines={rows.map((r) => r.line)} />

      {byDate.length > 1 && (
        <Card title="Daily OEE and output">
          <DailyBars data={byDate} />
        </Card>
      )}

      <Card title="Production records">
        <DataTable
          columns={columns}
          rows={scored}
          emptyText="No production records yet. Use “Create OEE rows from IPQC” after importing a workbook, or + Add entry."
          dense
        />
      </Card>

      {edit && (
        <Modal
          title={edit.id ? `Edit ${edit.line} — ${edit.date}` : "Add production record"}
          onClose={() => setEdit(null)}
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-xs text-slate-400 block mb-1">Date *</span>
                <input
                  type="date"
                  className="input"
                  value={edit.date ?? ""}
                  onChange={(e) => setEdit((s) => ({ ...s, date: e.target.value }))}
                />
              </div>
              <div>
                <span className="text-xs text-slate-400 block mb-1">Line / machine *</span>
                <input
                  className="input"
                  list="prod-lines"
                  placeholder="LINE-01"
                  value={edit.line ?? ""}
                  onChange={(e) => setEdit((s) => ({ ...s, line: e.target.value }))}
                />
                <datalist id="prod-lines">
                  {lines.map((l) => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
              </div>
            </div>

            <div>
              <span className="text-xs text-slate-400 block mb-1">Product</span>
              <input
                className="input"
                placeholder="Product / model"
                value={edit.product ?? ""}
                onChange={(e) => setEdit((s) => ({ ...s, product: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Num
                label="Planned qty"
                value={edit.plannedQty}
                onChange={(v) => setEdit((s) => ({ ...s, plannedQty: v }))}
              />
              <Num
                label="Total output"
                value={edit.totalOutput}
                onChange={(v) => setEdit((s) => ({ ...s, totalOutput: v }))}
              />
              <Num
                label="Reject qty"
                value={edit.rejectQty}
                onChange={(v) => setEdit((s) => ({ ...s, rejectQty: v }))}
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Num
                label={editDowntime ? "Availability % (from downtime)" : "Availability %"}
                step={0.1}
                max={100}
                value={editDowntime ? editDowntime.availabilityPct : edit.availabilityPct}
                onChange={(v) => setEdit((s) => ({ ...s, availabilityPct: clampPct(v) }))}
              />
              <Num
                label="Performance %"
                step={0.1}
                max={100}
                value={edit.performancePct}
                onChange={(v) =>
                  setEdit((s) => ({ ...s, performancePct: clampPct(v), assumedAp: false }))
                }
              />
              <Num
                label={editIpqcQuality !== null ? "Quality % (from IPQC)" : "Quality %"}
                step={0.1}
                max={100}
                value={editIpqcQuality ?? edit.qualityPct}
                onChange={(v) => setEdit((s) => ({ ...s, qualityPct: clampPct(v) }))}
              />
            </div>

            <Num
              label="Downtime (minutes)"
              value={editDowntime ? editDowntime.downtimeMin : edit.downtimeMin}
              onChange={(v) => setEdit((s) => ({ ...s, downtimeMin: v }))}
            />

            <div className="rounded bg-slate-800/50 px-3 py-2 text-xs text-slate-400">
              OEE = Availability × Performance × Quality ={" "}
              <span className="text-sky-300 font-semibold">
                {fmtNum(computeOee({
                  availabilityPct: editDowntime?.availabilityPct ?? edit.availabilityPct ?? 0,
                  performancePct: edit.performancePct ?? 0,
                  qualityPct: editIpqcQuality ?? edit.qualityPct ?? 0,
                }).oeePct, 1)}%
              </span>
              {editDowntime && (
                <div className="mt-1 text-sky-300/80">
                  Availability is taken from the downtime log for this machine and date —{" "}
                  {fmtQty(editDowntime.downtimeMin)} min stopped across{" "}
                  {fmtQty(editDowntime.events)} event(s), against {fmtQty(editDowntime.basisMin)}{" "}
                  min of loading time. The value entered here is only a fallback; the log wins.
                </div>
              )}
              {editIpqcQuality !== null && (
                <div className="mt-1 text-sky-300/80">
                  Quality is taken from the IPQC workbook for this machine and date
                  {editIpqc ? ` — ${fmtQty(editIpqc.defQty)} defect(s) over ${fmtQty(editIpqc.qtyCheck)} checked` : ""}.
                  The value here is only a fallback; the workbook wins.
                </div>
              )}
              {edit.assumedAp && (
                <div className="mt-1 text-amber-400">
                  Performance is still assumed. Enter it to clear this.
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button className="btn-primary" disabled={busy} onClick={save}>
                Save
              </button>
              <button className="btn-secondary" onClick={() => setEdit(null)}>
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Quality side of OEE, sourced from the imported IPQC workbooks. Shown
 *  separately from the manual A/P/Q entry so the two never get confused. */
function IpqcCard({ rows }: { rows: IpqcDailyRec[] }) {
  const t = ipqcRollup(rows);
  if (rows.length === 0) return null;

  const byMachine = new Map<string, { name: string; def: number; chk: number }>();
  for (const r of rows) {
    const k = canonMachine(r.machine);
    const cur = byMachine.get(k) ?? { name: r.machine, def: 0, chk: 0 };
    cur.def += Number(r.defQty || 0);
    cur.chk += Number(r.qtyCheck || 0);
    byMachine.set(k, cur);
  }
  const worst = [...byMachine.entries()]
    .filter(([, v]) => v.chk > 0)
    .map(([m, v]) => ({ machine: v.name || m, dpm: (v.def / v.chk) * 1_000_000 }))
    .sort((a, b) => b.dpm - a.dpm)
    .slice(0, 5);

  const noSample = rows.filter((r) => qualityFromIpqc(r.defQty, r.qtyCheck) === null).length;

  return (
    <Card title="IPQC quality (imported workbooks)">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">DPM</div>
          <div className="text-xl font-bold text-amber-400 mt-1">{fmtNum(t.dpm, 2)}</div>
          <div className="text-xs text-slate-500 mt-1">defects per million checked</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Defects</div>
          <div className="text-xl font-bold mt-1">{fmtQty(t.defQty)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Qty Checked</div>
          <div className="text-xl font-bold mt-1">{fmtQty(t.qtyCheck)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Machine-days</div>
          <div className="text-xl font-bold mt-1">{fmtQty(t.machineDays)}</div>
          {noSample > 0 && (
            <div className="text-xs text-amber-400 mt-1">
              {fmtQty(noSample)} with no qty checked
            </div>
          )}
        </div>
      </div>

      {worst.length > 0 && (
        <div>
          <div className="text-xs text-slate-500 mb-1">Highest DPM machines</div>
          <div className="flex flex-wrap gap-2">
            {worst.map((w) => (
              <span
                key={w.machine}
                className="text-xs rounded border border-slate-800 px-2 py-1 text-slate-300"
              >
                {w.machine} <span className="text-amber-400 ml-1">{fmtNum(w.dpm, 0)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {noSample > 0 && (
        <p className="mt-3 text-xs text-slate-500">
          {fmtQty(noSample)} of {fmtQty(rows.length)} machine-day(s) record no quantity checked,
          so no quality percentage can be derived from them. Those rows fall back to the quality
          figure entered by hand.
        </p>
      )}
    </Card>
  );
}

function Num({
  label,
  value,
  onChange,
  step = 1,
  max,
}: {
  label: string;
  value?: number;
  onChange: (v: number) => void;
  step?: number;
  max?: number;
}) {
  return (
    <div>
      <span className="text-xs text-slate-400 block mb-1">{label}</span>
      <input
        type="number"
        className="input"
        step={step}
        min={0}
        max={max}
        value={value ?? 0}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** Average A / P / Q across the period, with the OEE they combine into.
 *  `rows` must already be IPQC-scored so Quality reflects the workbooks. */
function OeeBreakdownCard({
  rows,
  ipqcBacked,
  downtimeBacked,
  outputBacked,
  rejectBacked,
  assumedAp,
}: {
  rows: ScoredRow[];
  ipqcBacked: number;
  downtimeBacked: number;
  outputBacked: number;
  rejectBacked: number;
  assumedAp: number;
}) {
  if (rows.length === 0) return null;
  const avg = (k: "availabilityPct" | "performancePct" | "qualityPct") =>
    rows.reduce((s, r) => s + clampPct(r[k]), 0) / rows.length;

  const a = avg("availabilityPct");
  const p = avg("performancePct");
  const q = avg("qualityPct");
  const oee = (a / 100) * (p / 100) * (q / 100) * 100;

  const items: [string, number][] = [
    ["Availability", a],
    ["Performance", p],
    ["Quality", q],
  ];

  return (
    <Card title="OEE breakdown">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {items.map(([label, v]) => (
          <div key={label}>
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-slate-400">{label}</span>
              <span className="text-sm font-semibold tabular-nums">{fmtNum(v, 1)}%</span>
            </div>
            <div className="h-2 mt-1.5 rounded bg-slate-800 overflow-hidden">
              <div
                className={
                  v >= 90
                    ? "h-full bg-emerald-500"
                    : v >= 75
                      ? "h-full bg-amber-500"
                      : "h-full bg-rose-500"
                }
                style={{ width: `${Math.min(100, Math.max(0, v))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between">
        <span className="text-sm text-slate-400">Combined OEE</span>
        <span
          className={
            oeeTone(oee) === "ok"
              ? "text-lg font-bold text-emerald-400"
              : oeeTone(oee) === "warn"
                ? "text-lg font-bold text-amber-400"
                : "text-lg font-bold text-rose-400"
          }
        >
          {fmtNum(oee, 1)}%
        </span>
      </div>

      <p className="mt-3 text-xs text-slate-500 leading-relaxed">
        <span className="text-sky-300">Availability</span> is computed from the downtime
        workbook for{" "}
        <span className="text-sky-300">{downtimeBacked}</span> of {rows.length} record(s);
        the rest use the figure entered by hand.{" "}
        <span className="text-sky-300">Quality</span> is read from the IPQC workbooks for{" "}
        <span className="text-sky-300">{ipqcBacked}</span> of {rows.length} record(s).
        {assumedAp > 0 && (
          <>
            {" "}
            <span className="text-amber-400">
              {assumedAp} record(s) still have an assumed Performance figure
            </span>{" "}
            — the IPQC files record defects and quantity checked, and the downtime file records
            stoppage minutes. Neither contains cycle counts, so Performance must be entered
            manually until the PLC integration is live.
          </>
        )}
      </p>

      <p className="mt-2 text-xs text-slate-500 leading-relaxed">
        <span className="text-sky-300">Total Output</span> is IPQC <em>QTY-CHECK</em> for{" "}
        <span className="text-sky-300">{outputBacked}</span> of {rows.length} record(s) — the
        quantity the line is recorded as producing. <span className="text-sky-300">Reject</span> is
        IPQC <em>DEF QTY</em> for <span className="text-sky-300">{rejectBacked}</span>. Where a
        record has no IPQC match its Output and Reject stay whatever was entered by hand.
        {outputBacked > 0 && (
          <>
            {" "}
            <span className="text-amber-400">
              QTY-CHECK is the quantity inspected, not necessarily the quantity produced
            </span>
            {" "}
            — so attainment against the plan moves with how much was sampled, not only with how
            much was made. Worth confirming against a shift report before the attainment figure is
            quoted upward.
          </>
        )}
      </p>

      {rows.length > 0 && downtimeBacked === 0 && (
        <p className="mt-2 text-xs text-rose-300 bg-rose-950/30 border border-rose-900/50 rounded px-3 py-2">
          <strong>No downtime data covers this period.</strong> Every Availability figure above
          is the manually entered value, not a measurement. The downtime log has no records for
          the machine-days in the selected range — check the date coverage of the imported
          downtime workbook, or widen the range until it overlaps the downtime data.
        </p>
      )}
    </Card>
  );
}

/**
 * Standing plan figures, keyed here rather than on every OEE row. A group
 * matches machines by prefix so "AC90" covers AC90-1..AC90-8 in one entry.
 * The per-machine / whole-group toggle is deliberate: 13,600 for one AC90 is
 * very different from 13,600 spread across eight of them.
 */
function PlanCard({
  groups,
  rowMachines,
}: {
  groups: (ProdPlanGroup & { id: string })[];
  rowMachines: string[];
}) {
  const [draft, setDraft] = useState<Record<string, ProdPlanGroup>>({});
  const [busy, setBusy] = useState(false);

  const shown = groups.map((g) => ({ ...g, ...draft[g.id] } as ProdPlanGroup & { id: string }));
  const effective = shown.filter((g) => (g.plannedQty ?? 0) > 0);
  const dirty = Object.keys(draft).length > 0;

  const save = async (g: ProdPlanGroup & { id: string }) => {
    await dbUpdate(`prodPlan/${g.id}`, { ...g, updatedAt: Date.now() });
  };

  const seed = async () => {
    setBusy(true);
    try {
      for (const [i, g] of DEFAULT_PLAN_GROUPS.entries()) {
        await dbPush("prodPlan", { ...g, order: i, updatedAt: Date.now() });
      }
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    try {
      await dbPush("prodPlan", {
        label: "New group",
        match: "",
        plannedQty: 0,
        perMachine: true,
        order: groups.length,
        updatedAt: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await dbRemove(`prodPlan/${id}`);
      setDraft((d) => {
        const n = { ...d };
        delete n[id];
        return n;
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Plan"
      right={
        <div className="flex gap-2">
          {groups.length === 0 && (
            <button className="btn-secondary !py-1 !px-2" disabled={busy} onClick={seed}>
              Load defaults
            </button>
          )}
          <button className="btn-secondary !py-1 !px-2" disabled={busy} onClick={add}>
            + Add group
          </button>
        </div>
      }
    >
      <p className="text-xs text-slate-400 mb-3">
        A planned figure typed on a record always wins; these group values fill in the rest, so
        there is no need to key the same number on every machine-day. Machines are matched by the
        prefix in <strong>Match</strong> against the canonical machine name.
      </p>

      {groups.length === 0 ? (
        <p className="text-sm text-slate-500">
          No plan groups yet. “Load defaults” adds AC90 13,600 and AC95 13,600 per machine, CM
          6,000, Joint and Twist 5,000 — then adjust them here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3">Group</th>
                <th className="py-2 pr-3">Match prefix</th>
                <th className="py-2 pr-3 text-right">Planned qty</th>
                <th className="py-2 pr-3">Applies to</th>
                <th className="py-2 pr-3 text-right" title="Distinct canonical machine codes in the selected range. This counts spellings, not physical machines — twist is 3 machines but the log spells them 7 ways.">
                  Codes in range
                </th>
                <th className="py-2 text-right">Effective per machine</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => {
                const machines = planGroupMachines(g, rowMachines);
                const eff = resolvePlanQty(shown, g.match, machines.length);
                return (
                  <tr key={g.id} className="border-t border-slate-800">
                    <td className="py-2 pr-3">
                      <input
                        className="input !py-1"
                        value={g.label ?? ""}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, [g.id]: { ...g, label: e.target.value } }))
                        }
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        className="input !py-1 font-mono"
                        placeholder="AC90"
                        value={g.match ?? ""}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, [g.id]: { ...g, match: e.target.value } }))
                        }
                      />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <input
                        className="input !py-1 text-right w-28"
                        type="number"
                        min={0}
                        value={g.plannedQty ?? 0}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            [g.id]: { ...g, plannedQty: Number(e.target.value) || 0 },
                          }))
                        }
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <select
                        className="input !py-1"
                        value={g.perMachine ? "each" : "group"}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            [g.id]: { ...g, perMachine: e.target.value === "each" },
                          }))
                        }
                      >
                        <option value="each">each machine</option>
                        <option value="group">whole group</option>
                      </select>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-400">
                      {machines.length}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {eff > 0 ? (
                        <span className="text-sky-300 font-medium">{fmtQty(Math.round(eff))}</span>
                      ) : (
                        <span className="text-slate-600">-</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex gap-1 justify-end">
                        <button
                          className="btn-secondary !py-1 !px-2"
                          disabled={busy}
                          onClick={() => save(g)}
                        >
                          Save
                        </button>
                        <button
                          className="btn-secondary !py-1 !px-2"
                          disabled={busy}
                          onClick={() => remove(g.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {dirty && (
        <p className="text-xs text-amber-400 mt-3">
          There are unsaved edits above. Each row has its own Save button — the table will not write
          until you use it.
        </p>
      )}

      {effective.length > 0 && (
        <p className="text-xs text-slate-500 mt-3">
          {effective.length} group(s) with a figure. <strong>Codes in range</strong> counts distinct
          spellings, not physical machines — a group whose machines are written several ways in the
          log will show a higher number than you expect. A figure set to <em>whole group</em> is
          divided by that count, so confirm it before relying on it.
        </p>
        )}
    </Card>
  );
}

/** Minimal bar chart: OEE as the bar height, output printed alongside. */
function DailyBars({ data }: { data: [string, ScoredRow[]][] }) {
  const max = Math.max(100, ...data.map(([, rs]) => rollup(rs).totalOutput));
  return (
    <div className="flex items-end gap-1.5 h-40 overflow-x-auto">
      {data.map(([date, rs]) => {
        const t = rollup(rs);
        const h = max > 0 ? (t.totalOutput / max) * 100 : 0;
        const tone = oeeTone(t.avgOeePct);
        return (
          <div key={date} className="flex flex-col items-center gap-1 min-w-[26px]" title={`${date}: output ${t.totalOutput}, OEE ${fmtNum(t.avgOeePct, 1)}%`}>
            <span className="text-[9px] text-slate-500 tabular-nums">{fmtQty(t.totalOutput)}</span>
            <div
              className={
                tone === "ok"
                  ? "w-full bg-emerald-500/70 rounded-t"
                  : tone === "warn"
                    ? "w-full bg-amber-500/70 rounded-t"
                    : "w-full bg-rose-500/70 rounded-t"
              }
              style={{ height: `${Math.max(2, h)}%` }}
            />
            <span className="text-[9px] text-slate-500 whitespace-nowrap">{shortDate(date)}</span>
          </div>
        );
      })}
    </div>
  );
}
