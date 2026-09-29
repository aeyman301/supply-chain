import { useMemo, useState } from "react";
import { Card, DataTable, Modal, Field, SearchBox, exportCsv, Badge, type Column } from "../components/ui";
import { fmtQty, fmtMoney, monthLabel } from "../lib/format";
import { dbPush, dbUpdate, dbRemove } from "../lib/db";
import { PO_STATUSES, type PurchaseOrderLine } from "../types";
import type { DbData } from "../db-context";

const empty: PurchaseOrderLine = {
  poNo: "",
  partNo: "",
  supplierPartNo: "",
  description: "",
  supplier: "",
  model: "",
  uom: "PC",
  qty: 0,
  pnaRequestEtd: "",
  etaPna: "",
  invoiceNo: "",
  blAwb: "",
  grnNo: "",
  shippingPoint: "",
  status: "DRAFT",
  remarks: "",
};

const statusTone = {
  DRAFT: "default",
  CONFIRMED: "info",
  SHIPPED: "warn",
  RECEIVED: "ok",
  CANCELLED: "danger",
} as const;

export default function PurchaseOrders({ db }: { db: DbData }) {
  const [q, setQ] = useState("");
  const [statusF, setStatusF] = useState("ALL");
  const [edit, setEdit] = useState<PurchaseOrderLine | null>(null);
  const [isNew, setIsNew] = useState(false);

  const filtered = useMemo(() => {
    const n = q.toLowerCase();
    return db.poLines.filter((p) => {
      if (statusF !== "ALL" && p.status !== statusF) return false;
      if (!n) return true;
      return (
        p.partNo.toLowerCase().includes(n) ||
        p.poNo.toLowerCase().includes(n) ||
        p.supplier.toLowerCase().includes(n)
      );
    });
  }, [db.poLines, q, statusF]);

  const openCount = db.poLines.filter(
    (p) => p.status !== "RECEIVED" && p.status !== "CANCELLED"
  );
  const openValue = openCount.reduce((s, p) => {
    const item = db.items.find((i) => i.pnaPartNo === p.partNo);
    return s + p.qty * (item?.price ?? 0);
  }, 0);

  const save = async () => {
    if (!edit || !edit.partNo.trim() || !edit.poNo.trim()) {
      alert("PO No and Part No are required");
      return;
    }
    const rec = { ...edit, updatedAt: Date.now() };
    if (isNew) await dbPush("poLines", { ...rec, createdAt: Date.now() });
    else await dbUpdate(`poLines/${edit.id}`, rec);
    setEdit(null);
  };

  const del = async (row: PurchaseOrderLine) => {
    if (!confirm(`Delete PO line ${row.poNo} / ${row.partNo}?`)) return;
    await dbRemove(`poLines/${row.id}`);
  };

  const advance = async (row: PurchaseOrderLine) => {
    const order: PurchaseOrderLine["status"][] = [
      "DRAFT",
      "CONFIRMED",
      "SHIPPED",
      "RECEIVED",
    ];
    const idx = order.indexOf(row.status);
    if (idx < 0 || idx === order.length - 1) return;
    await dbUpdate(`poLines/${row.id}`, {
      status: order[idx + 1],
      updatedAt: Date.now(),
    });
  };

  const cols: Column<PurchaseOrderLine>[] = [
    { key: "po", header: "PO No", value: (r) => r.poNo, render: (r) => <span className="font-mono text-xs">{r.poNo}</span> },
    { key: "part", header: "Part No", value: (r) => r.partNo, render: (r) => <span className="font-mono text-xs">{r.partNo}</span> },
    { key: "desc", header: "Description", value: (r) => r.description, render: (r) => <span className="block max-w-52 truncate" title={r.description}>{r.description}</span> },
    { key: "sup", header: "Supplier", value: (r) => r.supplier, render: (r) => <span className="block max-w-40 truncate" title={r.supplier}>{r.supplier}</span> },
    { key: "qty", header: "Qty", value: (r) => r.qty, align: "right", render: (r) => fmtQty(r.qty) },
    { key: "uom", header: "UoM", value: (r) => r.uom },
    { key: "etd", header: "Req ETD", value: (r) => r.pnaRequestEtd },
    { key: "eta", header: "ETA PNA", value: (r) => r.etaPna, render: (r) => (r.etaPna ? <span title={monthLabel(r.etaPna.slice(0, 7))}>{r.etaPna}</span> : "-") },
    {
      key: "status",
      header: "Status",
      value: (r) => r.status,
      render: (r) => <Badge tone={statusTone[r.status]}>{r.status}</Badge>,
    },
    {
      key: "act",
      header: "",
      render: (r) => {
        const order: PurchaseOrderLine["status"][] = ["DRAFT", "CONFIRMED", "SHIPPED", "RECEIVED"];
        const idx = order.indexOf(r.status);
        return idx >= 0 && idx < 3 ? (
          <button
            className="btn-secondary !py-0.5 !px-2 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              advance(r);
            }}
          >
            → {order[idx + 1]}
          </button>
        ) : null;
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Purchase Orders</h1>
          <p className="text-sm text-slate-500">
            {openCount.length} open lines · est. value {fmtMoney(openValue, "RM")}
          </p>
        </div>
        <div className="flex gap-2">
          <select className="input !w-36" value={statusF} onChange={(e) => setStatusF(e.target.value)}>
            <option>ALL</option>
            {PO_STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <SearchBox value={q} onChange={setQ} />
          <button className="btn-secondary" onClick={() => exportCsv("po_lines.csv", filtered, cols)}>
            Export
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEdit({ ...empty, poNo: `PO-${new Date().getFullYear()}-` });
              setIsNew(true);
            }}
          >
            + New PO Line
          </button>
        </div>
      </div>

      <Card>
        <DataTable
          columns={cols}
          rows={filtered}
          onRowClick={(r) => {
            setEdit(r);
            setIsNew(false);
          }}
          pageSize={60}
          dense
        />
      </Card>

      {edit && (
        <Modal title={isNew ? "New PO Line" : `Edit ${edit.poNo}`} onClose={() => setEdit(null)} wide>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="PO No *">
              <input className="input" value={edit.poNo} onChange={(e) => setEdit({ ...edit, poNo: e.target.value })} />
            </Field>
            <Field label="Part No *">
              <input className="input" value={edit.partNo} list="item-parts" onChange={(e) => {
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
              }}>
              </input>
              <datalist id="item-parts">
                {db.items.slice(0, 500).map((i) => (
                  <option key={i.id ?? i.pnaPartNo} value={i.pnaPartNo}>
                    {i.description}
                  </option>
                ))}
              </datalist>
            </Field>
            <Field label="Supplier Part No">
              <input className="input" value={edit.supplierPartNo} onChange={(e) => setEdit({ ...edit, supplierPartNo: e.target.value })} />
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
            <Field label="Qty">
              <input type="number" className="input" value={edit.qty} onChange={(e) => setEdit({ ...edit, qty: +e.target.value })} />
            </Field>
            <Field label="UoM">
              <input className="input" value={edit.uom} onChange={(e) => setEdit({ ...edit, uom: e.target.value })} />
            </Field>
            <Field label="Status">
              <select className="input" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value as PurchaseOrderLine["status"] })}>
                {PO_STATUSES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="PNA Request ETD">
              <input type="date" className="input" value={edit.pnaRequestEtd} onChange={(e) => setEdit({ ...edit, pnaRequestEtd: e.target.value })} />
            </Field>
            <Field label="ETA PNA">
              <input type="date" className="input" value={edit.etaPna} onChange={(e) => setEdit({ ...edit, etaPna: e.target.value })} />
            </Field>
            <Field label="Shipping Point">
              <input className="input" value={edit.shippingPoint} onChange={(e) => setEdit({ ...edit, shippingPoint: e.target.value })} />
            </Field>
            <Field label="Invoice / DO No">
              <input className="input" value={edit.invoiceNo} onChange={(e) => setEdit({ ...edit, invoiceNo: e.target.value })} />
            </Field>
            <Field label="BL / AWB">
              <input className="input" value={edit.blAwb} onChange={(e) => setEdit({ ...edit, blAwb: e.target.value })} />
            </Field>
            <Field label="GRN No">
              <input className="input" value={edit.grnNo} onChange={(e) => setEdit({ ...edit, grnNo: e.target.value })} />
            </Field>
            <Field label="Remarks">
              <input className="input" value={edit.remarks} onChange={(e) => setEdit({ ...edit, remarks: e.target.value })} />
            </Field>
          </div>
          <div className="flex justify-between mt-4">
            {!isNew && (
              <button className="btn-danger" onClick={() => del(edit)}>
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
