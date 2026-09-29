import { useMemo, useRef, useState } from "react";
import { Card, DataTable, Modal, Field, SearchBox, exportCsv, Badge, Stat, type Column } from "../components/ui";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, LineChart, Line } from "recharts";
import { fmtMoney, fmtQty, monthLabel, todayISO } from "../lib/format";
import { dbPush, dbUpdate, dbRemove } from "../lib/db";
import { parseMaintenanceWorkbook } from "../lib/maintExcel";
import { detectSnapshotMonth, mergeMaintImport } from "../lib/maintImport";
import type { MaintIssue, MaintPart } from "../types";
import type { DbData } from "../db-context";

const CATEGORIES = [
  "MACHINE",
  "APPLICATOR",
  "POLE (IE)",
  "BANDGUN (IE)",
  "FACILITIES",
  "PRINT FACILITIES",
  "RAW MATERIAL (IE)",
];

export default function Maintenance({ db }: { db: DbData }) {
  const [catF, setCatF] = useState<string>(CATEGORIES[0]);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<MaintPart | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [issuePart, setIssuePart] = useState<MaintPart | null>(null);
  const [issueType, setIssueType] = useState<"ISSUE" | "RECEIVE">("ISSUE");
  const [issueQty, setIssueQty] = useState(1);
  const [issueNotes, setIssueNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const catParts = useMemo(
    () => db.maintParts.filter((p) => p.category === catF),
    [db.maintParts, catF]
  );

  const rows = useMemo(() => {
    const n = q.toLowerCase();
    return catParts
      .filter(
        (p) =>
          !n ||
          p.name.toLowerCase().includes(n) ||
          p.partNo.toLowerCase().includes(n) ||
          p.machineModel.toLowerCase().includes(n) ||
          p.location.toLowerCase().includes(n)
      )
      .sort((a, b) => {
        const na = Number(a.no), nb = Number(b.no);
        if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
        return a.name.localeCompare(b.name);
      });
  }, [catParts, q]);

  const catStats = useMemo(() => {
    const total = catParts.length;
    const below = catParts.filter((p) => p.currentStock < p.minStock).length;
    const toOrder = catParts.filter((p) => p.qtyToOrder > 0).length;
    return { total, below, toOrder };
  }, [catParts]);

  const recentIssues = useMemo(() => {
    return db.maintIssues
      .filter((i) => i.category === catF)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 8);
  }, [db.maintIssues, catF]);

  const usage6 = (p: MaintPart): Record<string, number> => {
    // last 6 months ending this month
    const out: Record<string, number> = {};
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const ym = d.toISOString().slice(0, 7);
      out[ym] = p.usage?.[ym] ?? 0;
    }
    return out;
  };

  const avgMonthlyUse = (p: MaintPart) => {
    const u = usage6(p);
    const vals = Object.values(u);
    return vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
  };

  // ---- charts & summary ----
  const usageTrend = useMemo(() => {
    // total consumed per month across the category, last 6 months
    const out: { month: string; qty: number }[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const ym = d.toISOString().slice(0, 7);
      const qty = catParts.reduce((s, p) => s + (p.usage?.[ym] ?? 0), 0);
      out.push({ month: monthLabel(ym), qty: Math.round(qty) });
    }
    return out;
  }, [catParts]);

  const topConsumed = useMemo(() => {
    // top 8 parts by total usage over last 6 months
    return catParts
      .map((p) => ({
        name: p.name.length > 18 ? p.name.slice(0, 18) + "…" : p.name,
        fullName: p.name,
        qty: Math.round(Object.values(usage6(p)).reduce((s, v) => s + v, 0)),
      }))
      .filter((x) => x.qty > 0)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 8);
  }, [catParts]);

  const summary = useMemo(() => {
    const totalUsage6 = catParts.reduce(
      (s, p) => s + Object.values(usage6(p)).reduce((a, v) => a + v, 0),
      0
    );
    const orderCost = catParts.reduce((s, p) => s + p.qtyToOrder * p.price, 0);
    const belowParts = catParts.filter((p) => p.currentStock < p.minStock);
    const belowCost = belowParts.reduce((s, p) => s + (p.minStock - p.currentStock) * p.price, 0);
    const issues30 = db.maintIssues.filter(
      (i) => i.category === catF && i.type === "ISSUE" && Date.now() - i.createdAt <= 30 * 24 * 3600 * 1000
    );
    return {
      totalUsage6: Math.round(totalUsage6),
      orderCost,
      belowCost,
      belowParts: belowParts.length,
      issues30: issues30.length,
      issues30Qty: issues30.reduce((s, i) => s + i.qty, 0),
      zeroStock: catParts.filter((p) => p.currentStock <= 0).length,
    };
  }, [catParts, db.maintIssues, catF]);

  // stock level trend from monthly import snapshots
  const stockTrend = useMemo(() => {
    const out: { month: string; total: number }[] = [];
    const months = new Set<string>();
    for (const p of catParts) for (const ym of Object.keys(p.monthStock ?? {})) months.add(ym);
    const sorted = [...months].sort().slice(-12);
    for (const ym of sorted) {
      out.push({
        month: monthLabel(ym),
        total: catParts.reduce((s, p) => s + (p.monthStock?.[ym] ?? 0), 0),
      });
    }
    return out;
  }, [catParts]);

  const save = async () => {
    if (!edit || !edit.name.trim()) {
      alert("Part name is required");
      return;
    }
    setBusy(true);
    try {
      const rec = { ...edit, updatedAt: Date.now() };
      if (isNew) await dbPush("maintParts", rec);
      else await dbUpdate(`maintParts/${edit.id}`, rec);
      setEdit(null);
    } finally {
      setBusy(false);
    }
  };

  const del = async (p: MaintPart) => {
    if (!confirm(`Delete ${p.name} (${p.category})? Movement history stays but loses its link.`)) return;
    await dbRemove(`maintParts/${p.id}`);
  };

  const submitIssue = async () => {
    if (!issuePart || issueQty <= 0) {
      alert("Enter a quantity > 0");
      return;
    }
    setBusy(true);
    try {
      const movement: Omit<MaintIssue, "id"> = {
        partId: issuePart.id ?? "",
        partNo: issuePart.partNo,
        partName: issuePart.name,
        category: issuePart.category,
        type: issueType,
        qty: issueQty,
        notes: issueNotes,
        createdAt: Date.now(),
      };
      await dbPush("maintIssues", movement);
      const nextStock =
        issueType === "ISSUE"
          ? issuePart.currentStock - issueQty
          : issuePart.currentStock + issueQty;
      await dbUpdate(`maintParts/${issuePart.id}`, {
        currentStock: nextStock,
        updatedAt: Date.now(),
      });
      setIssuePart(null);
      setIssueQty(1);
      setIssueNotes("");
    } finally {
      setBusy(false);
    }
  };

  const onImport = async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => /\.(xlsx|xls)$/i.test(f.name));
    if (arr.length === 0) {
      setImportMsg("⚠ Only .xlsx / .xls files are supported");
      return;
    }
    setBusy(true);
    setImportMsg(null);
    try {
      const parsed: {
        name: string;
        month: string;
        r: Awaited<ReturnType<typeof parseMaintenanceWorkbook>>;
      }[] = [];
      const errors: string[] = [];
      for (const f of arr) {
        try {
          const r = await parseMaintenanceWorkbook(f, detectSnapshotMonth(f.name));
          parsed.push({ name: f.name, month: detectSnapshotMonth(f.name), r });
        } catch (e: any) {
          errors.push(`${f.name}: ${e.message ?? String(e)}`);
        }
      }
      const totalParts = parsed.reduce((s, x) => s + x.r.parts.length, 0);
      if (totalParts === 0) {
        setImportMsg(
          "⚠ " +
            (errors.join(" | ") ||
              parsed.map((x) => x.r.warnings.join(" ")).join(" ") ||
              "No parts found")
        );
        return;
      }
      const summary = parsed
        .map((x) => `• ${x.name} → ${monthLabel(x.month)}: ${fmtQty(x.r.parts.length)} parts`)
        .join("\n");
      if (
        !confirm(
          `Parsed ${fmtQty(totalParts)} spare part rows from ${parsed.length} file(s):\n${summary}` +
            (errors.length ? `\n⚠ Failed: ${errors.join(" | ")}` : "") +
            `\n\nExisting parts are MATCHED by part no and UPDATED in place (no duplicates).\n` +
            `Stock is snapshotted under each file's month. New parts are added.\n\nContinue?`
        )
      ) {
        return;
      }

      let totalAdded = 0;
      let totalUpdated = 0;
      // process oldest month first so newer files overwrite older snapshots
      parsed.sort((a, b) => a.month.localeCompare(b.month));
      let current = [...db.maintParts];
      for (const x of parsed) {
        const outcome = mergeMaintImport(current, x.r.parts, x.month);
        for (const a of outcome.add) {
          const id = await dbPush("maintParts", a);
          current = [...current, { ...a, id }];
        }
        for (const u of outcome.update) {
          await dbUpdate(`maintParts/${u.id}`, u.rec as unknown as Record<string, unknown>);
          current = current.map((p) => (p.id === u.id ? { ...u.rec, id: u.id } : p));
        }
        totalAdded += outcome.addedCount;
        totalUpdated += outcome.updatedCount;
      }
      setImportMsg(
        `✔ Import complete: ${fmtQty(totalUpdated)} parts updated, ${fmtQty(totalAdded)} new parts added` +
          (errors.length ? ` — ⚠ failed: ${errors.join(" | ")}` : "")
      );
    } catch (e: any) {
      setImportMsg("⚠ " + (e.message ?? String(e)));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const cols: Column<MaintPart>[] = [
    {
      key: "no",
      header: "No",
      value: (r) => r.no,
      render: (r) => <span className="text-slate-400 text-xs tabular-nums">{r.no}</span>,
    },
    { key: "name", header: "Part Name", value: (r) => r.name, render: (r) => <span className="font-medium">{r.name}</span> },
    { key: "pno", header: "Part No", value: (r) => r.partNo, render: (r) => <span className="font-mono text-xs">{r.partNo}</span> },
    { key: "model", header: "Machine / Model", value: (r) => r.machineModel, render: (r) => <span className="block max-w-36 truncate" title={r.machineModel}>{r.machineModel || "-"}</span> },
    { key: "loc", header: "Location", value: (r) => r.location },
    { key: "sup", header: "Supplier", value: (r) => r.supplier, render: (r) => <span className="block max-w-36 truncate">{r.supplier || "-"}</span> },
    { key: "min", header: "Min", value: (r) => r.minStock, align: "right" },
    { key: "max", header: "Max", value: (r) => r.maxStock, align: "right" },
    {
      key: "stock",
      header: "Stock",
      value: (r) => r.currentStock,
      align: "right",
      render: (r) => {
        const low = r.currentStock < r.minStock;
        return <span className={low ? "text-rose-400 font-bold" : "font-semibold"}>{fmtQty(r.currentStock)}</span>;
      },
      className: (r) => (r.currentStock < r.minStock ? "bg-rose-950/30" : ""),
    },
    {
      key: "status",
      header: "Status",
      value: (r) => (r.currentStock < r.minStock ? "LOW" : r.currentStock > r.maxStock ? "OVER" : "OK"),
      render: (r) =>
        r.currentStock < r.minStock ? (
          <Badge tone="danger">LOW</Badge>
        ) : r.currentStock > r.maxStock && r.maxStock > 0 ? (
          <Badge tone="info">OVER</Badge>
        ) : (
          <Badge tone="ok">OK</Badge>
        ),
    },
    { key: "avg", header: "Avg Use/mo", value: (r) => Math.round(avgMonthlyUse(r) * 10) / 10, align: "right", render: (r) => (avgMonthlyUse(r) > 0 ? fmtQty(Math.round(avgMonthlyUse(r) * 10) / 10) : "-") },
    { key: "order", header: "To Order", value: (r) => r.qtyToOrder, align: "right", render: (r) => (r.qtyToOrder > 0 ? <span className="text-amber-300 font-semibold">{fmtQty(r.qtyToOrder)}</span> : "-") },
    { key: "price", header: "Price", value: (r) => r.price, align: "right", render: (r) => (r.price ? fmtMoney(r.price, "RM") : "-") },
    {
      key: "act",
      header: "",
      render: (r) => (
        <div className="flex gap-1">
          <button
            className="btn-secondary !py-0.5 !px-2 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              setIssueType("ISSUE");
              setIssuePart(r);
            }}
          >
            − Issue
          </button>
          <button
            className="btn-secondary !py-0.5 !px-2 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              setIssueType("RECEIVE");
              setIssuePart(r);
            }}
          >
            + Receive
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Spare Part Status</h1>
          <p className="text-sm text-slate-500">
            Maintenance &amp; IE department stock control (separate from supply chain raw materials)
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) onImport(e.target.files);
            }}
          />
          <button className="btn-secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            ⇪ Import Excel (multi)
          </button>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={async () => {
              if (db.maintParts.length === 0) {
                alert("No maintenance parts to clear.");
                return;
              }
              if (
                !confirm(
                  `CLEAR ALL ${fmtQty(db.maintParts.length)} maintenance parts across every category?\n\n` +
                    `Movement history (maintIssues) is kept.\nUse this for a clean re-import.`
                )
              )
                return;
              setBusy(true);
              try {
                for (const p of db.maintParts) await dbRemove(`maintParts/${p.id}`);
              } finally {
                setBusy(false);
              }
            }}
            title="Delete all maintenance parts for a clean re-import"
          >
            🗑 Clear All Parts
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEdit({
                category: catF,
                no: String(catParts.length + 1),
                name: "",
                partNo: "",
                machineModel: "",
                location: "",
                supplier: "",
                minStock: 0,
                maxStock: 0,
                currentStock: 0,
                qtyToOrder: 0,
                price: 0,
                remarks: "",
                usage: {},
                monthStock: {},
              });
              setIsNew(true);
            }}
          >
            + New Part
          </button>
        </div>
      </div>

      {importMsg && (
        <Card>
          <div className="text-sm">{importMsg}</div>
        </Card>
      )}

      {/* Category tabs */}
      <div className="flex gap-1 flex-wrap">
        {CATEGORIES.map((c) => {
          const count = db.maintParts.filter((p) => p.category === c).length;
          const low = db.maintParts.filter((p) => p.category === c && p.currentStock < p.minStock).length;
          return (
            <button
              key={c}
              className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                catF === c
                  ? "bg-sky-900/40 border-sky-600 text-sky-300"
                  : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setCatF(c)}
            >
              {c} <span className="text-xs opacity-70">({count}{low ? ` · ${low} low` : ""})</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 sm:gap-3">
        <Stat label="Parts" value={fmtQty(catStats.total)} />
        <Stat label="Below Min" value={fmtQty(catStats.below)} tone={catStats.below ? "danger" : "ok"} />
        <Stat label="To Order" value={fmtQty(catStats.toOrder)} tone={catStats.toOrder ? "warn" : "ok"} />
      </div>

      {/* Summary */}
      <Card title={`Summary — ${catF}`}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <div className="bg-slate-800/40 rounded p-3">
            <div className="text-xs text-slate-500 uppercase">6-month consumption</div>
            <div className="text-xl font-bold mt-1">{fmtQty(summary.totalUsage6)}</div>
          </div>
          <div className="bg-slate-800/40 rounded p-3">
            <div className="text-xs text-slate-500 uppercase">Manual issues (30 days)</div>
            <div className="text-xl font-bold mt-1">
              {fmtQty(summary.issues30Qty)} <span className="text-xs text-slate-500">in {summary.issues30} movements</span>
            </div>
          </div>
          <div className="bg-slate-800/40 rounded p-3">
            <div className="text-xs text-slate-500 uppercase">Zero-stock parts</div>
            <div className={`text-xl font-bold mt-1 ${summary.zeroStock ? "text-rose-400" : "text-emerald-400"}`}>
              {fmtQty(summary.zeroStock)}
            </div>
          </div>
          <div className="bg-slate-800/40 rounded p-3">
            <div className="text-xs text-slate-500 uppercase">To-order cost (flagged)</div>
            <div className="text-xl font-bold mt-1 text-amber-300">{fmtMoney(summary.orderCost, "RM")}</div>
          </div>
          <div className="bg-slate-800/40 rounded p-3">
            <div className="text-xs text-slate-500 uppercase">Top-up cost ({summary.belowParts} below min)</div>
            <div className="text-xl font-bold mt-1 text-rose-300">{fmtMoney(summary.belowCost, "RM")}</div>
            <div className="text-xs text-slate-500 mt-0.5">est. to reach min level</div>
          </div>
          <div className="bg-slate-800/40 rounded p-3">
            <div className="text-xs text-slate-500 uppercase">Avg stock health</div>
            <div className="text-xl font-bold mt-1">
              {catStats.total
                ? Math.round(((catStats.total - catStats.below) / catStats.total) * 100)
                : 0}
              <span className="text-sm text-slate-500">%</span>
            </div>
            <div className="text-xs text-slate-500 mt-0.5">parts at/above min</div>
          </div>
        </div>
      </Card>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title={`Monthly consumption — ${catF} (last 6 months)`}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={usageTrend}>
              <XAxis dataKey="month" tick={{ fontSize: 10 }} stroke="#475569" interval={1} />
              <YAxis tick={{ fontSize: 10 }} stroke="#475569" />
              <Tooltip
                contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8 }}
              />
              <Bar dataKey="qty" fill="#f59e0b" name="Qty used" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title={`Stock level by month — ${catF} (from imports)`}>
          {stockTrend.length < 2 ? (
            <div className="text-sm text-slate-500 py-16 text-center">
              Import at least two monthly workbooks to see the stock trend
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={stockTrend}>
                <XAxis dataKey="month" tick={{ fontSize: 10 }} stroke="#475569" />
                <YAxis tick={{ fontSize: 10 }} stroke="#475569" />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8 }}
                />
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  name="Total stock"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title={`Top consumed parts — ${catF} (6 months)`} className="lg:col-span-2">
          {topConsumed.length === 0 ? (
            <div className="text-sm text-slate-500 py-16 text-center">No usage recorded</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={topConsumed} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 10 }} stroke="#475569" />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 10 }}
                  stroke="#475569"
                  width={130}
                />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8 }}
                />
                <Bar dataKey="qty" fill="#0ea5e9" name="Qty used (12 mo)" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <Card>
        <div className="flex gap-2 mb-3 flex-wrap">
          <SearchBox value={q} onChange={setQ} placeholder="Part / machine / location…" />
          <button
            className="btn-secondary ml-auto"
            onClick={() => exportCsv(`maint_${catF.replace(/[^A-Z0-9]+/gi, "_")}.csv`, rows, cols.filter((c) => c.key !== "act"))}
          >
            Export
          </button>
        </div>
        <DataTable columns={cols} rows={rows} onRowClick={(r) => { setEdit(r); setIsNew(false); }} pageSize={60} dense />
      </Card>

      {recentIssues.length > 0 && (
        <Card title={`Recent movements — ${catF}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead>
                <tr className="text-left text-xs uppercase text-slate-500 border-b border-slate-800">
                  <th className="py-2 px-2">Type</th>
                  <th className="py-2 px-2">Part</th>
                  <th className="py-2 px-2 text-right">Qty</th>
                  <th className="py-2 px-2">Notes</th>
                  <th className="py-2 px-2">When</th>
                </tr>
              </thead>
              <tbody>
                {recentIssues.map((i) => (
                  <tr key={i.id} className="border-b border-slate-800/60">
                    <td className="py-2 px-2">
                      <Badge tone={i.type === "ISSUE" ? "warn" : "ok"}>{i.type}</Badge>
                    </td>
                    <td className="py-2 px-2">
                      <span className="font-medium">{i.partName}</span>{" "}
                      <span className="font-mono text-xs text-slate-500">{i.partNo}</span>
                    </td>
                    <td className={`py-2 px-2 text-right font-semibold ${i.type === "ISSUE" ? "text-rose-400" : "text-emerald-400"}`}>
                      {i.type === "ISSUE" ? "−" : "+"}
                      {fmtQty(i.qty)}
                    </td>
                    <td className="py-2 px-2 max-w-48 truncate">{i.notes || "-"}</td>
                    <td className="py-2 px-2 text-slate-400 whitespace-nowrap">
                      {new Date(i.createdAt).toLocaleDateString()}{" "}
                      {new Date(i.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Issue/Receive modal */}
      {issuePart && (
        <Modal title={`${issueType === "ISSUE" ? "Issue" : "Receive"} — ${issuePart.name}`} onClose={() => setIssuePart(null)}>
          <div className="space-y-3">
            <div className="text-sm text-slate-400">
              Current stock: <b className="text-slate-100">{fmtQty(issuePart.currentStock)}</b> · min {fmtQty(issuePart.minStock)} · max {fmtQty(issuePart.maxStock)}
            </div>
            <Field label="Quantity">
              <input type="number" min="1" className="input" value={issueQty} onChange={(e) => setIssueQty(Math.max(1, +e.target.value || 1))} />
            </Field>
            <Field label="Notes (machine, work order, reason…)">
              <input className="input" value={issueNotes} placeholder={issueType === "ISSUE" ? `e.g. AC90 blade change ${todayISO()}` : "e.g. restock PO"} onChange={(e) => setIssueNotes(e.target.value)} />
            </Field>
            <div className="text-xs text-slate-500">
              After saving: stock becomes <b>{fmtQty(issueType === "ISSUE" ? issuePart.currentStock - issueQty : issuePart.currentStock + issueQty)}</b>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setIssuePart(null)}>Cancel</button>
              <button className="btn-primary" disabled={busy} onClick={submitIssue}>
                {busy ? "Saving…" : `Confirm ${issueType === "ISSUE" ? "Issue" : "Receive"}`}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Edit part modal */}
      {edit && (
        <Modal title={isNew ? `New ${edit.category} Part` : `Edit ${edit.name}`} onClose={() => setEdit(null)} wide>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="No">
              <input className="input" value={edit.no ?? ""} onChange={(e) => setEdit({ ...edit, no: e.target.value })} />
            </Field>
            <Field label="Part Name *">
              <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="Part No">
              <input className="input" value={edit.partNo} onChange={(e) => setEdit({ ...edit, partNo: e.target.value })} />
            </Field>
            <Field label="Category">
              <select className="input" value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Machine / Model">
              <input className="input" value={edit.machineModel} onChange={(e) => setEdit({ ...edit, machineModel: e.target.value })} />
            </Field>
            <Field label="Location">
              <input className="input" value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} />
            </Field>
            <Field label="Supplier">
              <input className="input" value={edit.supplier} onChange={(e) => setEdit({ ...edit, supplier: e.target.value })} />
            </Field>
            <Field label="Min Stock">
              <input type="number" className="input" value={edit.minStock} onChange={(e) => setEdit({ ...edit, minStock: +e.target.value })} />
            </Field>
            <Field label="Max Stock">
              <input type="number" className="input" value={edit.maxStock} onChange={(e) => setEdit({ ...edit, maxStock: +e.target.value })} />
            </Field>
            <Field label="Current Stock">
              <input type="number" className="input" value={edit.currentStock} onChange={(e) => setEdit({ ...edit, currentStock: +e.target.value })} />
            </Field>
            <Field label="Qty To Order">
              <input type="number" className="input" value={edit.qtyToOrder} onChange={(e) => setEdit({ ...edit, qtyToOrder: +e.target.value })} />
            </Field>
            <Field label="Price (RM)">
              <input type="number" step="0.01" className="input" value={edit.price} onChange={(e) => setEdit({ ...edit, price: +e.target.value })} />
            </Field>
            <Field label="Remarks">
              <input className="input" value={edit.remarks} onChange={(e) => setEdit({ ...edit, remarks: e.target.value })} />
            </Field>
          </div>
          {edit.usage && Object.keys(edit.usage).length > 0 && (
            <div className="mt-3">
              <div className="text-xs text-slate-400 mb-1">Usage history (from imports)</div>
              <div className="flex gap-1 flex-wrap text-xs">
                {Object.entries(edit.usage)
                  .sort()
                  .reverse()
                  .slice(0, 12)
                  .map(([ym, v]) => (
                    <span key={ym} className="bg-slate-800 rounded px-2 py-1">
                      {monthLabel(ym)}: <b>{fmtQty(v)}</b>
                    </span>
                  ))}
              </div>
            </div>
          )}
          <div className="flex justify-between mt-4">
            {!isNew && (
              <button className="btn-danger" onClick={() => del(edit)}>
                Delete
              </button>
            )}
            <div className="flex gap-2 ml-auto">
              <button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn-primary" disabled={busy} onClick={save}>Save</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
