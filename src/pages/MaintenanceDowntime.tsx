import { useMemo, useRef, useState } from "react";
import {
  Badge,
  Card,
  DataTable,
  Field,
  Modal,
  SearchBox,
  Stat,
  exportCsv,
  type Column,
} from "../components/ui";
import { dbPush, dbRemove, dbSet, dbUpdate } from "../lib/db";
import { fmtNum, fmtQty, monthLabel, todayISO } from "../lib/format";
import {
  parseDowntimeWorkbook,
  type DowntimeParseResult,
} from "../lib/downtimeExcel";
import {
  downtimeDaily,
  downtimeRollup,
  planDowntimeMerge,
  type DowntimeMonthRec,
  type DowntimeRec,
} from "../lib/downtimeMerge";
import { canonMachine, lastNDays } from "../lib/production";
import { useDb } from "../db-context";

type Queued = {
  file: File;
  status: "PARSING" | "READY" | "ERROR";
  result?: DowntimeParseResult;
  error?: string;
};

const RANGES = [
  { key: "30", label: "30 days", days: 30 },
  { key: "90", label: "90 days", days: 90 },
  { key: "180", label: "180 days", days: 180 },
  { key: "365", label: "1 year", days: 365 },
] as const;

export default function MaintenanceDowntime() {
  const db = useDb();
  const existing = (db.downtime ?? []) as DowntimeRec[];
  const meta = (db.downtimeMeta ?? []) as DowntimeMonthRec[];

  const [q, setQ] = useState("");
  const [queue, setQueue] = useState<Queued[]>([]);
  const [monthF, setMonthF] = useState("ALL");
  const [machineF, setMachineF] = useState("ALL");
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("90");
  const [edit, setEdit] = useState<DowntimeRec | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const metaByMonth = useMemo(
    () => new Map(meta.map((m) => [m.month, m])),
    [meta]
  );

  const daily = useMemo(() => downtimeDaily(existing, metaByMonth), [existing, metaByMonth]);
  const dailyIndex = useMemo(
    () => new Map(daily.map((d) => [`${d.date}::${d.canon}`, d])),
    [daily]
  );

  // lastNDays is oldest-first, so [0] is the cutoff date
  const from = lastNDays(RANGES.find((r) => r.key === range)!.days)[0];

  const months = useMemo(
    () => [...new Set(existing.map((e) => e.month))].sort().reverse(),
    [existing]
  );
  const machines = useMemo(
    () => [...new Set(existing.map((e) => e.machine).filter(Boolean))].sort(),
    [existing]
  );

  const inRange = useMemo(
    () => existing.filter((e) => e.date >= from),
    [existing, from]
  );

  const rows = useMemo(() => {
    const n = q.toLowerCase();
    return inRange
      .filter((e) => {
        if (monthF !== "ALL" && e.month !== monthF) return false;
        if (machineF !== "ALL" && canonMachine(e.machine) !== machineF) return false;
        if (!n) return true;
        return (
          e.machine.toLowerCase().includes(n) ||
          e.problem.toLowerCase().includes(n) ||
          e.comment.toLowerCase().includes(n) ||
          e.operator.toLowerCase().includes(n) ||
          e.maintenance.toLowerCase().includes(n)
        );
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [inRange, q, monthF, machineF]);

  const roll = useMemo(() => downtimeRollup(inRange), [inRange]);
  const dailyInRange = useMemo(
    () => daily.filter((d) => d.date >= from),
    [daily, from]
  );
  const totalBasisMin = dailyInRange.reduce(
    (s, d) => s + d.downtimeMin + d.basisMin * d.events,
    0
  );
  const dtPct = totalBasisMin > 0 ? (roll.downtimeMin / totalBasisMin) * 100 : 0;
  const noCommentEvents = inRange.filter((e) => !e.comment.trim()).length;

  /* ------------------------------------------------------------------ import */

  const load = async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => /\.(xlsx|xls|xlsb)$/i.test(f.name));
    if (arr.length === 0) {
      setMsg("⚠ Only .xls / .xlsx / .xlsb files are supported");
      return;
    }
    setBusy(true);
    setMsg(null);
    for (const f of arr) {
      setQueue((qq) => [...qq, { file: f, status: "PARSING" }]);
      try {
        const r = await parseDowntimeWorkbook(f);
        setQueue((qq) => qq.map((x) => (x.file === f ? { file: f, status: "READY", result: r } : x)));
      } catch (e: any) {
        setQueue((qq) =>
          qq.map((x) => (x.file === f ? { file: f, status: "ERROR", error: e?.message ?? String(e) } : x))
        );
      }
    }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const commit = async () => {
    const ready = queue.filter((x) => x.status === "READY" && x.result);
    if (ready.length === 0) return;

    const lines = ready.map((x) => {
      const r = x.result!;
      const plan = planDowntimeMerge(r.events, r.meta, existing, meta);
      const mins = r.events.reduce((s, e) => s + (e.hasMinutes ? e.downtimeMin : 0), 0);
      return `• ${x.file.name}: ${r.sheets.length} sheet(s), ${fmtQty(plan.counts.added)} new, ` +
        `${fmtQty(plan.counts.replaced)} updated, ${fmtQty(plan.counts.removed)} removed · ` +
        `${fmtQty(mins)} min downtime (${fmtNum(mins / 60, 1)} hr)`;
    });

    if (
      !confirm(
        `Import ${ready.length} downtime workbook(s)?\n\n${lines.join("\n")}\n\n` +
          `Existing records for the same months are replaced, never duplicated. ` +
          `Downtime drives OEE availability.`
      )
    )
      return;

    setBusy(true);
    setMsg(null);
    const summary: string[] = [];
    try {
      // oldest month first so a later file wins if months overlap
      const sorted = [...ready].sort(
        (a, b) => (a.result!.months[0] ?? "").localeCompare(b.result!.months[0] ?? "")
      );
      for (const x of sorted) {
        const r = x.result!;
        const plan = planDowntimeMerge(r.events, r.meta, existing, meta);

        for (const key of plan.staleKeys) {
          const rec = existing.find((e) => e.key === key);
          if (rec?.id) await dbRemove(`downtime/${rec.id}`);
        }
        let added = 0;
        let updated = 0;
        for (const up of plan.upserts) {
          const prev = existing.find((e) => e.key === up.key);
          if (prev?.id) {
            // replace the node so a field cleared in the workbook stays cleared
            await dbSet(`downtime/${prev.id}`, up);
            updated++;
          } else {
            await dbPush("downtime", up);
            added++;
          }
        }
        for (const m of plan.metaUpserts) {
          const prev = meta.find((x2) => x2.key === m.key);
          if (prev?.id) await dbSet(`downtimeMeta/${prev.id}`, m);
          else await dbPush("downtimeMeta", m);
        }
        summary.push(
          `${x.file.name}: ${fmtQty(added)} added, ${fmtQty(updated)} updated, ${fmtQty(plan.staleKeys.length)} removed`
        );
      }
      setMsg("✔ " + summary.join(" | "));
      setQueue([]);
    } catch (e: any) {
      setMsg("⚠ " + (e?.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  };

  const clearMonth = async (month: string) => {
    const list = existing.filter((e) => e.month === month);
    if (list.length === 0) return;
    if (!confirm(`Delete all ${fmtQty(list.length)} downtime records for ${monthLabel(month)}?`)) return;
    setBusy(true);
    try {
      for (const e of list) if (e.id) await dbRemove(`downtime/${e.id}`);
      const m = meta.find((x) => x.key === month);
      if (m?.id) await dbRemove(`downtimeMeta/${m.id}`);
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------------------------------------------- edits */

  const saveEvent = async () => {
    if (!edit) return;
    if (!edit.machine.trim()) return alert("Machine / location is required");
    const rec: DowntimeRec = {
      ...edit,
      machine: edit.machine.trim(),
      problem: edit.problem.trim(),
      comment: edit.comment.trim(),
      month: edit.date.slice(0, 7),
      key: edit.key || `${edit.date}::${canonMachine(edit.machine)}::manual`,
      updatedAt: Date.now(),
    } as DowntimeRec;
    if (isNew) await dbPush("downtime", { ...rec, source: "XLS", createdAt: Date.now() });
    else await dbUpdate(`downtime/${edit.id}`, rec);
    setEdit(null);
  };

  const delEvent = async (row: DowntimeRec) => {
    if (!confirm(`Delete this downtime record (${row.date} ${row.machine})?`)) return;
    await dbRemove(`downtime/${row.id}`);
    setEdit(null);
  };

  /* ----------------------------------------------------------------- columns */

  const cols: Column<DowntimeRec>[] = [
    { key: "date", header: "Date", value: (r) => r.date },
    {
      key: "machine",
      header: "Machine",
      value: (r) => r.machine,
      render: (r) => <span className="font-mono text-xs">{r.machine || "-"}</span>,
    },
    {
      key: "type",
      header: "Type",
      value: (r) => r.problemType,
      render: (r) => (r.problemType ? <span className="text-xs text-sky-300">{r.problemType}</span> : "-"),
    },
    {
      key: "time",
      header: "From / To",
      value: (r) => `${r.timeFrom} – ${r.timeTo}`,
      render: (r) => (
        <span className="text-xs text-slate-400 whitespace-nowrap">
          {r.timeFrom || "?"}–{r.timeTo || "?"}
        </span>
      ),
    },
    {
      key: "min",
      header: "Downtime",
      align: "right",
      value: (r) => r.downtimeMin,
      render: (r) =>
        r.hasMinutes ? (
          <span className="font-semibold tabular-nums">{fmtQty(r.downtimeMin)}</span>
        ) : (
          <span className="text-slate-600" title="the sheet gave no minutes for this event">
            n/a
          </span>
        ),
    },
    {
      key: "problem",
      header: "Problem",
      value: (r) => r.problem,
      render: (r) => (
        <span className="block max-w-60 truncate" title={r.problem}>
          {r.problem || "-"}
        </span>
      ),
    },
    {
      key: "comment",
      header: "Comment",
      value: (r) => r.comment,
      render: (r) => (
        <span className="block max-w-48 truncate text-slate-400" title={r.comment}>
          {r.comment || "-"}
        </span>
      ),
    },
    { key: "op", header: "Operator", value: (r) => r.operator },
    { key: "mnt", header: "Maintenance", value: (r) => r.maintenance },
    {
      key: "share",
      header: "Share of day",
      align: "right",
      value: (r) => dailyIndex.get(`${r.date}::${canonMachine(r.machine)}`)?.availabilityPct ?? "",
      render: (r) => {
        const d = dailyIndex.get(`${r.date}::${canonMachine(r.machine)}`);
        if (!d) return "-";
        return (
          <span
            className="text-xs tabular-nums"
            title={`${fmtQty(d.downtimeMin)} min of ${fmtQty(d.basisMin)} min loading time`}
          >
            {fmtNum(d.availabilityPct, 1)}%
          </span>
        );
      },
    },
  ];

  const editDaily = edit ? dailyIndex.get(`${edit.date}::${canonMachine(edit.machine)}`) : null;

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Machine Downtime</h1>
          <p className="text-sm text-slate-500">
            Compiled downtime log. Drives the Availability component of OEE.
          </p>
        </div>
        <div className="flex gap-2">
          <select
            className="input !w-36"
            value={monthF}
            onChange={(e) => setMonthF(e.target.value)}
          >
            <option>ALL</option>
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
          <select
            className="input !w-36"
            value={machineF}
            onChange={(e) => setMachineF(e.target.value)}
          >
            <option value="ALL">All machines</option>
            {machines.map((m) => (
              <option key={canonMachine(m)} value={canonMachine(m)}>
                {m}
              </option>
            ))}
          </select>
          <select
            className="input !w-28"
            value={range}
            onChange={(e) => setRange(e.target.value as (typeof RANGES)[number]["key"])}
          >
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <SearchBox value={q} onChange={setQ} />
          <button className="btn-secondary" onClick={() => exportCsv("downtime.csv", rows, cols)}>
            Export
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEdit({
                date: todayISO(),
                month: todayISO().slice(0, 7),
                sheet: "",
                machine: "",
                problemType: "",
                problem: "",
                comment: "",
                operator: "",
                maintenance: "",
                remark: "",
                timeFrom: "",
                timeTo: "",
                downtimeMin: 0,
                hasMinutes: true,
                extraComments: 0,
                key: "",
                source: "XLS",
              });
              setIsNew(true);
            }}
          >
            + Add record
          </button>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".xls,.xlsx,.xlsb"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) load(e.target.files);
        }}
      />

      {msg && (
        <div
          className={`text-sm rounded px-3 py-2 ${
            msg.startsWith("✔")
              ? "text-emerald-300 bg-emerald-950/40 border border-emerald-900/60"
              : "text-rose-300 bg-rose-950/40 border border-rose-900/60"
          }`}
        >
          {msg}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
        <Stat label="Events" value={fmtQty(roll.events)} />
        <Stat label="Total Downtime" value={fmtQty(roll.downtimeMin)} sub="min" />
        <Stat label="Downtime Hours" value={fmtNum(roll.hours, 1)} sub="hr" />
        <Stat
          label="DT %"
          value={fmtNum(dtPct, 2)}
          sub="of loading time"
          tone={dtPct > 5 ? "danger" : dtPct > 2 ? "warn" : "ok"}
        />
        <Stat label="Machine-Days" value={fmtQty(dailyInRange.length)} />
        <Stat
          label="No Minutes"
          value={fmtQty(roll.unknownMinEvents)}
          sub="events"
          tone={roll.unknownMinEvents ? "warn" : "ok"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Breakdown title="Downtime by machine" rows={roll.byMachine} unitLabel="Machine" />
        <Breakdown
          title="Downtime by problem type (Comment column)"
          rows={roll.byComment}
          unitLabel="Comment"
          note={
            noCommentEvents > 0
              ? `${fmtQty(noCommentEvents)} of ${fmtQty(roll.events)} event(s) leave the Comment column blank, ` +
                `so most of the downtime cannot be attributed to a type.`
              : undefined
          }
        />
        <Breakdown title="Downtime by problem" rows={roll.byProblem} unitLabel="Problem" />
      </div>

      <Card title="Downtime records">
        <DataTable
          columns={cols}
          rows={rows}
          onRowClick={(r) => {
            setEdit(r);
            setIsNew(false);
          }}
          pageSize={60}
          dense
          emptyText="No downtime records in this range. Import the compiled downtime workbook below."
        />
      </Card>

      <Card title="Import compiled downtime workbook">
        <div className="space-y-3">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              if (e.dataTransfer.files?.length) load(e.dataTransfer.files);
            }}
            className={`border-2 border-dashed text-center py-8 cursor-pointer transition-colors ${
              drag ? "border-sky-500 bg-sky-950/30" : "border-slate-700"
            }`}
            onClick={() => fileRef.current?.click()}
          >
            <div className="text-sm text-slate-400">
              Drop the downtime workbook here, or click to browse
            </div>
            <div className="text-xs text-slate-600 mt-1">
              One sheet per month, e.g. &quot;JANUARY 26&quot;
            </div>
          </div>

          <div className="flex gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
              ⇪ Select file
            </button>
            <button
              className="btn-primary"
              disabled={busy || !queue.some((x) => x.status === "READY")}
              onClick={commit}
            >
              Import to Firebase
            </button>
          </div>

          {queue.map((x, i) => (
            <div key={`${x.file.name}-${i}`} className="text-sm">
              {x.status === "PARSING" && <div className="text-slate-400">Parsing {x.file.name}…</div>}
              {x.status === "ERROR" && (
                <div className="text-rose-300">
                  <span className="font-semibold">{x.file.name}</span> — ⚠ {x.error}
                </div>
              )}
              {x.status === "READY" && x.result && (
                <div className="rounded border border-slate-800 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold">{x.file.name}</div>
                    <button
                      className="btn-secondary !py-1 !px-2"
                      onClick={() => setQueue((prev) => prev.filter((_, k) => k !== i))}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {x.result.sheets.map((s) => {
                      const mins = s.events.reduce((a, e) => a + (e.hasMinutes ? e.downtimeMin : 0), 0);
                      return (
                        <Badge key={s.sheet} tone="info">
                          {s.sheet} · {fmtQty(s.events.length)} ev · {fmtQty(mins)} min
                        </Badge>
                      );
                    })}
                  </div>
                  {x.result.warnings.length > 0 && (
                    <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900/50 rounded px-3 py-2 space-y-1">
                      {x.result.warnings.map((w, k) => (
                        <div key={k}>⚠ {w}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {existing.length > 0 && (
        <Card title="Stored in Firebase">
          <div className="flex flex-wrap gap-2">
            {months.map((m) => (
              <div
                key={m}
                className="flex items-center gap-2 rounded border border-slate-800 px-2 py-1"
              >
                <span className="text-xs text-slate-300">{monthLabel(m)}</span>
                <span className="text-xs text-slate-500">
                  {fmtQty(existing.filter((e) => e.month === m).length)}
                </span>
                <button
                  className="text-[10px] text-rose-400 hover:text-rose-300"
                  onClick={() => clearMonth(m)}
                >
                  delete
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {edit && (
        <Modal
          title={isNew ? "Add downtime record" : `Downtime — ${edit.date} ${edit.machine}`}
          onClose={() => setEdit(null)}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Date">
              <input
                type="date"
                className="input"
                value={edit.date}
                onChange={(e) => setEdit({ ...edit, date: e.target.value })}
              />
            </Field>
            <Field label="Machine / Location">
              <input
                className="input"
                list="dt-machines"
                value={edit.machine}
                onChange={(e) => setEdit({ ...edit, machine: e.target.value })}
              />
              <datalist id="dt-machines">
                {machines.map((m) => (
                  <option key={canonMachine(m)} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label="Time From">
              <input
                className="input"
                placeholder="8.30am"
                value={edit.timeFrom}
                onChange={(e) => setEdit({ ...edit, timeFrom: e.target.value })}
              />
            </Field>
            <Field label="Time To">
              <input
                className="input"
                placeholder="9.05am"
                value={edit.timeTo}
                onChange={(e) => setEdit({ ...edit, timeTo: e.target.value })}
              />
            </Field>
            <Field label="Downtime (minutes)">
              <input
                type="number"
                min={0}
                className="input"
                value={edit.downtimeMin}
                onChange={(e) =>
                  setEdit({ ...edit, downtimeMin: +e.target.value, hasMinutes: true })
                }
              />
            </Field>
            <Field label="Problem Type">
              <input
                className="input"
                value={edit.problemType}
                onChange={(e) => setEdit({ ...edit, problemType: e.target.value })}
              />
            </Field>
            <Field label="Problem">
              <input
                className="input"
                value={edit.problem}
                onChange={(e) => setEdit({ ...edit, problem: e.target.value })}
              />
            </Field>
            <Field label="Comment">
              <input
                className="input"
                value={edit.comment}
                onChange={(e) => setEdit({ ...edit, comment: e.target.value })}
              />
            </Field>
            <Field label="Operator">
              <input
                className="input"
                value={edit.operator}
                onChange={(e) => setEdit({ ...edit, operator: e.target.value })}
              />
            </Field>
            <Field label="Maintenance">
              <input
                className="input"
                value={edit.maintenance}
                onChange={(e) => setEdit({ ...edit, maintenance: e.target.value })}
              />
            </Field>
            <Field label="Remark">
              <input
                className="input"
                value={edit.remark}
                onChange={(e) => setEdit({ ...edit, remark: e.target.value })}
              />
            </Field>
          </div>

          {editDaily && (
            <p className="mt-3 text-xs text-slate-400">
              This machine-day now carries {fmtQty(editDaily.downtimeMin)} min of downtime across{" "}
              {fmtQty(editDaily.events)} event(s), giving{" "}
              <span className="text-sky-300">
                {fmtNum(editDaily.availabilityPct, 1)}% availability
              </span>{" "}
              against a {fmtQty(editDaily.basisMin)} min loading time.
            </p>
          )}

          <div className="flex justify-between mt-4">
            {!isNew && (
              <button className="btn-danger" onClick={() => delEvent(edit)}>
                Delete
              </button>
            )}
            <div className="flex gap-2 ml-auto">
              <button className="btn-secondary" onClick={() => setEdit(null)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={saveEvent}>
                Save
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Breakdown({
  title,
  rows,
  unitLabel,
  note,
}: {
  title: string;
  rows: { machine?: string; label?: string; minutes: number; events: number }[];
  unitLabel: string;
  note?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.minutes));
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <div className="text-sm text-slate-500 py-3 text-center">No downtime recorded</div>
      ) : (
        <>
          <div className="space-y-2">
            {rows.map((r) => {
              const label = r.machine ?? r.label ?? "";
              return (
                <div key={label}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className="text-xs text-slate-300 truncate"
                      title={`${unitLabel}: ${label}`}
                    >
                      {label || "(blank)"}
                    </span>
                    <span className="text-xs text-slate-500 tabular-nums whitespace-nowrap">
                      {fmtQty(r.minutes)} min · {fmtQty(r.events)} ev
                    </span>
                  </div>
                  <div className="h-1.5 mt-1 rounded bg-slate-800 overflow-hidden">
                    <div
                      className={
                        label === "(blank)" ? "h-full bg-slate-600 rounded" : "h-full bg-amber-500/80 rounded"
                      }
                      style={{ width: `${(r.minutes / max) * 100}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {note && <p className="mt-3 text-xs text-amber-300/90">{note}</p>}
        </>
      )}
    </Card>
  );
}
