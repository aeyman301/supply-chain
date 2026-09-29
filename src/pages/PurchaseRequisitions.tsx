import { useMemo, useState } from "react";
import {
  Card,
  DataTable,
  Modal,
  Field,
  Badge,
  SearchBox,
  Stat,
  exportCsv,
  type Column,
} from "../components/ui";
import { dbPush, dbUpdate, dbRemove } from "../lib/db";
import { fmtMoney, todayISO } from "../lib/format";
import { sanitizeKey } from "../lib/db";
import { buildPartCatalog, type PartRef } from "../lib/parts";
import { PartPicker } from "../components/PartPicker";
import {
  exportPrPdf,
  lineTotal,
  prTotals,
  prDate,
  PR_CURRENCIES,
} from "../lib/prPdf";
import {
  PR_STATUSES,
  type PrStatus,
  type PurchaseRequisition,
  type PurchaseRequisitionLine,
} from "../types";
import type { DbData } from "../db-context";

const statusTone = {
  DRAFT: "default",
  PENDING: "warn",
  APPROVED: "info",
  ISSUED: "ok",
  CANCELLED: "danger",
} as const satisfies Record<PrStatus, "default" | "danger" | "warn" | "ok" | "info">;

const emptyLine = (): PurchaseRequisitionLine => ({
  partNo: "",
  partName: "",
  description: "",
  uom: "PC",
  unitPrice: 0,
  qty: 1,
  requiredDate: "",
  purpose: "",
});

const emptyPr = (prNo: string): PurchaseRequisition => ({
  prNo,
  prDate: todayISO(),
  category: "oversea",
  requestedBy: "",
  department: "MAINTENANCE",
  currency: "JPY",
  currencyRate: null,
  budgetAmount: 0,
  recommendedSupplier: "",
  specialRequirement: "",
  status: "DRAFT",
  lines: [emptyLine()],
});

/**
 * PR/2026/08/194 — the year and month are taken from the document date, and
 * the sequence continues from whatever already exists for that month, matching
 * the numbering on the plant's printed form.
 */
function nextPrNo(dateISO: string, existing: string[]): string {
  const d = /^\d{4}-\d{2}/.test(dateISO) ? dateISO : todayISO();
  const prefix = `PR/${d.slice(0, 4)}/${d.slice(5, 7)}/`;
  const used = existing
    .filter((no) => typeof no === "string" && no.startsWith(prefix))
    .map((no) => Number(no.slice(prefix.length)))
    .filter((n) => Number.isFinite(n));
  return prefix + String(used.length ? Math.max(...used) + 1 : 1).padStart(3, "0");
}

