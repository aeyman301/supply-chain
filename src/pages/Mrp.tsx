import { useMemo, useState } from "react";
import { Card, DataTable, Modal, Field, Badge, SearchBox, exportCsv, type Column } from "../components/ui";
import { monthLabel, fmtQty, fmtNum } from "../lib/format";
import type { MrpRow } from "../lib/mrp";
import type { Settings, PurchaseOrderLine } from "../types";
import { dbPush } from "../lib/db";
import { todayISO } from "../lib/format";

export default function MrpPage({
  settings,
  mrpRows,
}: {
  settings: Settings;
  mrpRows: MrpRow[];
}) {
  const [q, setQ] = useState("");
  const [catF, setCatF] = useState("");
  const [onlyShort, setOnlyShort] = useState(true);
  const [sel, setSel] = useState<MrpRow | null>(null);
  const months = settings.monthlySeries;

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of mrpRows) set.add(r.category || "OTHERS");
    return [...set].sort();
  }, [mrpRows]);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    return mrpRows.filter((r) => {
      if (onlyShort && r.shortageTotal <= 0) return false;
      if (catF && (r.category || "OTHERS") !== catF) return false;
      if (!needle) return true;
      return (
        r.partNo.toLowerCase().includes(needle) ||
        r.description.toLowerCase().includes(needle) ||
        r.supplier.toLowerCase().includes(needle)
      );
    });
  }, [mrpRows, q, onlyShort, catF]);

  const suggestPo = async (row: MrpRow) => {
    const line: Omit<PurchaseOrderLine, "id"> = {
      poNo: `DRAFT-${Date.now().toString(36).toUpperCase()}`,
      partNo: row.partNo,
      supplierPartNo: row.supplierPartNo,
      description: row.description,
      supplier: row.supplier,
      model: row.model,
      uom: row.uom,
      qty: row.planToOrder,
      pnaRequestEtd: todayISO(),
      etaPna: "",
      invoiceNo: "",
      blAwb: "",
      grnNo: "",
      shippingPoint: "",
      status: "DRAFT",
      remarks: `MRP suggestion for ${monthLabel(settings.planMonth)}; shortage ${fmtQty(row.shortageTotal)}`,
      createdAt: Date.now(),
    };
    await dbPush("poLines", line);
    alert(`Draft PO created for ${row.partNo} qty ${fmtQty(row.planToOrder)}`);
  };

  const cols: Column<MrpRow>[] = [
    {
      key: "part",
      header: "Part No",
      value: (r) => r.partNo,
      render: (r) => <span className="font-mono text-xs">{r.partNo}</span>,
    },
    {
      key: "cat",
      header: "Category",
      value: (r) => r.category,
      render: (r) => <span className="text-xs text-sky-300">{r.category || "OTHERS"}</span>,
    },
    { key: "desc", header: "Description", value: (r) => r.description, render: (r) => <span className="block max-w-56 truncate" title={r.description}>{r.description}</span> },
    { key: "sup", header: "Supplier", value: (r) => r.supplier, render: (r) => <span className="block max-w-40 truncate" title={r.supplier}>{r.supplier}</span> },
    { key: "stock", header: "Stock", value: (r) => r.stock, align: "right", render: (r) => fmtQty(r.stock) },
    { key: "inc", header: "On Ship", value: (r) => r.incoming, align: "right", render: (r) => <span className="text-sky-300">{fmtQty(r.incoming)}</span> },
    { key: "dem", header: "Demand", value: (r) => r.totalDemand, align: "right", render: (r) => fmtQty(r.totalDemand) },
    {
      key: "short",
      header: "Shortage",
      value: (r) => r.shortageTotal,
      align: "right",
      render: (r) =>
        r.shortageTotal > 0 ? (
          <span className="text-rose-400 font-semibold">{fmtQty(r.shortageTotal)}</span>
        ) : (
          <Badge tone="ok">OK</Badge>
        ),
      className: (r) => (r.shortageTotal > 0 ? "bg-rose-950/30" : ""),
    },
    {
      key: "sm",
      header: "First Short",
      value: (r) => r.shortageMonth ?? "",
      render: (r) => (r.shortageMonth ? <Badge tone="warn">{monthLabel(r.shortageMonth)}</Badge> : "-"),
    },
    { key: "days", header: "Days", value: (r) => r.stockDays ?? "", align: "right", render: (r) => (r.stockDays === null ? "-" : fmtQty(r.stockDays)) },
    { key: "lt", header: "LT wk", value: (r) => r.leadTimeWeeks, align: "right" },
    { key: "moq", header: "MOQ", value: (r) => r.moq, align: "right", render: (r) => fmtQty(r.moq) },
    {
      key: "plan",
      header: "Plan to Order",
      value: (r) => r.planToOrder,
      align: "right",
      render: (r) => (r.planToOrder > 0 ? <span className="text-amber-300 font-semibold">{fmtQty(r.planToOrder)}</span> : "-"),
      className: (r) => (r.planToOrder > 0 ? "bg-amber-950/20" : ""),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">MRP Plan</h1>
          <p className="text-sm text-slate-500">
            Material Requirements Planning · horizon {months.map(monthLabel).join(" → ")}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={onlyShort}
              onChange={(e) => setOnlyShort(e.target.checked)}
              className="accent-sky-500"
            />
            Shortages only
          </label>
          <select className="input !w-40" value={catF} onChange={(e) => setCatF(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <SearchBox value={q} onChange={setQ} placeholder="Part / supplier…" />
          <button
            className="btn-secondary"
            onClick={() =>
              exportCsv(`MRP_${settings.planMonth}.csv`, filtered, [
                ...cols,
                ...months.map((ym) => ({
                  key: `d_${ym}`,
                  header: `Demand ${ym}`,
                  value: (r: MrpRow) => r.demandByMonth[ym] ?? 0,
                })),
                ...months.map((ym) => ({
                  key: `p_${ym}`,
                  header: `Proj ${ym}`,
                  value: (r: MrpRow) => Math.round(r.projectedByMonth[ym] ?? 0),
                })),
              ])
            }
          >
            Export CSV
          </button>
        </div>
      </div>

      <Card>
        <DataTable columns={cols} rows={filtered} onRowClick={setSel} pageSize={60} dense />
      </Card>

      {sel && (
        <Modal title={`${sel.partNo} — ${sel.description}`} onClose={() => setSel(null)} wide>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 text-sm">
            <Field label="Supplier">
              <div>{sel.supplier || "-"}</div>
            </Field>
            <Field label="UoM">
              <div>{sel.uom || "-"}</div>
            </Field>
            <Field label="Stock">
              <div>{fmtQty(sel.stock)}</div>
            </Field>
            <Field label="On Ship / Incoming">
              <div className="text-sky-300">{fmtQty(sel.incoming)}</div>
            </Field>
            <Field label="Daily usage (est)">
              <div>{fmtNum(sel.dailyUsage)}</div>
            </Field>
            <Field label="Buffer (weeks)">
              <div>{fmtQty(sel.bufferQty)}</div>
            </Field>
            <Field label="Lead time">
              <div>{sel.leadTimeWeeks} weeks</div>
            </Field>
            <Field label="Price">
              <div>
                {sel.curr} {fmtNum(sel.price, 3)}
              </div>
            </Field>
          </div>

          <div className="overflow-x-auto mb-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-slate-800">
                  <th className="text-left py-1.5 px-2">Month</th>
                  {months.map((ym) => (
                    <th key={ym} className="text-right py-1.5 px-2">
                      {monthLabel(ym)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono">
                <tr className="border-b border-slate-800/50">
                  <td className="py-1.5 px-2 text-slate-400">Demand</td>
                  {months.map((ym) => (
                    <td key={ym} className="text-right py-1.5 px-2">
                      {fmtQty(sel.demandByMonth[ym] ?? 0)}
                    </td>
                  ))}
                </tr>
                <tr className="border-b border-slate-800/50">
                  <td className="py-1.5 px-2 text-slate-400">PO arriving</td>
                  {months.map((ym) => (
                    <td key={ym} className="text-right py-1.5 px-2 text-sky-300">
                      {sel.supplyByMonth[ym] ? fmtQty(sel.supplyByMonth[ym]) : "·"}
                    </td>
                  ))}
                </tr>
                <tr className="border-b border-slate-800/50">
                  <td className="py-1.5 px-2 text-slate-400">Projected balance</td>
                  {months.map((ym) => {
                    const v = sel.projectedByMonth[ym] ?? 0;
                    return (
                      <td
                        key={ym}
                        className={`text-right py-1.5 px-2 ${v < 0 ? "text-rose-400 font-bold" : ""}`}
                      >
                        {fmtQty(v)}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>

          {sel.planToOrder > 0 && (
            <div className="flex items-center justify-between bg-amber-950/30 border border-amber-900/50 rounded p-3">
              <div className="text-sm">
                Suggested order: <b className="text-amber-300">{fmtQty(sel.planToOrder)}</b>{" "}
                {sel.uom} (shortage {fmtQty(sel.shortageTotal)} rounded to MOQ {fmtQty(sel.moq)})
              </div>
              <button
                className="btn-primary"
                onClick={async () => {
                  await suggestPo(sel);
                  setSel(null);
                }}
              >
                Create Draft PO
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
