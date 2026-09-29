import { useMemo, useState } from "react";
import { Card, DataTable, Modal, Field, SearchBox, type Column } from "../components/ui";
import { fmtQty } from "../lib/format";
import { dbSet, dbRemove } from "../lib/db";
import { sanitizeKey } from "../lib/db";
import type { Supplier } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import type { DbData } from "../db-context";
import { computeMrp } from "../lib/mrp";

interface SupplierRow extends Supplier {
  id: string; // storage key ("" = derived only, not yet saved)
  derived: boolean; // exists because items reference it
  items: number;
  shortage: number;
}

const empty: Supplier = {
  name: "",
  shippingPoint: "",
  country: "",
  currency: "RM",
  paymentTerm: "",
  leadTimeWeeks: 0,
  remarks: "",
};

function keyFor(name: string) {
  return sanitizeKey(name).slice(0, 120) || "unnamed";
}

export default function Suppliers({ db }: { db: DbData }) {
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<(Supplier & { originalName: string }) | null>(null);
  const [isNew, setIsNew] = useState(false);

  const savedBy = useMemo(() => {
    const m = new Map<string, Supplier>();
    for (const s of db.suppliers) m.set(s.name, s);
    return m;
  }, [db.suppliers]);

  const rows = useMemo(() => {
    const map = new Map<string, SupplierRow>();
    for (const s of db.suppliers) {
      map.set(s.name, {
        ...s,
        id: (s as any).id ?? keyFor(s.name),
        derived: false,
        items: 0,
        shortage: 0,
      });
    }

    // item counts + defaults from master items
    const itemStats = new Map<string, { count: number; ltSum: number; point: string; curr: string; pay: string }>();
    for (const it of db.items) {
      if (!it.supplier) continue;
      const st =
        itemStats.get(it.supplier) ??
        { count: 0, ltSum: 0, point: "", curr: "", pay: "" };
      st.count += 1;
      st.ltSum += it.totalLeadTimeWeeks ?? 0;
      if (!st.point && it.shippingPoint) st.point = it.shippingPoint;
      if (!st.curr && it.curr) st.curr = it.curr;
      if (!st.pay && it.paymentTerm) st.pay = it.paymentTerm;
      itemStats.set(it.supplier, st);
    }
    for (const [name, st] of itemStats) {
      const existing = map.get(name);
      if (existing) {
        existing.items = st.count;
        if (!existing.shippingPoint) existing.shippingPoint = st.point;
        if (!existing.currency) existing.currency = st.curr;
        if (!existing.paymentTerm) existing.paymentTerm = st.pay;
      } else {
        map.set(name, {
          id: "",
          name,
          shippingPoint: st.point,
          country: "",
          currency: st.curr,
          paymentTerm: st.pay,
          leadTimeWeeks: st.count ? Math.round(st.ltSum / st.count) : 0,
          remarks: "",
          derived: true,
          items: st.count,
          shortage: 0,
        });
      }
    }

    // shortage exposure from MRP
    const settings = db.settings ?? {
      ...DEFAULT_SETTINGS,
      companyName: "",
      planMonth: "",
      monthlySeries: [],
    };
    const mrp = computeMrp({
      items: db.items,
      rawStock: db.rawStock,
      poLines: db.poLines,
      forecasts: db.forecasts,
      bom: db.bom,
      fgStock: db.fgStock,
      settings,
    });
    for (const r of mrp) {
      if (!r.supplier) continue;
      const rec = map.get(r.supplier);
      if (rec) rec.shortage += r.shortageTotal;
    }

    const n = q.toLowerCase();
    return [...map.values()]
      .filter((s) => !n || s.name.toLowerCase().includes(n))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [db, q]);

  const save = async () => {
    if (!edit || !edit.name.trim()) {
      alert("Supplier name is required");
      return;
    }
    const rec: Supplier = {
      name: edit.name.trim(),
      shippingPoint: edit.shippingPoint,
      country: edit.country,
      currency: edit.currency,
      paymentTerm: edit.paymentTerm,
      leadTimeWeeks: edit.leadTimeWeeks,
      remarks: edit.remarks,
    };
    const newKey = keyFor(rec.name);
    const oldKey = keyFor(edit.originalName);
    if (!isNew && oldKey !== newKey) {
      await dbRemove(`suppliers/${oldKey}`);
    }
    await dbSet(`suppliers/${newKey}`, rec);
    setEdit(null);
  };

  const del = async (row: SupplierRow) => {
    if (row.derived && !savedBy.has(row.name)) {
      alert(
        "This supplier is derived from master items and has no saved record.\n" +
          "Remove/replace the supplier on its items (Master Items) or delete its saved record instead."
      );
      return;
    }
    if (!confirm(`Delete supplier record "${row.name}"?\n(Item references remain untouched.)`)) return;
    await dbRemove(`suppliers/${row.id}`);
  };

  const syncFromItems = async () => {
    if (!confirm("Create/update supplier records for every supplier found in master items?")) return;
    const stats = new Map<string, { point: string; curr: string; pay: string; ltSum: number; count: number }>();
    for (const it of db.items) {
      if (!it.supplier) continue;
      const st = stats.get(it.supplier) ?? { point: "", curr: "", pay: "", ltSum: 0, count: 0 };
      if (!st.point && it.shippingPoint) st.point = it.shippingPoint;
      if (!st.curr && it.curr) st.curr = it.curr;
      if (!st.pay && it.paymentTerm) st.pay = it.paymentTerm;
      st.ltSum += it.totalLeadTimeWeeks ?? 0;
      st.count += 1;
      stats.set(it.supplier, st);
    }
    for (const [name, st] of stats) {
      const existing = savedBy.get(name);
      await dbSet(`suppliers/${keyFor(name)}`, {
        name,
        shippingPoint: existing?.shippingPoint || st.point,
        country: existing?.country ?? "",
        currency: existing?.currency || st.curr || "RM",
        paymentTerm: existing?.paymentTerm || st.pay,
        leadTimeWeeks: existing?.leadTimeWeeks || Math.round(st.ltSum / st.count),
        remarks: existing?.remarks ?? "",
      });
    }
    alert(`Synced ${stats.size} suppliers from master items.`);
  };

  const cols: Column<SupplierRow>[] = [
    {
      key: "name",
      header: "Supplier",
      value: (r) => r.name,
      render: (r) => (
        <span className="font-medium">
          {r.name} {!r.derived && <span className="text-sky-400 text-xs" title="saved record">●</span>}
        </span>
      ),
    },
    { key: "ship", header: "Shipping Point", value: (r) => r.shippingPoint, render: (r) => <span className="block max-w-52 truncate">{r.shippingPoint || "-"}</span> },
    { key: "country", header: "Country", value: (r) => r.country || "-" },
    { key: "cur", header: "Currency", value: (r) => r.currency || "-" },
    { key: "pay", header: "Payment Term", value: (r) => r.paymentTerm || "-" },
    { key: "lt", header: "LT (wk)", value: (r) => r.leadTimeWeeks, align: "right" },
    { key: "items", header: "Items", value: (r) => r.items, align: "right", render: (r) => fmtQty(r.items) },
    {
      key: "short",
      header: "Open Shortage",
      value: (r) => r.shortage,
      align: "right",
      render: (r) => (r.shortage > 0 ? <span className="text-rose-400 font-semibold">{fmtQty(r.shortage)}</span> : "-"),
    },
    { key: "rem", header: "Remarks", value: (r) => r.remarks, render: (r) => <span className="block max-w-32 truncate">{r.remarks || "-"}</span> },
  ];

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Suppliers</h1>
          <p className="text-sm text-slate-500">
            {rows.length} suppliers · <span className="text-sky-400">●</span> = saved record, click any
            row to edit
          </p>
        </div>
        <div className="flex gap-2">
          <SearchBox value={q} onChange={setQ} />
          <button className="btn-secondary" onClick={syncFromItems}>
            Sync from items
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEdit({ ...empty, originalName: "" });
              setIsNew(true);
            }}
          >
            + New Supplier
          </button>
        </div>
      </div>
      <Card>
        <DataTable
          columns={cols}
          rows={rows}
          onRowClick={(r) => {
            setEdit({ ...r, originalName: r.name });
            setIsNew(false);
          }}
          pageSize={60}
          dense
        />
      </Card>

      {edit && (
        <Modal
          title={isNew ? "New Supplier" : `Edit ${edit.originalName || edit.name}`}
          onClose={() => setEdit(null)}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name *">
              <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="Shipping Point">
              <input className="input" value={edit.shippingPoint} onChange={(e) => setEdit({ ...edit, shippingPoint: e.target.value })} />
            </Field>
            <Field label="Country">
              <input className="input" value={edit.country} onChange={(e) => setEdit({ ...edit, country: e.target.value })} />
            </Field>
            <Field label="Currency">
              <input className="input" value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value })} />
            </Field>
            <Field label="Payment Term">
              <input className="input" value={edit.paymentTerm} onChange={(e) => setEdit({ ...edit, paymentTerm: e.target.value })} />
            </Field>
            <Field label="Lead Time (weeks)">
              <input type="number" className="input" value={edit.leadTimeWeeks} onChange={(e) => setEdit({ ...edit, leadTimeWeeks: +e.target.value })} />
            </Field>
            <Field label="Remarks">
              <input className="input" value={edit.remarks} onChange={(e) => setEdit({ ...edit, remarks: e.target.value })} />
            </Field>
          </div>
          <div className="flex justify-between mt-4">
            {!isNew && (
              <button
                className="btn-danger"
                onClick={async () => {
                  const row = rows.find((r) => r.name === (edit.originalName || edit.name));
                  if (row) {
                    await del(row);
                    setEdit(null);
                  }
                }}
              >
                Delete
              </button>
            )}
            <div className="flex gap-2 ml-auto">
              <button className="btn-secondary" onClick={() => setEdit(null)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={save}>
                Save
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
