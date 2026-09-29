import { useMemo, useState } from "react";
import { Card, DataTable, Modal, Field, SearchBox, exportCsv, Stat, type Column } from "../components/ui";
import { fmtMoney, fmtQty, monthLabel } from "../lib/format";
import { deriveCategory } from "../lib/category";
import { dbPush, dbUpdate, dbRemove } from "../lib/db";
import type { StockRecord } from "../types";
import type { DbData } from "../db-context";

const empty: StockRecord = {
  partNo: "",
  supplierPartNo: "",
  description: "",
  supplier: "",
  model: "",
  uom: "PC",
  month: "",
  opening: 0,
  receiving: 0,
  issuance: 0,
  closing: 0,
};

export default function Inventory({ db, settings }: { db: DbData; settings: import("../types").Settings }) {
  const [q, setQ] = useState("");
  const [catF, setCatF] = useState("");
  const [edit, setEdit] = useState<StockRecord | null>(null);
  const [isNew, setIsNew] = useState(false);

  const catOf = (partNo: string) => {
    const item = db.items.find((i) => i.pnaPartNo === partNo);
    return item?.category || deriveCategory(db.rawStock.find((s) => s.partNo === partNo)?.description ?? "");
  };

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const s of db.rawStock) {
      const item = db.items.find((i) => i.pnaPartNo === s.partNo);
      set.add(item?.category || deriveCategory(s.description));
    }
    return [...set].sort();
  }, [db.rawStock, db.items]);

  const rows = useMemo(() => {
    const n = q.toLowerCase();
    return db.rawStock.filter((s) => {
      if (catF) {
        const item = db.items.find((i) => i.pnaPartNo === s.partNo);
        const cat = item?.category || deriveCategory(s.description);
        if (cat !== catF) return false;
      }
      if (!n) return true;
      return (
        s.partNo.toLowerCase().includes(n) ||
        s.description.toLowerCase().includes(n) ||
        s.supplier.toLowerCase().includes(n) ||
        s.model.toLowerCase().includes(n)
      );
    });
  }, [db.rawStock, db.items, q, catF]);

  const months = [...new Set(db.rawStock.map((s) => s.month))].sort();
  const totalClosing = db.rawStock.reduce((s, x) => s + x.closing, 0);
  const stockValue = db.rawStock.reduce((s, x) => {
    const item = db.items.find((i) => i.pnaPartNo === x.partNo);
    return s + x.closing * (item?.price ?? 0);
  }, 0);
  const negParts = db.rawStock.filter((x) => x.closing < 0).length;

  const save = async () => {
    if (!edit || !edit.partNo.trim()) {
      alert("Part No is required");
      return;
    }
    const rec = { ...edit, updatedAt: Date.now() };
    if (isNew) await dbPush("rawStock", rec);
    else await dbUpdate(`rawStock/${edit.id}`, rec);
    setEdit(null);
  };

  const cols: Column<StockRecord>[] = [
    { key: "part", header: "Part No", value: (r) => r.partNo, render: (r) => <span className="font-mono text-xs">{r.partNo}</span> },
    {
      key: "cat",
      header: "Category",
      value: (r) => catOf(r.partNo),
      render: (r) => <span className="text-xs text-sky-300">{catOf(r.partNo)}</span>,
    },
    { key: "desc", header: "Description", value: (r) => r.description, render: (r) => <span className="block max-w-60 truncate" title={r.description}>{r.description}</span> },
    { key: "sup", header: "Supplier", value: (r) => r.supplier, render: (r) => <span className="block max-w-40 truncate">{r.supplier}</span> },
    { key: "model", header: "Model", value: (r) => r.model, render: (r) => <span className="block max-w-28 truncate">{r.model}</span> },
    { key: "uom", header: "UoM", value: (r) => r.uom },
    { key: "open", header: "Opening", value: (r) => r.opening, align: "right", render: (r) => fmtQty(r.opening) },
    { key: "rec", header: "Receiving", value: (r) => r.receiving, align: "right", render: (r) => <span className="text-emerald-400">{r.receiving ? fmtQty(r.receiving) : "-"}</span> },
    { key: "iss", header: "Issuance", value: (r) => r.issuance, align: "right", render: (r) => <span className="text-rose-400">{r.issuance ? fmtQty(r.issuance) : "-"}</span> },
    {
      key: "close",
      header: "Closing",
      value: (r) => r.closing,
      align: "right",
      render: (r) => (
        <span className={r.closing < 0 ? "text-rose-400 font-bold" : ""}>{fmtQty(r.closing)}</span>
      ),
    },
    { key: "m", header: "Month", value: (r) => r.month, render: (r) => (r.month ? monthLabel(r.month) : "-") },
  ];

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Raw Inventory — Warehouse</h1>
          <p className="text-sm text-slate-500">
            Stock-take records · months: {months.map(monthLabel).join(", ") || "—"}
          </p>
        </div>
        <div className="flex gap-2">
          <select className="input !w-40" value={catF} onChange={(e) => setCatF(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <SearchBox value={q} onChange={setQ} />
          <button className="btn-secondary" onClick={() => exportCsv("raw_stock.csv", rows, cols)}>
            Export
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEdit({ ...empty, month: settings.planMonth });
              setIsNew(true);
            }}
          >
            + New Record
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        <Stat label="Stock Lines" value={fmtQty(db.rawStock.length)} />
        <Stat label="Total Closing Qty" value={fmtQty(totalClosing)} />
        <Stat label="Stock Value" value={fmtMoney(stockValue, "RM")} tone="ok" />
        <Stat label="Negative Lines" value={fmtQty(negParts)} tone={negParts ? "danger" : "ok"} />
      </div>

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
        <Modal title={isNew ? "New Stock Record" : `Edit ${edit.partNo}`} onClose={() => setEdit(null)} wide>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="Part No *">
              <input className="input" value={edit.partNo} list="inv-parts" onChange={(e) => {
                const v = e.target.value;
                const item = db.items.find((i) => i.pnaPartNo === v);
                setEdit({
                  ...edit,
                  partNo: v,
                  description: item?.description ?? edit.description,
                  supplier: item?.supplier ?? edit.supplier,
                  uom: item?.uom ?? edit.uom,
                  supplierPartNo: item?.supplierPartNo ?? edit.supplierPartNo,
                });
              }} />
              <datalist id="inv-parts">
                {db.items.slice(0, 500).map((i) => (
                  <option key={i.id ?? i.pnaPartNo} value={i.pnaPartNo}>
                    {i.description}
                  </option>
                ))}
              </datalist>
            </Field>
            <Field label="Description">
              <input className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </Field>
            <Field label="Supplier">
              <input className="input" value={edit.supplier} onChange={(e) => setEdit({ ...edit, supplier: e.target.value })} />
            </Field>
            <Field label="Model">
              <input className="input" value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })} />
            </Field>
            <Field label="UoM">
              <input className="input" value={edit.uom} onChange={(e) => setEdit({ ...edit, uom: e.target.value })} />
            </Field>
            <Field label="Month (YYYY-MM)">
              <input className="input" value={edit.month} placeholder="2026-09" onChange={(e) => setEdit({ ...edit, month: e.target.value })} />
            </Field>
            <Field label="Opening">
              <input type="number" className="input" value={edit.opening} onChange={(e) => setEdit({ ...edit, opening: +e.target.value })} />
            </Field>
            <Field label="Receiving">
              <input type="number" className="input" value={edit.receiving} onChange={(e) => setEdit({ ...edit, receiving: +e.target.value })} />
            </Field>
            <Field label="Issuance">
              <input type="number" className="input" value={edit.issuance} onChange={(e) => setEdit({ ...edit, issuance: +e.target.value })} />
            </Field>
            <Field label="Closing">
              <input type="number" className="input" value={edit.closing} onChange={(e) => setEdit({ ...edit, closing: +e.target.value })} />
            </Field>
          </div>
          <div className="flex justify-between mt-4">
            {!isNew && (
              <button className="btn-danger" onClick={async () => {
                if (!confirm(`Delete stock record for ${edit.partNo}?`)) return;
                await dbRemove(`rawStock/${edit.id}`);
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
