import { useRef, useState } from "react";
import { Badge, Card, DataTable, Stat, type Column } from "../components/ui";
import { dbPush, dbRemove, dbSet } from "../lib/db";
import { fmtNum, fmtQty } from "../lib/format";
import { monthLabel } from "../lib/format";
import { parseIpqcWorkbook, type IpqcAgg, type IpqcParseResult } from "../lib/ipqcExcel";
import { planIpqcMerge, type IpqcDailyRec } from "../lib/ipqcMerge";
import { useDb } from "../db-context";

type Queued = {
  file: File;
  status: "PARSING" | "READY" | "ERROR";
  result?: IpqcParseResult;
  error?: string;
};

export default function ProductionImport() {
  const db = useDb();
  const [queue, setQueue] = useState<Queued[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const existing = (db.prodIpqc ?? []) as IpqcDailyRec[];

  const load = async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => /\.(xlsx|xls|xlsb)$/i.test(f.name));
    if (arr.length === 0) {
      setMsg("⚠ Only .xls / .xlsx / .xlsb files are supported");
      return;
    }
    setBusy(true);
    setMsg(null);
    for (const f of arr) {
      setQueue((q) => [...q, { file: f, status: "PARSING" }]);
      try {
        const r = await parseIpqcWorkbook(f);
        setQueue((q) =>
          q.map((x) => (x.file === f ? { file: f, status: "READY", result: r } : x))
        );
      } catch (e: any) {
        setQueue((q) =>
          q.map((x) =>
            x.file === f ? { file: f, status: "ERROR", error: e?.message ?? String(e) } : x
          )
        );
      }
    }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const commit = async () => {
    const ready = queue.filter((q) => q.status === "READY" && q.result);
    if (ready.length === 0) return;

    const lines = ready.map((q) => {
      const r = q.result!;
      const plan = planIpqcMerge(r, existing);
      return `• ${q.file.name} (${monthLabel(r.month)}): ${fmtQty(plan.counts.added)} new, ` +
        `${fmtQty(plan.counts.replaced - plan.counts.added)} updated, ` +
        `${fmtQty(plan.counts.removed)} removed · ${fmtQty(r.totals.defQty)} defects / ` +
        `${fmtQty(r.totals.qtyCheck)} checked · DPM ${fmtNum(r.totals.dpm, 2)}`;
    });

    if (
      !confirm(
        `Import ${ready.length} IPQC workbook(s)?\n\n${lines.join("\n")}\n\n` +
          `Existing machine-days for the same month are replaced, never duplicated.`
      )
    )
      return;

    setBusy(true);
    setMsg(null);
    const summary: string[] = [];
    try {
      // oldest month first so a later file wins if months overlap
      const sorted = [...ready].sort((a, b) => a.result!.month.localeCompare(b.result!.month));
      for (const q of sorted) {
        const r = q.result!;
        const plan = planIpqcMerge(r, existing);

        // drop anything the workbook no longer contains
        for (const key of plan.staleKeys) {
          const rec = existing.find((x) => x.key === key);
          if (rec?.id) await dbRemove(`prodIpqc/${rec.id}`);
        }
        let added = 0;
        let updated = 0;
        for (const up of plan.upserts) {
          const prev = existing.find((x) => x.key === up.key);
          if (prev?.id) {
            // replace the node, otherwise stale fields would linger
            await dbSet(`prodIpqc/${prev.id}`, up);
            updated++;
          } else {
            await dbPush("prodIpqc", up);
            added++;
          }
        }
        summary.push(
          `${q.file.name} → ${monthLabel(r.month)}: ${fmtQty(added)} added, ${fmtQty(updated)} updated, ${fmtQty(plan.staleKeys.length)} removed`
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
    const rows = existing.filter((r) => r.month === month);
    if (rows.length === 0) return;
    if (!confirm(`Delete all ${fmtQty(rows.length)} IPQC machine-day records for ${monthLabel(month)}?`)) return;
    setBusy(true);
    try {
      for (const r of rows) if (r.id) await dbRemove(`prodIpqc/${r.id}`);
    } finally {
      setBusy(false);
    }
  };

  const previewCols: Column<IpqcAgg>[] = [
    { key: "date", header: "Date", value: (a) => a.date },
    { key: "machine", header: "Machine", value: (a) => a.machine },
    { key: "shift", header: "Shift", value: (a) => a.shift || "-" },
    { key: "chk", header: "Qty Checked", value: (a) => a.qtyCheck, align: "right" },
    { key: "def", header: "Defects", value: (a) => a.defQty, align: "right" },
    {
      key: "dpm",
      header: "DPM",
      value: (a) => a.dpm,
      align: "right",
      render: (a) => fmtNum(a.dpm, 1),
    },
    {
      key: "top",
      header: "Top defect",
      value: (a) => a.topDefect,
      render: (a) => (a.topDefect ? `${a.topDefect} (${fmtQty(a.topDefectQty)})` : "-"),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Import IPQC</h1>
          <p className="text-sm text-slate-500">
            Monthly IPQC output workbooks, e.g. <span className="font-mono">09-IPQC  09-SEPT-26.xls</span>
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            ⇪ Select files
          </button>
          <button
            className="btn-primary"
            disabled={busy || !queue.some((q) => q.status === "READY")}
            onClick={commit}
          >
            Import to Firebase
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
        className={`card border-2 border-dashed text-center py-8 cursor-pointer transition-colors ${
          drag ? "border-sky-500 bg-sky-950/30" : "border-slate-700"
        }`}
        onClick={() => fileRef.current?.click()}
      >
        <div className="text-sm text-slate-400">
          Drop IPQC workbooks here, or click to browse
        </div>
        <div className="text-xs text-slate-600 mt-1">Multiple months supported</div>
      </div>

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

      {queue.length > 0 && (
        <div className="space-y-3">
          {queue.map((q, i) => (
            <Card key={`${q.file.name}-${i}`}>
              {q.status === "PARSING" && <div className="text-sm text-slate-400">Parsing {q.file.name}…</div>}

              {q.status === "ERROR" && (
                <div className="text-sm text-rose-300">
                  <div className="font-semibold">{q.file.name}</div>
                  <div className="text-xs mt-1">⚠ {q.error}</div>
                </div>
              )}

              {q.status === "READY" && q.result && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-sm">{q.file.name}</div>
                      <div className="text-xs text-slate-500">
                        {q.result.title} · {q.result.machines.length} machines ·{" "}
                        {q.result.shifts.join(" / ") || "no shift"}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone="info">{monthLabel(q.result.month)}</Badge>
                      <button
                        className="btn-secondary !py-1 !px-2"
                        onClick={() => setQueue((prev) => prev.filter((_, k) => k !== i))}
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    <Stat label="Rows" value={fmtQty(q.result.totals.rows)} />
                    <Stat label="Inspections" value={fmtQty(q.result.totals.inspections)} />
                    <Stat label="Defects" value={fmtQty(q.result.totals.defQty)} />
                    <Stat label="Qty Checked" value={fmtQty(q.result.totals.qtyCheck)} />
                    <Stat
                      label="DPM"
                      value={fmtNum(q.result.totals.dpm, 2)}
                      sub={
                        q.result.reportedDpm !== null
                          ? `sheet says ${fmtNum(q.result.reportedDpm, 2)}`
                          : undefined
                      }
                    />
                  </div>

                  {q.result.warnings.length > 0 && (
                    <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900/50 rounded px-3 py-2 space-y-1">
                      {q.result.warnings.map((w, k) => (
                        <div key={k}>⚠ {w}</div>
                      ))}
                    </div>
                  )}

                  <DataTable
                    columns={previewCols}
                    rows={q.result.aggs}
                    pageSize={8}
                    dense
                    emptyText="No rows parsed"
                  />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <StoredSummary existing={existing} onClear={clearMonth} />
    </div>
  );
}

function StoredSummary({
  existing,
  onClear,
}: {
  existing: IpqcDailyRec[];
  onClear: (month: string) => void;
}) {
  const months = [...new Set(existing.map((r) => r.month))].sort().reverse();
  const grand = existing.reduce(
    (s, r) => ({
      qtyCheck: s.qtyCheck + Number(r.qtyCheck || 0),
      defQty: s.defQty + Number(r.defQty || 0),
    }),
    { qtyCheck: 0, defQty: 0 }
  );

  return (
    <Card title="Stored in Firebase">
      {existing.length === 0 ? (
        <div className="text-sm text-slate-500 py-4 text-center">
          Nothing imported yet.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Records" value={fmtQty(existing.length)} />
            <Stat label="Months" value={fmtQty(months.length)} />
            <Stat label="Defects" value={fmtQty(grand.defQty)} />
            <Stat label="Qty Checked" value={fmtQty(grand.qtyCheck)} />
          </div>
          <div className="flex flex-wrap gap-2">
            {months.map((m) => (
              <div
                key={m}
                className="flex items-center gap-2 rounded border border-slate-800 px-2 py-1"
              >
                <span className="text-xs text-slate-300">{monthLabel(m)}</span>
                <span className="text-xs text-slate-500">
                  {fmtQty(existing.filter((r) => r.month === m).length)}
                </span>
                <button
                  className="text-[10px] text-rose-400 hover:text-rose-300"
                  onClick={() => onClear(m)}
                >
                  delete
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
