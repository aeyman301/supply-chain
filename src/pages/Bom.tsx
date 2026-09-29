import { useMemo, useState } from "react";
import { Card, DataTable, Modal, Field, SearchBox, exportCsv, type Column } from "../components/ui";
import { fmtNum } from "../lib/format";
import { dbPush, dbUpdate, dbRemove } from "../lib/db";
import type { BomLine } from "../types";
import type { DbData } from "../db-context";

const empty: BomLine = {
  componentPartNo: "",
  supplierPartNo: "",
  description: "",
  supplier: "",
  uom: "PC",
  harnessPartNo: "",
  qtyPerHarness: 1,
};

export default function Bom({ db }: { db: DbData }) {
  const [q, setQ] = useState("");
  const [harnessF, setHarnessF] = useState("");
  const [edit, setEdit] = useState<BomLine | null>(null);
  const [isNew, setIsNew] = useState(false);

  const harnesses = useMemo(
    () => [...new Set(db.bom.map((b) => b.harnessPartNo))].sort(),
    [db.bom]
  );

  const rows = useMemo(() => {
    const n = q.toLowerCase();
    return db.bom.filter((b) => {
      if (harnessF && b.harnessPartNo !== harnessF) return false;
      if (!n) return true;
      return (
        b.componentPartNo.toLowerCase().includes(n) ||
        b.description.toLowerCase().includes(n) ||
        b.harnessPartNo.toLowerCase().includes(n)
      );
    });
  }, [db.bom, q, harnessF]);

  const save = async () => {
    if (!edit || !edit.componentPartNo.trim() || !edit.harnessPartNo.trim()) {
      alert("Component Part No and Harness Part No are required");
      return;
    }
    const rec = { ...edit, qtyPerHarness: Number(edit.qtyPerHarness) || 0 };
    if (isNew) await dbPush("bom", rec);
    else await dbUpdate(`bom/${edit.id}`, rec);
    setEdit(null);
  };

  const fillFromItem = (partNo: string) => {
    const item = db.items.find((i) => i.pnaPartNo === partNo);
    if (!item) {
      setEdit({ ...edit!, componentPartNo: partNo });
      return;
    }
    setEdit({
      ...edit!,
      componentPartNo: partNo,
      supplierPartNo: item.supplierPartNo,
      description: item.description,
      supplier: item.supplier,
      uom: item.uom,
    });
  };

  const suggestHarness = () => {
    // default suggestion: first forecast part not yet used, if harness field empty
    if (edit?.harnessPartNo) return edit.harnessPartNo;
    return "";
  };

  const cols: Column<BomLine>[] = [
    { key: "comp", header: "Component", value: (r) => r.componentPartNo, render: (r) => <span className="font-mono text-xs">{r.componentPartNo}</span> },
    { key: "desc", header: "Description", value: (r) => r.description, render: (r) => <span className="block max-w-60 truncate" title={r.description}>{r.description}</span> },
    { key: "sup", header: "Supplier", value: (r) => r.supplier, render: (r) => <span className="block max-w-40 truncate">{r.supplier}</span> },
    { key: "uom", header: "UoM", value: (r) => r.uom },
    { key: "harness", header: "Harness", value: (r) => r.harnessPartNo, render: (r) => <span className="font-mono text-xs">{r.harnessPartNo}</span> },
    { key: "qty", header: "Qty / Harness", value: (r) => r.qtyPerHarness, align: "right", render: (r) => fmtNum(r.qtyPerHarness, 2) },
  ];

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Bill of Materials</h1>
          <p className="text-sm text-slate-500">
            {db.bom.length} usage lines · {harnesses.length} harnesses · component explosion drives MRP
            demand
          </p>
        </div>
        <div className="flex gap-2">
          <select className="input !w-44" value={harnessF} onChange={(e) => setHarnessF(e.target.value)}>
            <option value="">All harnesses</option>
            {harnesses.map((h) => (
              <option key={h}>{h}</option>
            ))}
          </select>
          <SearchBox value={q} onChange={setQ} />
          <button className="btn-secondary" onClick={() => exportCsv("bom.csv", rows, cols)}>
            Export
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEdit({ ...empty });
              setIsNew(true);
            }}
          >
            + New BOM Line
          </button>
        </div>
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
        <Modal title={isNew ? "New BOM Line" : `Edit ${edit.componentPartNo} → ${edit.harnessPartNo}`} onClose={() => setEdit(null)}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Component Part No *">
              <input
                className="input"
                value={edit.componentPartNo}
                list="bom-parts"
                onChange={(e) => fillFromItem(e.target.value)}
              />
              <datalist id="bom-parts">
                {db.items.slice(0, 800).map((i) => (
                  <option key={i.id ?? i.pnaPartNo} value={i.pnaPartNo}>
                    {i.description}
                  </option>
                ))}
              </datalist>
            </Field>
            <Field label="Harness Part No *">
              <input
                className="input"
                value={edit.harnessPartNo}
                list="bom-harnesses"
                onChange={(e) => setEdit({ ...edit, harnessPartNo: e.target.value })}
              />
              <datalist id="bom-harnesses">
                {harnesses.map((h) => (
                  <option key={h} value={h} />
                ))}
                {db.forecasts.map((f) => (
                  <option key={f.id ?? f.partNo} value={f.partNo}>
                    {f.partName}
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
            <Field label="UoM">
              <input className="input" value={edit.uom} onChange={(e) => setEdit({ ...edit, uom: e.target.value })} />
            </Field>
            <Field label="Qty per Harness *">
              <input
                type="number"
                step="0.0001"
                min="0"
                className="input"
                value={edit.qtyPerHarness}
                onChange={(e) => setEdit({ ...edit, qtyPerHarness: +e.target.value })}
              />
            </Field>
            <Field label=" ">
              <div className="text-xs text-slate-500 pt-2">
                {suggestHarness() && !isNew ? "" : "Tip: pick component + harness from the lists to autofill details."}
              </div>
            </Field>
          </div>
          <div className="flex justify-between mt-4">
            {!isNew && (
              <button
                className="btn-danger"
                onClick={async () => {
                  if (!confirm(`Delete BOM line ${edit.componentPartNo} → ${edit.harnessPartNo}?`)) return;
                  await dbRemove(`bom/${edit.id}`);
                  setEdit(null);
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