export default function PurchaseRequisitions({ db }: { db: DbData }) {
  const [q, setQ] = useState("");
  const [statusF, setStatusF] = useState("ALL");
  const [edit, setEdit] = useState<PurchaseRequisition | null>(null);
  const [isNew, setIsNew] = useState(false);

  const allNos = useMemo(() => db.prs.map((p) => p.prNo), [db.prs]);

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return [...db.prs]
      .filter((p) => (statusF === "ALL" ? true : p.status === statusF))
      .filter((p) => {
        if (!n) return true;
        const hay = [
          p.prNo,
          p.requestedBy,
          p.department,
          p.recommendedSupplier,
          ...(p.lines ?? []).map((l) => `${l.partNo} ${l.partName}`),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(n);
      })
      .sort((a, b) => (b.prDate ?? "").localeCompare(a.prDate ?? "") || b.prNo.localeCompare(a.prNo));
  }, [db.prs, q, statusF]);

  const stats = useMemo(() => {
    const open = db.prs.filter((p) => p.status !== "CANCELLED");
    // Requisitions are raised in mixed currencies, so summing them into one
    // number would be meaningless. Count per currency instead.
    const byCurrency = new Map<string, number>();
    for (const p of open) {
      const c = p.currency || "n/a";
      byCurrency.set(c, (byCurrency.get(c) ?? 0) + prTotals(p).base);
    }
    return { count: db.prs.length, open: open.length, byCurrency };
  }, [db.prs]);

  const settings = db.settings;

  const save = async () => {
    if (!edit) return;
    const prNo = edit.prNo.trim();
    if (!prNo) {
      alert("PR No is required");
      return;
    }
    const rec: PurchaseRequisition = {
      ...edit,
      prNo,
      requestedBy: edit.requestedBy.trim(),
      department: edit.department.trim(),
      // Firebase strips nulls, so an absent rate must stay absent rather than
      // become 0 — the document prints "N/A" for an absent rate.
      currencyRate: Number(edit.currencyRate) > 0 ? Number(edit.currencyRate) : null,
      budgetAmount: Number(edit.budgetAmount) || 0,
      lines: (edit.lines ?? []).filter((l) => (l.partNo ?? "").trim() || (l.partName ?? "").trim()),
    };
    if (isNew) await dbPush("prs", { ...rec, createdAt: Date.now(), updatedAt: Date.now() });
    else await dbUpdate(`prs/${edit.id}`, { ...rec, updatedAt: Date.now() });
    setEdit(null);
  };

  const del = async (row: PurchaseRequisition) => {
    if (!confirm(`Delete requisition ${row.prNo}?`)) return;
    await dbRemove(`prs/${row.id}`);
  };

  const setLine = (i: number, patch: Partial<PurchaseRequisitionLine>) =>
    setEdit((s) =>
      s
        ? { ...s, lines: (s.lines ?? []).map((l, j) => (j === i ? { ...l, ...patch } : l)) }
        : s
    );

  /**
   * One catalogue for the line editor, covering Master Items and the Spare Part
   * Status list. A requisition can legitimately be raised against a spare part.
   */
  const partCatalog = useMemo(
    () => buildPartCatalog(db.items, db.maintParts),
    [db.items, db.maintParts]
  );

  /** The line fields a chosen part fills in. */
  const pickFields = (c: PartRef): Partial<PurchaseRequisitionLine> => ({
    partNo: c.partNo,
    partName: c.description,
    uom: c.uom,
    unitPrice: c.price,
  });

  const pickPart = (i: number, c: PartRef) => {
    setLine(i, pickFields(c));
  };

  /**
   * Typing rather than choosing. An exact part number or part name fills the
   * whole line. Anything else edits only the box being typed in, *unless* the
   * line currently holds a catalogue part — then the derived name and price
   * would describe a different part, so they are cleared rather than left stale.
   * A part number that is not in either list is left completely alone, so a
   * requester entering a new supplier part does not lose what they typed.
   */
  const typePart = (i: number, partNo: string, resolved?: PartRef) => {
    if (resolved) {
      setLine(i, pickFields(resolved));
      return;
    }
    const cur = (edit?.lines ?? [])[i];
    const heldIsCataloguePart = !!cur && !!partCatalog.get(cur.partNo.trim());
    if (heldIsCataloguePart && cur!.partNo.trim() !== partNo.trim()) {
      setLine(i, { partNo, partName: "", unitPrice: 0, uom: "PC" });
    } else {
      setLine(i, { partNo });
    }
  };

  /** The same rule for the Part Name box. */
  const typePartName = (i: number, partName: string, resolved?: PartRef) => {
    if (resolved) {
      setLine(i, pickFields(resolved));
      return;
    }
    const cur = (edit?.lines ?? [])[i];
    const heldIsCataloguePart = !!cur && !!partCatalog.get(cur.partNo.trim());
    if (heldIsCataloguePart) setLine(i, { partName, partNo: "", unitPrice: 0, uom: "PC" });
    else setLine(i, { partName });
  };

  const addLine = () => setEdit((s) => (s ? { ...s, lines: [...(s.lines ?? []), emptyLine()] } : s));

  const removeLine = (i: number) =>
    setEdit((s) =>
      s ? { ...s, lines: (s.lines ?? []).filter((_, j) => j !== i) } : s
    );

  const cols: Column<PurchaseRequisition & { id: string }>[] = [
    {
      key: "pr",
      header: "PR No",
      value: (r) => r.prNo,
      render: (r) => <span className="font-mono text-xs">{r.prNo}</span>,
    },
    { key: "date", header: "Date", value: (r) => r.prDate, render: (r) => prDate(r.prDate) },
    { key: "cat", header: "Category", value: (r) => r.category },
    { key: "req", header: "Requested By", value: (r) => r.requestedBy },
    { key: "dept", header: "Department", value: (r) => r.department },
    {
      key: "lines",
      header: "Items",
      value: (r) => (r.lines ?? []).length,
      align: "right",
    },
    {
      key: "total",
      header: "Amount",
      value: (r) => prTotals(r).base,
      align: "right",
      render: (r) => {
        const t = prTotals(r);
        if (!t.base) return "-";
        return <span className="font-semibold">{fmtMoney(t.base, r.currency)}</span>;
      },
    },
    {
      key: "status",
      header: "Status",
      value: (r) => r.status,
      render: (r) => <Badge tone={statusTone[r.status] ?? "default"}>{r.status}</Badge>,
    },
    {
      key: "act",
      header: "",
      render: (r) => (
        <div className="flex gap-1 justify-end">
          <button
            className="btn-secondary !py-1 !px-2"
            title="Open the print dialog to save this requisition as a PDF"
            onClick={(e) => {
              e.stopPropagation();
              if (settings) exportPrPdf(r, settings);
            }}
          >
            PDF
          </button>
          <button
            className="btn-secondary !py-1 !px-2"
            onClick={(e) => {
              e.stopPropagation();
              setEdit({ ...r, lines: (r.lines ?? []).map((l) => ({ ...l })) });
              setIsNew(false);
            }}
          >
            Edit
          </button>
          <button
            className="btn-secondary !py-1 !px-2"
            onClick={(e) => {
              e.stopPropagation();
              del(r);
            }}
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  const t = edit ? prTotals(edit) : null;

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Purchase Requisition</h1>
          <p className="text-sm text-slate-500">
            {stats.open} open of {stats.count} ·{" "}
            {[...stats.byCurrency.entries()]
              .map(([c, v]) => fmtMoney(v, c))
              .join(" · ") || "no value"}
          </p>
        </div>
        <div className="flex gap-2">
          <select
            className="input !w-32"
            value={statusF}
            onChange={(e) => setStatusF(e.target.value)}
          >
            <option>ALL</option>
            {PR_STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <SearchBox value={q} onChange={setQ} />
          <button className="btn-secondary" onClick={() => exportCsv("purchase_requisitions.csv", rows, cols)}>
            Export CSV
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              const date = todayISO();
              setEdit(emptyPr(nextPrNo(date, allNos)));
              setIsNew(true);
            }}
          >
            + New PR
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.entries(PR_CURRENCIES).map(([code]) => {
          const v = stats.byCurrency.get(code) ?? 0;
          return (
            <Stat
              key={code}
              label={`Open value · ${code}`}
              value={v > 0 ? fmtMoney(v, "") : "-"}
              sub={`${PR_CURRENCIES[code].symbol} - ${PR_CURRENCIES[code].label}`}
            />
          );
        })}
      </div>

      <Card>
        <DataTable
          columns={cols}
          rows={rows}
          onRowClick={(r) => {
            setEdit({ ...r, lines: (r.lines ?? []).map((l) => ({ ...l })) });
            setIsNew(false);
          }}
          pageSize={60}
          dense
          emptyText="No purchase requisitions yet. Use + New PR to raise one."
        />
      </Card>

      {edit && (
        <Modal
          title={isNew ? "New Purchase Requisition" : `Edit ${edit.prNo}`}
          onClose={() => setEdit(null)}
          wide
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field label="PR No *">
              <input
                className="input font-mono"
                value={edit.prNo}
                onChange={(e) => setEdit({ ...edit, prNo: e.target.value })}
              />
            </Field>
            <Field label="PR date">
              <input
                type="date"
                className="input"
                value={edit.prDate}
                onChange={(e) =>
                  setEdit((s) =>
                    s
                      ? {
                          ...s,
                          prDate: e.target.value,
                          // keep the sequence aligned with the document month
                          prNo:
                            isNew || !/^PR\//.test(s.prNo)
                              ? nextPrNo(e.target.value, allNos)
                              : s.prNo,
                        }
                      : s
                  )
                }
              />
            </Field>
            <Field label="Category">
              <select
                className="input"
                value={edit.category}
                onChange={(e) => setEdit({ ...edit, category: e.target.value })}
              >
                <option value="oversea">oversea</option>
                <option value="local">local</option>
              </select>
            </Field>
            <Field label="Requested by">
              <input
                className="input"
                value={edit.requestedBy}
                onChange={(e) => setEdit({ ...edit, requestedBy: e.target.value })}
              />
            </Field>
            <Field label="Department">
              <input
                className="input"
                value={edit.department}
                onChange={(e) => setEdit({ ...edit, department: e.target.value })}
              />
            </Field>
            <Field label="Currency">
              <select
                className="input"
                value={edit.currency}
                onChange={(e) => setEdit({ ...edit, currency: e.target.value })}
              >
                {Object.entries(PR_CURRENCIES).map(([code, c]) => (
                  <option key={code} value={code}>
                    {c.symbol} - {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Currency rate in MYR (blank = N/A)">
              <input
                type="number"
                step="0.0001"
                className="input"
                value={edit.currencyRate ?? ""}
                onChange={(e) =>
                  setEdit({ ...edit, currencyRate: e.target.value === "" ? null : +e.target.value })
                }
              />
            </Field>
            <Field label="Budget amount (base currency)">
              <input
                type="number"
                className="input"
                value={edit.budgetAmount}
                onChange={(e) => setEdit({ ...edit, budgetAmount: +e.target.value || 0 })}
              />
            </Field>
            <Field label="Status">
              <select
                className="input"
                value={edit.status}
                onChange={(e) => setEdit({ ...edit, status: e.target.value as PrStatus })}
              >
                {PR_STATUSES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-wide text-slate-500">
                Items ({(edit.lines ?? []).length})
              </div>
              <button className="btn-secondary !py-1 !px-2" onClick={addLine}>
                + Add item
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-1 pr-2 w-8">No.</th>
                    <th className="py-1 pr-2">Part No.</th>
                    <th className="py-1 pr-2">Part Name</th>
                    <th className="py-1 pr-2">Description</th>
                    <th className="py-1 pr-2 w-20">UOM</th>
                    <th className="py-1 pr-2 w-28 text-right">Unit price</th>
                    <th className="py-1 pr-2 w-20 text-right">Qty</th>
                    <th className="py-1 pr-2 w-28 text-right">Amount</th>
                    <th className="py-1 pr-2 w-36">Required date</th>
                    <th className="py-1 pr-2">Purpose</th>
                    <th className="py-1 w-10" />
                  </tr>
                </thead>
                <tbody>
                  {(edit.lines ?? []).map((l, i) => (
                    <tr key={sanitizeKey(l.partNo || `line-${i}`) + i} className="border-t border-slate-800 align-top">
                      <td className="py-1.5 pr-2 text-slate-500 tabular-nums">{i + 1}</td>
                      <td className="py-1.5 pr-2">
                        <PartPicker
                          items={db.items}
                          maintParts={db.maintParts}
                          value={l.partNo}
                          onPick={(c) => pickPart(i, c)}
                          onText={(v, resolved) => typePart(i, v, resolved)}
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <PartPicker
                          items={db.items}
                          maintParts={db.maintParts}
                          value={l.partName}
                          field="partName"
                          className="input !py-1"
                          hint={false}
                          onPick={(c) => pickPart(i, c)}
                          onText={(v, resolved) => typePartName(i, v, resolved)}
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          className="input !py-1"
                          value={l.description}
                          onChange={(e) => setLine(i, { description: e.target.value })}
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          className="input !py-1"
                          value={l.uom}
                          onChange={(e) => setLine(i, { uom: e.target.value })}
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          type="number"
                          className="input !py-1 text-right"
                          value={l.unitPrice}
                          onChange={(e) => setLine(i, { unitPrice: +e.target.value || 0 })}
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          type="number"
                          className="input !py-1 text-right"
                          value={l.qty}
                          onChange={(e) => setLine(i, { qty: +e.target.value || 0 })}
                        />
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-sky-300">
                        {fmtMoney(lineTotal(l))}
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          type="date"
                          className="input !py-1"
                          value={l.requiredDate}
                          onChange={(e) => setLine(i, { requiredDate: e.target.value })}
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          className="input !py-1"
                          value={l.purpose}
                          onChange={(e) => setLine(i, { purpose: e.target.value })}
                        />
                      </td>
                      <td className="py-1.5">
                        <button
                          className="btn-secondary !py-1 !px-2"
                          onClick={() => removeLine(i)}
                          title="Remove item"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-700 font-medium">
                    <td colSpan={7} className="py-2 pr-2 text-right text-slate-400">
                      Total ({edit.currency})
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums text-sky-300">
                      {fmtMoney(t?.base ?? 0)}
                    </td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            <Field label="Recommended supplier, if any">
              <input
                className="input"
                value={edit.recommendedSupplier}
                onChange={(e) => setEdit({ ...edit, recommendedSupplier: e.target.value })}
              />
            </Field>
            <Field label="Special requirement">
              <input
                className="input"
                value={edit.specialRequirement}
                onChange={(e) => setEdit({ ...edit, specialRequirement: e.target.value })}
              />
            </Field>
          </div>

          {edit.currencyRate ? (
            <p className="text-xs text-slate-500 mt-3">
              At the entered rate this is {fmtMoney(t?.myr ?? 0, "RM")} against a budget of{" "}
              {fmtMoney(t?.budgetMyr ?? 0, "RM")}.
            </p>
          ) : (
            <p className="text-xs text-amber-400 mt-3">
              No currency rate set. The printed document will show the rate as <b>N/A</b> and both
              MYR figures as 0.00 — enter the rate to get a ringgit total.
            </p>
          )}

          <div className="flex justify-between mt-4">
            {!isNew && <button className="btn-danger" onClick={() => del(edit)}>Delete</button>}
            <div className="flex gap-2 ml-auto">
              {settings && (
                <button
                  className="btn-secondary"
                  title="Preview the printed document"
                  onClick={() => exportPrPdf({ ...edit, prNo: edit.prNo || "DRAFT" }, settings)}
                >
                  Preview PDF
                </button>
              )}
              <button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn-primary" onClick={save}>Save</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
