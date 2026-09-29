import { useMemo } from "react";
import { Card, Stat, Badge } from "../components/ui";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Legend, Cell } from "recharts";
import { fmtQty, fmtMoney, monthLabel } from "../lib/format";
import type { MrpRow } from "../lib/mrp";
import type { Settings } from "../types";
import type { DbData } from "../db-context";

export default function Dashboard({
  db,
  settings,
  mrpRows,
  onNavigate,
}: {
  db: DbData;
  settings: Settings;
  mrpRows: MrpRow[];
  onNavigate: (k: any) => void;
}) {
  const months = settings.monthlySeries;
  const shortages = mrpRows.filter((r) => r.shortageTotal > 0);
  const totalShortageQty = shortages.reduce((s, r) => s + r.shortageTotal, 0);
  const totalShortageValue = shortages.reduce((s, r) => s + r.shortageTotal * r.price, 0);
  const onShipQty = mrpRows.reduce((s, r) => s + r.incoming, 0);
  const stockValue = db.rawStock.reduce((s, x) => {
    const item = db.items.find((i) => i.pnaPartNo === x.partNo);
    return s + x.closing * (item?.price ?? 0);
  }, 0);

  const shortageByCategory = new Map<string, number>();
  for (const s of shortages) {
    const k = s.category || "OTHERS";
    shortageByCategory.set(k, (shortageByCategory.get(k) ?? 0) + s.shortageTotal);
  }
  const catData = [...shortageByCategory.entries()]
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 6);

  const demandData = months.map((ym) => {
    const fgDemand = mrpRows.reduce((s, r) => s + (r.demandByMonth[ym] ?? 0), 0);
    const supply = mrpRows.reduce((s, r) => s + (r.supplyByMonth[ym] ?? 0), 0);
    return { month: monthLabel(ym), demand: Math.round(fgDemand), arriving: Math.round(supply) };
  });

  const topShort = shortages.slice(0, 10);

  // Merged recent activity feed: received POs + inventory changes (stock take postings, manual edits)
  const recentActivity = useMemo(() => {
    type Activity = {
      id: string;
      kind: "PO RECEIVED" | "STOCK TAKE" | "STOCK EDIT";
      partNo: string;
      description: string;
      supplier: string;
      qty: number;
      closing?: number;
      ref: string;
      at: number;
    };
    const acts: Activity[] = [];

    for (const p of db.poLines) {
      if (p.status !== "RECEIVED") continue;
      acts.push({
        id: `po_${p.id}`,
        kind: "PO RECEIVED",
        partNo: p.partNo,
        description: p.description,
        supplier: p.supplier,
        qty: p.qty,
        ref: p.poNo,
        at: p.updatedAt ?? p.createdAt ?? 0,
      });
    }

    for (const s of db.rawStock) {
      const hasReceive = (s.receiving ?? 0) > 0;
      const hasIssue = (s.issuance ?? 0) > 0;
      if (!s.updatedAt || (!hasReceive && !hasIssue)) continue;
      // ignore the original import snapshot (import set updatedAt ≈ import time for every line);
      // only surface lines touched in the last 30 days
      if (Date.now() - s.updatedAt > 30 * 24 * 3600 * 1000) continue;
      acts.push({
        id: `stk_${s.id}`,
        kind: hasReceive ? "STOCK TAKE" : "STOCK EDIT",
        partNo: s.partNo,
        description: s.description,
        supplier: s.supplier,
        qty: hasReceive ? s.receiving : -s.issuance,
        closing: s.closing,
        ref: s.month ? monthLabel(s.month) : "",
        at: s.updatedAt,
      });
    }

    return acts.sort((a, b) => b.at - a.at).slice(0, 12);
  }, [db.poLines, db.rawStock]);

  const COLORS = ["#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#ef4444", "#64748b"];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Dashboard</h1>
        <p className="text-sm text-slate-500 break-words">
          {settings.companyName} · plan month {monthLabel(settings.planMonth)}
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3">
        <Stat label="Active Parts" value={fmtQty(db.items.length)} sub="master list" />
        <Stat label="Shortage Parts" value={fmtQty(shortages.length)} tone="danger" sub="in planning horizon" />
        <Stat label="Shortage Qty" value={fmtQty(totalShortageQty)} tone="danger" sub="all components" />
        <Stat label="Shortage Value" value={fmtMoney(totalShortageValue, "RM")} tone="warn" sub="est. purchase" />
        <Stat label="Raw Stock Value" value={fmtMoney(stockValue, "RM")} tone="ok" sub="warehouse closing" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Demand vs Arriving Supply (all components)" className="lg:col-span-2">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={demandData}>
              <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#475569" />
              <YAxis tick={{ fontSize: 11 }} stroke="#475569" />
              <Tooltip
                contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8 }}
              />
              <Legend />
              <Bar dataKey="demand" fill="#0ea5e9" name="Demand" radius={[3, 3, 0, 0]} />
              <Bar dataKey="arriving" fill="#10b981" name="PO arriving" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Shortage by Category (top 6)">
          {catData.length === 0 ? (
            <div className="text-sm text-slate-500 py-10 text-center">No shortages 🎉</div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={catData}
                  dataKey="qty"
                  nameKey="name"
                  innerRadius={50}
                  outerRadius={85}
                  paddingAngle={2}
                >
                  {catData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8 }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <Card
        title="Top Shortages"
        right={
          <button className="btn-secondary !py-1" onClick={() => onNavigate("mrp")}>
            Open MRP Plan →
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-slate-500 border-b border-slate-800">
                <th className="py-2 px-2">Part No</th>
                <th className="py-2 px-2">Description</th>
                <th className="py-2 px-2">Supplier</th>
                <th className="py-2 px-2 text-right">Stock</th>
                <th className="py-2 px-2 text-right">On Ship</th>
                <th className="py-2 px-2 text-right">Demand</th>
                <th className="py-2 px-2 text-right">Shortage</th>
                <th className="py-2 px-2">First Short</th>
                <th className="py-2 px-2 text-right">Order</th>
              </tr>
            </thead>
            <tbody>
              {topShort.map((r) => (
                <tr key={r.partNo} className="border-b border-slate-800/60">
                  <td className="py-2 px-2 font-mono text-xs">{r.partNo}</td>
                  <td className="py-2 px-2 max-w-56 truncate">{r.description}</td>
                  <td className="py-2 px-2 max-w-44 truncate">{r.supplier}</td>
                  <td className="py-2 px-2 text-right">{fmtQty(r.stock)}</td>
                  <td className="py-2 px-2 text-right text-sky-300">{fmtQty(r.incoming)}</td>
                  <td className="py-2 px-2 text-right">{fmtQty(r.totalDemand)}</td>
                  <td className="py-2 px-2 text-right text-rose-400 font-semibold">
                    {fmtQty(r.shortageTotal)}
                  </td>
                  <td className="py-2 px-2">
                    {r.shortageMonth ? monthLabel(r.shortageMonth) : "-"}
                  </td>
                  <td className="py-2 px-2 text-right text-amber-300">
                    {r.planToOrder > 0 ? fmtQty(r.planToOrder) : "-"}
                  </td>
                </tr>
              ))}
              {topShort.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-slate-500">
                    No shortage in horizon
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        <Stat label="Open PO Lines" value={fmtQty(db.poLines.filter((p) => p.status !== "RECEIVED" && p.status !== "CANCELLED").length)} sub={`${fmtQty(onShipQty)} pcs on ship`} />
        <Stat label="FG SKUs" value={fmtQty(db.fgStock.length)} sub="finished goods" />
        <Stat label="Forecast Lines" value={fmtQty(db.forecasts.length)} sub="harness models" />
        <Stat label="BOM Lines" value={fmtQty(db.bom.length)} sub="component usage" />
      </div>

      <Card
        title="Recently Received Items"
        right={
          <button className="btn-secondary !py-1" onClick={() => onNavigate("po")}>
            All Purchase Orders →
          </button>
        }
      >
        {recentActivity.length === 0 ? (
          <div className="text-sm text-slate-500 py-6 text-center">
            No recent activity — mark POs as RECEIVED or post stock takes to see changes here
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-left text-xs uppercase text-slate-500 border-b border-slate-800">
                  <th className="py-2 px-2">Type</th>
                  <th className="py-2 px-2">Part No</th>
                  <th className="py-2 px-2">Description</th>
                  <th className="py-2 px-2">Supplier</th>
                  <th className="py-2 px-2 text-right">Change</th>
                  <th className="py-2 px-2 text-right">Closing</th>
                  <th className="py-2 px-2">Ref</th>
                  <th className="py-2 px-2">When</th>
                </tr>
              </thead>
              <tbody>
                {recentActivity.map((a) => (
                  <tr key={a.id} className="border-b border-slate-800/60">
                    <td className="py-2 px-2">
                      <Badge tone={a.qty >= 0 ? "ok" : "warn"}>{a.kind}</Badge>
                    </td>
                    <td className="py-2 px-2 font-mono text-xs">{a.partNo}</td>
                    <td className="py-2 px-2 max-w-52 truncate">{a.description}</td>
                    <td className="py-2 px-2 max-w-40 truncate">{a.supplier}</td>
                    <td className={`py-2 px-2 text-right font-semibold ${a.qty >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {a.qty >= 0 ? "+" : ""}
                      {fmtQty(a.qty)}
                    </td>
                    <td className="py-2 px-2 text-right text-slate-400">
                      {a.closing !== undefined ? fmtQty(a.closing) : "—"}
                    </td>
                    <td className="py-2 px-2 font-mono text-xs text-slate-400">{a.ref}</td>
                    <td className="py-2 px-2 text-slate-400 whitespace-nowrap">
                      {new Date(a.at).toLocaleDateString()}{" "}
                      <span className="text-slate-500">
                        {new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
