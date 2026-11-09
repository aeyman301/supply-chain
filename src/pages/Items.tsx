import { useMemo, useState } from "react";
import { Card, DataTable, Modal, Field, SearchBox, exportCsv, Badge, type Column } from "../components/ui";
import { fmtMoney, fmtQty } from "../lib/format";
import { dbPush, dbUpdate, dbRemove, sanitizeKey } from "../lib/db";
import { deriveCategory, CORE_CATEGORIES } from "../lib/category";
import { buildPartCatalog, isUsablePartNo, spareToMasterItem } from "../lib/parts";
import type { MasterItem, MaintPart } from "../types";
import type { DbData } from "../db-context";

/**
 * A row in the merged catalogue. Spare parts are shown alongside the master
 * items so the plant has one parts list, but they stay read-only here — the
 * Spare Part Status list owns their balances and limits.
 */
type ItemRow = MasterItem & {
  source: "MASTER" | "SPARE";
  sparePart?: MaintPart;
  /** Spare record with no usable part number ("-" or "0"). */
  noPartNo?: boolean;
};

const empty: MasterItem = {
  pnaPartNo: "",
  supplierPartNo: "",
  barcode: "",
  description: "",
  category: "",
  supplier: "",
  shippingPoint: "",
  uom: "PC",
  whereUse: "",
  curr: "RM",
  price: 0,
  moq: 0,
  mpq: 0,
  supplierLeadTimeWeeks: 0,
  shipmentLeadTimeWeeks: 0,
  totalLeadTimeWeeks: 0,
  paymentTerm: "",
  remarks: "",
};

