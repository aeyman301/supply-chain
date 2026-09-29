import { useMemo, useState } from "react";
import { Card, DataTable, Modal, Field, SearchBox, exportCsv, type Column } from "../components/ui";
import { fmtMoney, fmtQty, monthLabel } from "../lib/format";
import { dbPush, dbUpdate, dbRemove } from "../lib/db";
import type { ForecastLine } from "../types";
import type { Settings } from "../types";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import type { DbData } from "../db-context";

const empty: ForecastLine = {
  partNo: "",
  partName: "",
  model: "",
  customer: "",
  sellingPrice: 0,
  type: "FORECAST",
  monthly: {},
};

export default function Forecast({ db, settings }: { db: DbData; settings: Settings }) {
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<ForecastLine | null>(null);
  const [isNew, setIsNew] = useState(false);
  const months = settings.monthlySeries;

  const rows = useMemo(() => {
    const n = q.toLowerCase();
    if (!n) return db.forecasts;
    return db.forecasts.filter(
      (f) =>
        f.partNo.toLowerCase().includes(n) ||
        f.partName.toLowerCase().includes(n) ||
        f.model.toLowerCase().includes(n)
    );
  }, [db.forecasts, q]);

  const chartData = months.map((ym) => ({
    month: monthLabel(ym),
    qty: Math.round(db.forecasts.reduce((s, f) => s + (f.monthly[ym] ?? 0), 0)),
    value: Math.round(db.forecasts.reduce((s, f) => s + (f.monthly[ym] ?? 0) * f.sellingPrice, 0)),
  }));

  const totalValue = chartData.reduce((s, d) => s + d.value, 0);

  const save = async () => {
    if (!edit || !edit.partNo.trim()) {
      alert("Part No is required");
      return;
    }
    const rec = { ...edit, updatedAt: Date.now() };
    if (isNew) await dbPush("forecasts", rec);
    else await dbUpdate(`forecasts/${edit.id}`, rec);
    setEdit(null);
  };

  const cols: Column<ForecastLine>[] = [
    { key: "part", header: "Part No", value: (r) => r.partNo, render: (r) => <span className="font-mono text-xs">{r.partNo}</span> },
    { key: "name", header: "Part Name", value: (r) => r.partName, render: (r) => <span className="block max-w-48 truncate">{r.partName}</span> },
    { key: "model", header: "Model", value: (r) => r.model },
    { key: "cust", header: "Customer", value: (r) => r.customer },
    { key: "price", header: "Price", value: (r) => r.sellingPrice, align: "right", render: (r) => fmtMoney(r.sellingPrice, "RM") },
    ...months.map((ym) => ({
      key: `m_${ym}`,
      header: monthLabel(ym),
      value: (r: ForecastLine) => r.monthly[ym] ?? 0,
      align: "right" as const,
      render: (r: ForecastLine) => {
        const v = r.monthly[ym] ?? 0;
        return v ? fmtQty(Math.round(v)) : <span className="text-slate-600">·</span>;
      },
    })),
    {
      key: "total",
      header: "Total",
      value: (r) => months.reduce((s, ym) => s + (r.monthly[ym] ?? 0), 0),
      align: "right",
      render: (r) => <b>{fmtQty(Math.round(months.reduce((s, ym) => s + (r.monthly[ym] ?? 0), 0)))}</b>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Forecast by Harness</h1>
          <p className="text-sm text-slate-500">
            {db.forecasts.length} lines · total value ≈ {fmtMoney(totalValue, "RM")}
          </p>
        </div>
        <div className="flex gap-2">
          <SearchBox value={q} onChange={setQ} />
          <button className="btn-secondary" onClick={() => exportCsv("forecast.csv", rows, cols)}>
            Export
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEdit({ ...empty, monthly: Object.fromEntries(months.map((m) => [m, 0])) });
              setIsNew(true);
            }}
          >
            + New Line
          </button>
        </div>
      </div>

      <Card title="Total forecast quantity by month">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData}>
            <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#475569" />
            <YAxis tick={{ fontSize: 11 }} stroke="#475569" />
            <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8 }} />
            <Legend />
            <Bar dataKey="qty" fill="#8b5cf6" name="Qty (pcs)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card>
        <DataTable
          columns={cols}
          rows={rows}
          onRowClick={(r) => {
            setEdit(r);
            setIsNew(false);
          }}
          pageSize={60}
          dense
        />
      </Card>

      {edit && (
        <Modal title={isNew ? "New Forecast Line" : `Edit ${edit.partNo}`} onClose={() => setEdit(null)} wide>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
            <Field label="Part No *">
              <input className="input" value={edit.partNo} onChange={(e) => setEdit({ ...edit, partNo: e.target.value })} />
            </Field>
            <Field label="Part Name">
              <input className="input" value={edit.partName} onChange={(e) => setEdit({ ...edit, partName: e.target.value })} />
            </Field>
            <Field label="Model">
              <input className="input" value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })} />
            </Field>
            <Field label="Customer">
              <input className="input" value={edit.customer} onChange={(e) => setEdit({ ...edit, customer: e.target.value })} />
            </Field>
            <Field label="Selling Price">
              <input type="number" step="0.01" className="input" value={edit.sellingPrice} onChange={(e) => setEdit({ ...edit, sellingPrice: +e.target.value })} />
            </Field>
            <Field label="Type">
              <select className="input" value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value as ForecastLine["type"] })}>
                <option value="FIRM">FIRM</option>
                <option value="FORECAST">FORECAST</option>
              </select>
            </Field>
          </div>
          <div className="mt-3">
            <div className="text-xs text-slate-400 mb-1">Monthly quantities</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
              {months.map((ym) => (
                <Field key={ym} label={monthLabel(ym)}>
                  <input
                    type="number"
                    className="input"
                    value={edit.monthly[ym] ?? 0}
                    onChange={(e) =>
                      setEdit({ ...edit, monthly: { ...edit.monthly, [ym]: +e.target.value } })
                    }
                  />
                </Field>
              ))}
            </div>
          </div>
          <div className="flex justify-between mt-4">
            {!isNew && (
              <button className="btn-danger" onClick={async () => {
                if (!confirm(`Delete forecast for ${edit.partNo}?`)) return;
                await dbRemove(`forecasts/${edit.id}`);
                setEdit(null);
              }}>
                Delete
              </button>
            )}
            <div className="flex gap-2 ml-auto">
              <button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn-primary" onClick={save}>Save</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
