import { useRef, useState } from "react";
import { Card, Stat, Badge } from "../components/ui";
import { parseWorkbook, type ParseResult } from "../lib/excel";
import { parseMaintenanceWorkbook, type MaintParseResult } from "../lib/maintExcel";
import { dbPush, dbSet, dbRemove, dbGet, dbUpdate } from "../lib/db";
import { detectSnapshotMonth, mergeMaintImport } from "../lib/maintImport";
import { detectScMonth, buildScMergeOps } from "../lib/scImport";
import { fmtQty } from "../lib/format";
import { DEFAULT_SETTINGS, type Settings } from "../types";
import { useDb } from "../db-context";

interface QueuedFile {
  file: File;
  kind: "supply-chain" | "maintenance";
  status: "PENDING" | "PARSING" | "READY" | "ERROR";
  result?: ParseResult | MaintParseResult;
  error?: string;
}

function detectKind(file: File): "supply-chain" | "maintenance" {
  const n = file.name.toUpperCase();
  if (n.includes("MAINTENANCE") || n.includes("IE ") || n.includes("IE&") || n.includes("IE &")) return "maintenance";
  if (n.includes("MRP") || n.includes("PLAN")) return "supply-chain";
  return "supply-chain"; // default
}

export default function ImportPage() {
  const db = useDb();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addFiles = async (files: FileList | File[]) => {
    setDone(null);
    setError(null);
    const arr = Array.from(files).filter((f) => /\.(xlsx|xls)$/i.test(f.name));
    if (arr.length === 0) {
      setError("Only .xlsx / .xls files are supported");
      return;
    }
    const queued: QueuedFile[] = arr.map((file) => ({
      file,
      kind: detectKind(file),
      status: "PENDING",
    }));
    setQueue(queued);
    setBusy(true);
    for (let i = 0; i < queued.length; i++) {
      setQueue((q) => q.map((x, j) => (j === i ? { ...x, status: "PARSING" } : x)));
      try {
        if (queued[i].kind === "maintenance") {
          const r = await parseMaintenanceWorkbook(queued[i].file, detectSnapshotMonth(queued[i].file.name));
          setQueue((q) => q.map((x, j) => (j === i ? { ...x, status: "READY", result: r } : x)));
        } else {
          const r = await parseWorkbook(queued[i].file);
          setQueue((q) => q.map((x, j) => (j === i ? { ...x, status: "READY", result: r } : x)));
        }
      } catch (e: any) {
        setQueue((q) =>
          q.map((x, j) => (j === i ? { ...x, status: "ERROR", error: e.message ?? String(e) } : x))
        );
      }
    }
    setBusy(false);
  };

  const removeFile = (idx: number) => setQueue((q) => q.filter((_, j) => j !== idx));

  const commitAll = async () => {
    const ready = queue.filter((x) => x.status === "READY");
    if (ready.length === 0) return;
      if (
        !confirm(
          `Import ${ready.length} workbook(s) to Firebase?\n\n` +
            ready.map((x) => `• ${x.file.name} (${x.kind})`).join("\n") +
            `\n\nBoth workbook types merge as monthly snapshots:\n` +
            `existing parts/items are matched and updated in place — never duplicated.\n` +
            `PO lines stay OPEN; stock is snapshotted per month.`
        )
      )
        return;
    setBusy(true);
    try {
      const summary: string[] = [];

      // apply supply-chain workbooks first (settings merge), then maintenance
      const scSorted = (ready.filter((x) => x.kind === "supply-chain") as (QueuedFile & { result: ParseResult })[])
        .map((x) => ({ ...x, month: detectScMonth(x.file.name) }))
        .sort((a, b) => a.month.localeCompare(b.month));
      const mtSorted = (ready.filter((x) => x.kind === "maintenance") as (QueuedFile & { result: MaintParseResult })[])
        .map((x) => ({ ...x, month: detectSnapshotMonth(x.file.name) }))
        .sort((a, b) => a.month.localeCompare(b.month));

      let settings: Settings = { ...DEFAULT_SETTINGS };
      const existingSettings = await dbGet("settings");
      if (existingSettings) {
        settings = { ...settings, ...(Object.values(existingSettings)[0] as Settings) };
      }
      let anySc = false;

      for (const x of scSorted) {
        const r = x.result;
        const ops = buildScMergeOps(db, r);

        for (const id of ops.stockRemoves) await dbRemove(`rawStock/${id}`);
        for (const a of ops.itemAdds) await dbPush("items", a);
        for (const u of ops.itemUpdates) await dbUpdate(`items/${u.id}`, u.rec);
        for (const a of ops.stockAdds) await dbPush("rawStock", a);
        for (const u of ops.stockUpdates) await dbUpdate(`rawStock/${u.id}`, u.rec);
        for (const a of ops.fgAdds) await dbPush("fgStock", a);
        for (const u of ops.fgUpdates) await dbUpdate(`fgStock/${u.id}`, u.rec);
        for (const a of ops.poAdds) await dbPush("poLines", a);
        for (const u of ops.poUpdates) await dbUpdate(`poLines/${u.id}`, u.rec);
        for (const a of ops.fcAdds) await dbPush("forecasts", a);
        for (const u of ops.fcUpdates) await dbUpdate(`forecasts/${u.id}`, u.rec);
        for (const a of ops.bomAdds) await dbPush("bom", a);
        for (const u of ops.bomKeyUpdates) await dbUpdate(`bom/${u.key}`, u.rec);

        if (r.planMonth) settings.planMonth = r.planMonth;
        if (r.monthlySeries.length >= (settings.monthlySeries?.length ?? 0)) {
          settings.monthlySeries = r.monthlySeries;
        } else {
          for (const ym of r.monthlySeries)
            if (!settings.monthlySeries.includes(ym)) settings.monthlySeries.push(ym);
        }
        settings.monthlySeries.sort();
        anySc = true;
        const c = ops.counts;
        summary.push(
          `${x.file.name} (${x.month}): items ${c.itemsUpdated}u/${c.itemsAdded}a, stock ${c.stockUpdated}u/${c.stockAdded}a, PO ${c.poUpdated}u/${c.poAdded}a, fc ${c.fcUpdated}u/${c.fcAdded}a, bom ${c.bomUpdated}u/${c.bomAdded}a`
        );
      }

      if (anySc) {
        if (existingSettings && typeof existingSettings === "object") {
          const firstKey = Object.keys(existingSettings)[0];
          if (firstKey) await dbSet(`settings/${firstKey}`, settings);
          else await dbPush("settings", settings);
        } else {
          await dbPush("settings", settings);
        }
      }

      // maintenance: month-aware merge, oldest first
      let current = [...(db.maintParts ?? [])];
      for (const x of mtSorted) {
        const r = x.result;
        const month = x.month;
        const outcome = mergeMaintImport(current, r.parts, month);
        for (const a of outcome.add) {
          const id = await dbPush("maintParts", a);
          current = [...current, { ...a, id }];
        }
        for (const u of outcome.update) {
          await dbUpdate(`maintParts/${u.id}`, u.rec);
          current = current.map((p) => (p.id === u.id ? { ...u.rec, id: u.id } : p));
        }
        summary.push(
          `${x.file.name} (${month}): ${fmtQty(outcome.updatedCount)} updated, ${fmtQty(outcome.addedCount)} added`
        );
      }

      setDone(summary.join("\n"));
      setQueue([]);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const totalStats = queue.reduce(
    (acc, x) => {
      if (x.status !== "READY" || !x.result) return acc;
      if (x.kind === "supply-chain") {
        const r = x.result as ParseResult;
        acc.items += r.items.length;
        acc.stock += r.rawStock.length;
        acc.po += r.poLines.length;
        acc.fc += r.forecasts.length;
        acc.bom += r.bom.length;
      } else {
        acc.maint += (x.result as MaintParseResult).parts.length;
      }
      return acc;
    },
    { items: 0, stock: 0, po: 0, fc: 0, bom: 0, maint: 0 }
  );

  const readyCount = queue.filter((x) => x.status === "READY").length;

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-bold">Import Excel</h1>
        <p className="text-sm text-slate-500">
          Select or drop multiple workbooks at once. Supply-chain MRP workbooks (MASTER LIST, Raw
          Stock, OPEN PO, Forecast, BOM…) and Maintenance stock workbooks are auto-detected by file
          name.
        </p>
      </div>

      <Card>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
          }}
        />
        <div
          className="border-2 border-dashed border-slate-700 rounded-lg p-10 text-center cursor-pointer hover:border-sky-600 transition-colors"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
          }}
        >
          {busy ? (
            <div className="text-sky-400">Parsing workbooks…</div>
          ) : (
            <>
              <div className="text-3xl mb-2">⇪</div>
              <div className="text-sm text-slate-400">
                Click to select multiple Excel files, or drop them here
              </div>
            </>
          )}
        </div>
      </Card>

      {error && (
        <Card>
          <div className="text-rose-400 text-sm">Error: {error}</div>
        </Card>
      )}

      {queue.length > 0 && (
        <>
          <Card title={`Queue — ${queue.length} file(s)`}>
            <div className="space-y-2">
              {queue.map((x, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 bg-slate-800/50 rounded p-2 text-sm"
                >
                  <Badge tone={x.kind === "supply-chain" ? "info" : "warn"}>
                    {x.kind === "supply-chain" ? "SUPPLY CHAIN" : "MAINTENANCE"}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{x.file.name}</div>
                    <div className="text-xs text-slate-500">
                      {(x.file.size / 1024).toFixed(0)} KB
                      {x.status === "READY" &&
                        (x.kind === "supply-chain"
                          ? ` · ${fmtQty((x.result as ParseResult).items.length)} items, ${fmtQty((x.result as ParseResult).rawStock.length)} stock lines`
                          : ` · ${fmtQty((x.result as MaintParseResult).parts.length)} parts`)}
                      {x.status === "ERROR" && <span className="text-rose-400"> · {x.error}</span>}
                    </div>
                  </div>
                  {x.status === "PARSING" && <span className="text-sky-400 text-xs">parsing…</span>}
                  {x.status === "READY" && <span className="text-emerald-400 text-xs">ready ✔</span>}
                  {x.status === "ERROR" && <span className="text-rose-400 text-xs">failed ✕</span>}
                  <button
                    className="text-slate-500 hover:text-slate-300 px-1"
                    title="Remove from queue"
                    onClick={() => removeFile(i)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </Card>

          {readyCount > 0 && (
            <>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 sm:gap-3">
                <Stat label="Items" value={fmtQty(totalStats.items)} />
                <Stat label="Stock Lines" value={fmtQty(totalStats.stock)} />
                <Stat label="PO Lines" value={fmtQty(totalStats.po)} />
                <Stat label="Forecast" value={fmtQty(totalStats.fc)} />
                <Stat label="BOM Lines" value={fmtQty(totalStats.bom)} />
                <Stat label="Maint Parts" value={fmtQty(totalStats.maint)} />
              </div>

              <Card title="Detected plans & warnings">
                <div className="space-y-2 text-sm">
                  {queue
                    .filter((x) => x.status === "READY")
                    .map((x) => (
                      <div key={x.file.name}>
                        <div className="font-medium">{x.file.name}</div>
                        {x.kind === "supply-chain" ? (
                          <div className="text-xs text-slate-400">
                            Plan month: <Badge tone="info">{(x.result as ParseResult).planMonth || "n/a"}</Badge>{" "}
                            · suppliers: {(x.result as ParseResult).suppliers.length}
                            {(x.result as ParseResult).warnings.map((w, i) => (
                              <div key={i} className="text-amber-400">⚠ {w}</div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs text-slate-400">
                            {fmtQty((x.result as MaintParseResult).parts.length)} parts
                            {(x.result as MaintParseResult).warnings.map((w, i) => (
                              <div key={i} className="text-amber-400">⚠ {w}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </Card>

              <div className="flex gap-2">
                <button className="btn-primary" disabled={busy} onClick={commitAll}>
                  {busy ? "Uploading to Firebase…" : `Import ${readyCount} file(s)`}
                </button>
                <button className="btn-secondary" disabled={busy} onClick={() => setQueue([])}>
                  Discard all
                </button>
              </div>
              <p className="text-xs text-slate-500">
                ⚠ Importing replaces the respective collections in Firebase (supply chain: Items /
                Inventory / POs / Forecast / BOM + settings; maintenance: spare parts). Manual edits
                made after the last import will be lost.
              </p>
            </>
          )}
        </>
      )}

      {done && (
        <Card>
          <div className="text-emerald-400 text-sm whitespace-pre-line">✔ {done}</div>
        </Card>
      )}
    </div>
  );
}