export default function Items({ db }: { db: DbData }) {
  const [q, setQ] = useState("");
  const [catF, setCatF] = useState("");
  const [srcF, setSrcF] = useState("ALL");
  const [edit, setEdit] = useState<MasterItem | null>(null);
  const [isNew, setIsNew] = useState(false);

  const withCategory = (i: MasterItem): MasterItem => ({
    ...i,
    category: i.category || deriveCategory(i.description),
  });

  const catalog = useMemo(
    () => buildPartCatalog(db.items, db.maintParts),
    [db.items, db.maintParts]
  );

  /**
   * Master items plus every spare-part record, as one list.
   *
   * Spare parts are listed per record rather than per part number: 53 part
   * numbers in the spare list cover more than one record (the same part filed
   * under two categories, or a part and its refurbish), so collapsing them here
   * would hide stock. A spare row is tagged as a master item when its part
   * number also exists in Master Items.
   */
  const allRows = useMemo<ItemRow[]>(() => {
    const rows: ItemRow[] = [];

    for (const i of db.items) {
      if (!isUsablePartNo((i.pnaPartNo ?? "").trim())) continue;
      rows.push({
        ...withCategory(i),
        source: "MASTER",
        sparePart: catalog.get((i.pnaPartNo ?? "").trim())?.sparePart,
      });
    }

    for (const p of db.maintParts) {
      const key = (p.partNo ?? "").trim();
      // 7 spare records have no part number at all (partNo is "-" or "0"). They
      // are real parts with a name, supplier and stock, so they stay in the
      // list flagged as unnumbered rather than being dropped.
      const master = isUsablePartNo(key) ? catalog.get(key)?.master : undefined;
      rows.push({
        ...(master
          ? withCategory(master)
          : {
              ...spareToMasterItem(p),
              category: p.category || deriveCategory(p.name ?? ""),
            }),
        // the spare record's own figures win on the row
        pnaPartNo: key,
        description: p.name || master?.description || "",
        supplier: p.supplier || master?.supplier || "",
        price: Number(p.price) || Number(master?.price) || 0,
        whereUse: p.machineModel || master?.whereUse || "",
        source: master ? "MASTER" : "SPARE",
        sparePart: p,
        noPartNo: !isUsablePartNo(key),
      });
    }

    return rows.sort((a, b) => {
      // unnumbered parts sort last so they do not lead the list
      if (!!a.noPartNo !== !!b.noPartNo) return a.noPartNo ? 1 : -1;
      return a.pnaPartNo.localeCompare(b.pnaPartNo);
    });
  }, [db.items, db.maintParts, catalog]);

  const spareCount = allRows.filter((r) => r.source === "SPARE").length;
  const sharedCount = allRows.filter((r) => r.source === "MASTER" && r.sparePart).length;
  // spare records with no usable part number: listed, but not orderable by number
  const noPartNoCount = allRows.filter((r) => r.noPartNo).length;
  // part numbers carrying more than one spare record; their stock is summed
  const dupCount = [...catalog.values()].filter((c) => (c.recordCount ?? 1) > 1).length;

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const i of allRows) set.add(i.category);
    return [...set].sort();
  }, [allRows]);

  const filtered = useMemo(() => {
    const n = q.toLowerCase();
    return allRows
      .filter((i) => {
        if (srcF === "MASTER" && i.source === "SPARE") return false;
        if (srcF === "SPARE" && !i.sparePart) return false;
        if (catF && i.category !== catF) return false;
        if (!n) return true;
        return (
          i.pnaPartNo.toLowerCase().includes(n) ||
          i.description.toLowerCase().includes(n) ||
          i.supplier.toLowerCase().includes(n) ||
          i.supplierPartNo.toLowerCase().includes(n) ||
          (i.barcode ?? "").toLowerCase().includes(n) ||
          (i.sparePart?.machineModel ?? "").toLowerCase().includes(n)
        );
      });
  }, [allRows, q, catF, srcF]);

  const save = async () => {
    if (!edit || !edit.pnaPartNo.trim()) {
      alert("PNA Part No is required");
      return;
    }
    const id = sanitizeKey(edit.pnaPartNo);
    const rec = { ...edit, updatedAt: Date.now() };
    if (isNew) await dbPush("items", { ...rec, createdAt: Date.now() });
    else await dbUpdate(`items/${id}`, rec);
    setEdit(null);
  };

  const del = async (row: MasterItem) => {
    if (!confirm(`Delete item ${row.pnaPartNo}?`)) return;
    await dbRemove(`items/${sanitizeKey(row.pnaPartNo)}`);
  };

  const cols: Column<ItemRow>[] = [
    {
      key: "pna",
      header: "PNA Part No",
      value: (r) => r.pnaPartNo,
      render: (r) =>
        r.noPartNo ? (
          <span className="text-amber-400 italic text-xs" title="This spare record has no part number">
            no part no.
          </span>
        ) : (
          <span className="font-mono text-xs">{r.pnaPartNo}</span>
        ),
    },
    {
      key: "src",
      header: "Source",
      value: (r) => r.source,
      render: (r) =>
        r.source === "SPARE" ? (
          <Badge tone="warn">SPARE</Badge>
        ) : r.sparePart ? (
          <Badge tone="info">MASTER + SPARE</Badge>
        ) : (
          <Badge tone="default">MASTER</Badge>
        ),
    },
    {
      key: "cat",
      header: "Category",
      value: (r) => r.category,
      render: (r) => <Badge tone="info">{r.category || "OTHERS"}</Badge>,
    },
    { key: "spn", header: "Supplier Part No", value: (r) => r.supplierPartNo, render: (r) => <span className="font-mono text-xs">{r.supplierPartNo}</span> },
    { key: "barcode", header: "Barcode", value: (r) => r.barcode ?? "", render: (r) => <span className="font-mono text-xs">{r.barcode || "—"}</span> },
    { key: "desc", header: "Description", value: (r) => r.description, render: (r) => <span className="block max-w-64 truncate" title={r.description}>{r.description}</span> },
    { key: "sup", header: "Supplier", value: (r) => r.supplier, render: (r) => <span className="block max-w-44 truncate" title={r.supplier}>{r.supplier}</span> },
    { key: "uom", header: "UoM", value: (r) => r.uom },
    { key: "price", header: "Price", value: (r) => r.price, align: "right", render: (r) => fmtMoney(r.price, r.curr) },
    {
      key: "stock",
      header: "In Stock",
      value: (r) => r.sparePart?.currentStock ?? "",
      align: "right",
      render: (r) =>
        r.sparePart ? (
          <span
            className={
              (r.sparePart.currentStock ?? 0) <= (r.sparePart.minStock ?? 0)
                ? "text-rose-400"
                : "text-slate-300"
            }
            title={`Min ${r.sparePart.minStock ?? 0} · Max ${r.sparePart.maxStock ?? 0}`}
          >
            {fmtQty(r.sparePart.currentStock ?? 0)}
          </span>
        ) : (
          <span className="text-slate-600">—</span>
        ),
    },
    { key: "minmax", header: "Min / Max", value: (r) => `${r.sparePart?.minStock ?? ""} / ${r.sparePart?.maxStock ?? ""}`, align: "right", render: (r) => r.sparePart ? <span className="text-slate-400">{fmtQty(r.sparePart.minStock ?? 0)} / {fmtQty(r.sparePart.maxStock ?? 0)}</span> : <span className="text-slate-600">—</span> },
    { key: "moq", header: "MOQ", value: (r) => r.moq, align: "right", render: (r) => fmtQty(r.moq) },
    { key: "lt", header: "LT (wk)", value: (r) => r.totalLeadTimeWeeks, align: "right" },
    { key: "use", header: "Where Use", value: (r) => r.whereUse, render: (r) => <span className="block max-w-32 truncate">{r.whereUse}</span> },
    {
      key: "act",
      header: "",
      render: (r) =>
        r.source === "SPARE" ? (
          <button
            className="btn-secondary !py-0.5 !px-2 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              promote(r);
            }}
            title="Create a Master Item from this spare part"
          >
            + Master
          </button>
        ) : null,
    },
  ];

  /** Copy a spare part into Master Items so it becomes a purchasing record. */
  const promote = async (row: ItemRow) => {
    if (!row.sparePart) return;
    const seeded = spareToMasterItem(row.sparePart);
    if (
      !confirm(
        `Add ${row.pnaPartNo} to Master Items?\n\n` +
          `It will be created from the spare part record. Its balance and min/max stay on ` +
          `the Spare Part Status list, which continues to own them.`
      )
    )
      return;
    await dbPush("items", {
      ...seeded,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Master Items</h1>
          <p className="text-sm text-slate-500">
            {db.items.length} master item(s) · {spareCount} spare-only part(s) ·{" "}
            {sharedCount} in both lists
          </p>
        </div>
        <div className="flex gap-2">
          <select className="input !w-40" value={srcF} onChange={(e) => setSrcF(e.target.value)}>
            <option value="ALL">All parts</option>
            <option value="MASTER">Master items</option>
            <option value="SPARE">Spare parts</option>
          </select>
          <select className="input !w-40" value={catF} onChange={(e) => setCatF(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <SearchBox value={q} onChange={setQ} />
          <button
            className="btn-secondary"
            onClick={() => exportCsv("items.csv", filtered, cols)}
          >
            Export
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEdit({ ...empty });
              setIsNew(true);
            }}
          >
            + New Item
          </button>
        </div>
      </div>

      <Card>
        <DataTable
          columns={cols}
          rows={filtered}
          onRowClick={(r) => {
            // a spare-only part has no master record to edit here; it keeps its
            // own page for that, and can be promoted from the row action
            if (r.source === "SPARE") return;
            setEdit(r);
            setIsNew(false);
          }}
          pageSize={60}
          dense
          emptyText="No parts match this filter."
        />

        <p className="text-xs text-slate-500 mt-3 leading-relaxed">
          This list merges <b>Master Items</b> ({db.items.length}) with the{" "}
          <b>Spare Part Status</b> list ({db.maintParts.length}), so {fmtQty(allRows.length)} parts
          appear in one place. Spare parts keep their own balances and min/max — use the
          Spare Part Status page to change them, and “+ Master” to copy a part into the
          purchasing catalogue.
          {sharedCount > 0 && <> {fmtQty(sharedCount)} part(s) appear in both lists.</>}
          {dupCount > 0 && (
            <>
              {" "}
              {fmtQty(dupCount)} part number(s) are carried by more than one spare record; each
              is listed separately here, and their stock is added together when the part is picked
              for a material request.
            </>
          )}
          {noPartNoCount > 0 && (
            <>
              {" "}
              <span className="text-amber-400">
                {fmtQty(noPartNoCount)} spare part(s) have no part number on record; they are
                listed at the end as “no part no.” and cannot be added to a material request until
                a number is filled in on the Spare Part Status page.
              </span>
            </>
          )}
        </p>
      </Card>

      {edit && (
        <Modal
          title={isNew ? "New Item" : `Edit ${edit.pnaPartNo}`}
          onClose={() => setEdit(null)}
          wide
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="PNA Part No *">
              <input
                className="input"
                value={edit.pnaPartNo}
                disabled={!isNew}
                onChange={(e) => setEdit({ ...edit, pnaPartNo: e.target.value })}
              />
            </Field>
            <Field label="Supplier Part No">
              <input className="input" value={edit.supplierPartNo} onChange={(e) => setEdit({ ...edit, supplierPartNo: e.target.value })} />
            </Field>
            <Field label="Barcode / GTIN">
              <input className="input font-mono" value={edit.barcode ?? ""} placeholder="UPC, EAN, Code 128…" onChange={(e) => setEdit({ ...edit, barcode: e.target.value.trim() })} />
            </Field>
            <Field label="Description">
              <input className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </Field>
            <Field label="Category">
              <input
                className="input"
                value={edit.category}
                list="item-cats"
                placeholder={deriveCategory(edit.description)}
                onChange={(e) => setEdit({ ...edit, category: e.target.value })}
              />
              <datalist id="item-cats">
                {[...new Set([...CORE_CATEGORIES, ...categories])].map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field label="Supplier">
              <input className="input" value={edit.supplier} onChange={(e) => setEdit({ ...edit, supplier: e.target.value })} list="supplier-names" />
              <datalist id="supplier-names">
                {[...new Set(db.items.map((i) => i.supplier).filter(Boolean))].map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </Field>
            <Field label="Shipping Point">
              <input className="input" value={edit.shippingPoint} onChange={(e) => setEdit({ ...edit, shippingPoint: e.target.value })} />
            </Field>
            <Field label="UoM">
              <input className="input" value={edit.uom} onChange={(e) => setEdit({ ...edit, uom: e.target.value })} />
            </Field>
            <Field label="Where Use (models)">
              <input className="input" value={edit.whereUse} onChange={(e) => setEdit({ ...edit, whereUse: e.target.value })} />
            </Field>
            <Field label="Currency">
              <input className="input" value={edit.curr} onChange={(e) => setEdit({ ...edit, curr: e.target.value })} />
            </Field>
            <Field label="Price">
              <input type="number" step="0.001" className="input" value={edit.price} onChange={(e) => setEdit({ ...edit, price: +e.target.value })} />
            </Field>
            <Field label="MOQ">
              <input type="number" className="input" value={edit.moq} onChange={(e) => setEdit({ ...edit, moq: +e.target.value })} />
            </Field>
            <Field label="MPQ">
              <input type="number" className="input" value={edit.mpq} onChange={(e) => setEdit({ ...edit, mpq: +e.target.value })} />
            </Field>
            <Field label="Supplier LT (weeks)">
              <input type="number" className="input" value={edit.supplierLeadTimeWeeks} onChange={(e) => setEdit({ ...edit, supplierLeadTimeWeeks: +e.target.value, totalLeadTimeWeeks: +e.target.value + edit.shipmentLeadTimeWeeks })} />
            </Field>
            <Field label="Shipment LT (weeks)">
              <input type="number" className="input" value={edit.shipmentLeadTimeWeeks} onChange={(e) => setEdit({ ...edit, shipmentLeadTimeWeeks: +e.target.value, totalLeadTimeWeeks: edit.supplierLeadTimeWeeks + +e.target.value })} />
            </Field>
            <Field label="Total LT (weeks)">
              <input type="number" className="input" value={edit.totalLeadTimeWeeks} onChange={(e) => setEdit({ ...edit, totalLeadTimeWeeks: +e.target.value })} />
            </Field>
            <Field label="Payment Term">
              <input className="input" value={edit.paymentTerm} onChange={(e) => setEdit({ ...edit, paymentTerm: e.target.value })} />
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
