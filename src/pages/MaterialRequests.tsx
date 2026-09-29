import { useMemo, useState } from "react";
import {
  Badge,
  Card,
  DataTable,
  Field,
  Modal,
  SearchBox,
  Stat,
  exportCsv,
  type Column,
} from "../components/ui";
import { dbPush, dbRemove, dbUpdate } from "../lib/db";
import { fmtNum, fmtQty, todayISO } from "../lib/format";
import { exportMrPdf, type MrDocLine } from "../lib/prPdf";
import { buildPartCatalog } from "../lib/parts";
import { PartPicker } from "../components/PartPicker";
import {
  MR_PRIORITIES,
  MR_STATUSES,
  type MaterialRequest,
  type MrPriority,
  type MrStatus,
} from "../types";
import type { DbData } from "../db-context";

const statusTone = {
  DRAFT: "default",
  PENDING: "info",
  APPROVED: "warn",
  ISSUED: "ok",
  REJECTED: "danger",
  CANCELLED: "danger",
} as const;

const empty: MaterialRequest = {
  mrNo: "",
  reqDate: todayISO(),
  department: "",
  requestedBy: "",
  partNo: "",
  description: "",
  uom: "PC",
  qty: 0,
  neededBy: "",
  purpose: "",
  priority: "NORMAL",
  status: "DRAFT",
  remarks: "",
};

/** Statuses that still need warehouse or approver action. */
const OPEN_STATUSES: MrStatus[] = ["DRAFT", "PENDING", "APPROVED"];

export default function MaterialRequests({ db }: { db: DbData }) {
  const [q, setQ] = useState("");
  const [statusF, setStatusF] = useState("ALL");
  const [deptF, setDeptF] = useState("ALL");
  const [edit, setEdit] = useState<MaterialRequest | null>(null);
  const [isNew, setIsNew] = useState(false);
  /** Ids ticked for a consolidated printout. */
  const [picked, setPicked] = useState<string[]>([]);

  /**
   * Closing stock per part, taken from the most recent month each part appears
   * in. rawStock holds one row per part per month, so the latest month per part
   * is the current balance — a single global "latest month" would drop parts
   * that are no longer being reported.
   */
  const stockByPart = useMemo(() => {
    const m = new Map<string, { month: string; closing: number }>();
    for (const s of db.rawStock) {
      const cur = m.get(s.partNo);
      if (!cur || s.month > cur.month) m.set(s.partNo, { month: s.month, closing: s.closing });
    }
    return m;
  }, [db.rawStock]);

  /**
   * One part catalogue for the picker, drawing on both the master items and the
   * Spare Part Status list — see buildPartCatalog for how the two are merged.
   */
  const partCatalog = useMemo(
    () => buildPartCatalog(db.items, db.maintParts),
    [db.items, db.maintParts]
  );

  const departments = useMemo(
    () => [...new Set(db.materialRequests.map((m) => m.department).filter(Boolean))].sort(),
    [db.materialRequests]
  );

  /** A spare part's own balance wins; otherwise fall back to the latest month. */
  const stockOf = (partNo: string) => {
    const c = partCatalog.get(partNo);
    if (c?.spare) return c.stock;
    return stockByPart.get(partNo)?.closing ?? null;
  };
  const stockMonth = (partNo: string) =>
    partCatalog.get(partNo)?.spare ? "spare part list" : stockByPart.get(partNo)?.month || "";

  /**
   * Joins a request to its catalogue entry and current balance so the printed
   * document carries the price, currency and stock figure. A request for a
   * part in neither list still prints — it just has no price.
   */
  const docLine = (m: MaterialRequest): MrDocLine => {
    const c = partCatalog.get(m.partNo);
    return {
      mr: m,
      unitPrice: c?.price ?? 0,
      currency: c?.currency || "RM",
      stock: stockOf(m.partNo),
      supplier: c?.supplier ?? "",
    };
  };

  const togglePick = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const printOne = (m: MaterialRequest) => {
    if (!db.settings) return alert("Settings have not loaded yet.");
    exportMrPdf([docLine(m)], db.settings);
  };

  const printPicked = () => {
    if (!db.settings) return alert("Settings have not loaded yet.");
    if (pickedRows.length === 0) return alert("Tick at least one request to print.");
    exportMrPdf(pickedRows.map(docLine), db.settings);
  };

  const rows = useMemo(() => {
    const n = q.toLowerCase();
    return db.materialRequests
      .filter((m) => {
        if (statusF !== "ALL" && m.status !== statusF) return false;
        if (deptF !== "ALL" && m.department !== deptF) return false;
        if (!n) return true;
        return (
          m.mrNo.toLowerCase().includes(n) ||
          m.partNo.toLowerCase().includes(n) ||
          m.description.toLowerCase().includes(n) ||
          m.department.toLowerCase().includes(n) ||
          m.requestedBy.toLowerCase().includes(n)
        );
      })
      .sort((a, b) => (b.reqDate ?? "").localeCompare(a.reqDate ?? ""));
  }, [db.materialRequests, q, statusF, deptF]);

  const pickedRows = useMemo(
    () => rows.filter((r) => picked.includes(r.id ?? "")),
    [rows, picked]
  );

  const open = db.materialRequests.filter((m) => OPEN_STATUSES.includes(m.status));
  const openQty = open.reduce((s, m) => s + (Number(m.qty) || 0), 0);
  const shortfalls = open.filter((m) => {
    const s = stockOf(m.partNo);
    return s !== null && s < (Number(m.qty) || 0);
  });
  // Requests can be raised against parts priced in different currencies, so the
  // headline figure converts what it can and says so when it cannot.
  let openValue = 0;
  let unconvertedValue = 0;
  for (const r of open) {
    const c = partCatalog.get(r.partNo);
    const v = (Number(r.qty) || 0) * (c?.price ?? 0);
    if (v <= 0) continue;
    const cur = c?.currency || "RM";
    if (cur === "RM" || cur === "MYR") openValue += v;
    else if (cur === "JPY") openValue += v * (Number(db.settings?.jpyRate) || 0);
    else if (cur === "USD") openValue += v * (Number(db.settings?.usdRate) || 0);
    else {
      openValue += v;
      unconvertedValue += v;
    }
  }

  /** Next sequential MR number for the current year. */
  const nextMrNo = () => {
    const year = new Date().getFullYear();
    const prefix = `MR-${year}-`;
    const used = db.materialRequests
      .map((m) => m.mrNo)
      .filter((no) => no.startsWith(prefix))
      .map((no) => Number(no.slice(prefix.length)))
      .filter((n) => Number.isFinite(n));
    const next = used.length ? Math.max(...used) + 1 : 1;
    return prefix + String(next).padStart(3, "0");
  };

  const save = async () => {
    if (!edit) return;
    const partNo = edit.partNo.trim();
    if (!partNo) return alert("Part No is required");
    if (!(Number(edit.qty) > 0)) return alert("Qty must be greater than zero");

    const rec: MaterialRequest = {
      ...edit,
      mrNo: edit.mrNo.trim() || nextMrNo(),
      partNo,
      description: edit.description.trim(),
      department: edit.department.trim(),
      requestedBy: edit.requestedBy.trim(),
      uom: edit.uom.trim() || "PC",
      qty: Number(edit.qty) || 0,
      updatedAt: Date.now(),
    };
    if (isNew) await dbPush("materialRequests", { ...rec, createdAt: Date.now() });
    else await dbUpdate(`materialRequests/${edit.id}`, rec);
    setEdit(null);
  };

  const del = async (row: MaterialRequest) => {
    if (!confirm(`Delete material request ${row.mrNo}?`)) return;
    await dbRemove(`materialRequests/${row.id}`);
    setEdit(null);
  };

  /** Move a request to an explicit status, stamping approval details. */
  const setStatus = async (row: MaterialRequest, status: MrStatus) => {
    const patch: Partial<MaterialRequest> = { status, updatedAt: Date.now() };
    if (status === "APPROVED") {
      // freeze the balance the request was approved against
      patch.approvedAt = Date.now();
      patch.stockAtRequest = stockOf(row.partNo) ?? undefined;
    }
    await dbUpdate(`materialRequests/${row.id}`, patch);
  };

  const nextStatus = (s: MrStatus): MrStatus | null => {
    switch (s) {
      case "DRAFT":
        return "PENDING";
      case "PENDING":
        return "APPROVED";
      case "APPROVED":
        return "ISSUED";
      default:
        return null;
    }
  };

  const cols: Column<MaterialRequest>[] = [
    {
      key: "pick",
      header: "",
      value: (r) => (picked.includes(r.id ?? "") ? "1" : ""),
      render: (r) => (
        <input
          type="checkbox"
          className="accent-sky-500 w-4 h-4"
          checked={picked.includes(r.id ?? "")}
          onClick={(e) => e.stopPropagation()}
          onChange={() => togglePick(r.id ?? "")}
          title="Select for a consolidated printout"
        />
      ),
    },
    {
      key: "mr",
      header: "MR No",
      value: (r) => r.mrNo,
      render: (r) => <span className="font-mono text-xs">{r.mrNo || "-"}</span>,
    },
    { key: "date", header: "Req Date", value: (r) => r.reqDate },
    { key: "dept", header: "Department", value: (r) => r.department },
    { key: "by", header: "Requested By", value: (r) => r.requestedBy },
    {
      key: "part",
      header: "Part No",
      value: (r) => r.partNo,
      render: (r) => <span className="font-mono text-xs">{r.partNo}</span>,
    },
    {
      key: "desc",
      header: "Description",
      value: (r) => r.description,
      render: (r) => (
        <span className="block max-w-52 truncate" title={r.description}>
          {r.description}
        </span>
      ),
    },
    {
      key: "qty",
      header: "Qty",
      value: (r) => r.qty,
      align: "right",
      render: (r) => fmtQty(r.qty),
    },
    { key: "uom", header: "UoM", value: (r) => r.uom },
    {
      key: "stock",
      header: "In Stock",
      align: "right",
      value: (r) => stockOf(r.partNo) ?? "",
      render: (r) => {
        const s = stockOf(r.partNo);
        if (s === null) return <span className="text-slate-600" title="No stock record">—</span>;
        const short = OPEN_STATUSES.includes(r.status) && s < (Number(r.qty) || 0);
        return (
          <span
            className={short ? "text-rose-400" : "text-slate-300"}
            title={`Closing stock for ${stockMonth(r.partNo) || "unknown month"}`}
          >
            {fmtQty(s)}
            {short && <span className="text-rose-400"> ⚠</span>}
          </span>
        );
      },
    },
    {
      key: "needed",
      header: "Needed By",
      value: (r) => r.neededBy,
      render: (r) => {
        if (!r.neededBy) return "-";
        const overdue = OPEN_STATUSES.includes(r.status) && r.neededBy < todayISO();
        return <span className={overdue ? "text-rose-400 font-medium" : ""}>{r.neededBy}</span>;
      },
    },
    {
      key: "prio",
      header: "Priority",
      value: (r) => r.priority,
      render: (r) =>
        r.priority === "URGENT" ? (
          <Badge tone="danger">URGENT</Badge>
        ) : (
          <span className="text-xs text-slate-500">{r.priority}</span>
        ),
    },
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
        const nxt = nextStatus(r.status);
        return (
          <div className="flex gap-1 justify-end">
            <button
              className="btn-secondary !py-0.5 !px-2 text-xs"
              title="Open the print dialog to save this request as a PDF"
              onClick={(e) => {
                e.stopPropagation();
                printOne(r);
              }}
            >
              PDF
            </button>
            {nxt && (
              <button
                className="btn-secondary !py-0.5 !px-2 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  setStatus(r, nxt);
                }}
              >
                → {nxt}
              </button>
            )}
          </div>
        );
      },
    },
  ];

  const editStock = edit?.partNo ? stockOf(edit.partNo) : null;
  const editShort =
    editStock !== null && editStock < (Number(edit?.qty) || 0);

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Material Requests</h1>
          <p className="text-sm text-slate-500">
            Internal requests for materials already held in the warehouse.
          </p>
        </div>
        <div className="flex gap-2">
          <select
            className="input !w-36"
            value={deptF}
            onChange={(e) => setDeptF(e.target.value)}
          >
            <option>ALL</option>
            {departments.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
          <select
            className="input !w-32"
            value={statusF}
            onChange={(e) => setStatusF(e.target.value)}
          >
            <option>ALL</option>
            {MR_STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <SearchBox value={q} onChange={setQ} />
          <button
            className="btn-secondary"
            onClick={() => exportCsv("material_requests.csv", rows, cols)}
          >
            Export
          </button>
          <button
            className="btn-secondary"
            onClick={printPicked}
            disabled={pickedRows.length === 0}
            title={
              pickedRows.length
                ? `Print ${pickedRows.length} selected request(s) on one sheet`
                : "Tick requests in the table to print them together"
            }
          >
            Print selected{pickedRows.length ? ` (${pickedRows.length})` : ""}
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEdit({ ...empty, mrNo: nextMrNo() });
              setIsNew(true);
            }}
          >
            + New Request
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        <Stat label="Open Requests" value={fmtQty(open.length)} />
        <Stat label="Open Qty" value={fmtQty(openQty)} />
        <Stat
          label="Below Stock"
          value={fmtQty(shortfalls.length)}
          tone={shortfalls.length ? "danger" : "ok"}
          sub={shortfalls.length ? "qty exceeds balance" : "all covered"}
        />
        <Stat
          label="Est. Value"
          value={fmtNum(openValue, 0)}
          sub={
            unconvertedValue > 0
              ? "RM · foreign currency at face value"
              : "RM"
          }
        />
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
          emptyText="No material requests yet. Use + New Request to raise one."
        />
      </Card>

      {edit && (
        <Modal
          title={isNew ? "New Material Request" : `Edit ${edit.mrNo || "request"}`}
          onClose={() => setEdit(null)}
          wide
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="MR No">
              <input
                className="input font-mono"
                value={edit.mrNo}
                onChange={(e) => setEdit({ ...edit, mrNo: e.target.value })}
              />
            </Field>
            <Field label="Request Date">
              <input
                type="date"
                className="input"
                value={edit.reqDate}
                onChange={(e) => setEdit({ ...edit, reqDate: e.target.value })}
              />
            </Field>
            <Field label="Needed By">
              <input
                type="date"
                className="input"
                value={edit.neededBy}
                onChange={(e) => setEdit({ ...edit, neededBy: e.target.value })}
              />
            </Field>

            <Field label="Department">
              <input
                className="input"
                list="mr-departments"
                value={edit.department}
                onChange={(e) => setEdit({ ...edit, department: e.target.value })}
              />
              <datalist id="mr-departments">
                {departments.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
            </Field>
            <Field label="Requested By">
              <input
                className="input"
                value={edit.requestedBy}
                onChange={(e) => setEdit({ ...edit, requestedBy: e.target.value })}
              />
            </Field>
            <Field label="Priority">
              <select
                className="input"
                value={edit.priority}
                onChange={(e) =>
                  setEdit({ ...edit, priority: e.target.value as MrPriority })
                }
              >
                {MR_PRIORITIES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>

            <Field label="Part No *">
              <PartPicker
                items={db.items}
                maintParts={db.maintParts}
                value={edit.partNo}
                emptyList="toOrder"
                onPick={(c) =>
                  setEdit({ ...edit, partNo: c.partNo, description: c.description, uom: c.uom })
                }
                onText={(v, resolved) => {
                  if (resolved) {
                    setEdit({
                      ...edit,
                      partNo: resolved.partNo,
                      description: resolved.description,
                      uom: resolved.uom,
                    });
                    return;
                  }
                  // Editing the part number away from a catalogue part must not
                  // leave the previous part's name, unit and price behind.
                  const held = partCatalog.get(edit.partNo.trim());
                  setEdit(
                    held
                      ? { ...edit, partNo: v, description: "", uom: "PC" }
                      : { ...edit, partNo: v }
                  );
                }}
                className="input"
              />
            </Field>
            <Field label="Description">
              <PartPicker
                items={db.items}
                maintParts={db.maintParts}
                value={edit.description}
                field="partName"
                className="input"
                hint={false}
                onPick={(c) =>
                  setEdit({
                    ...edit,
                    partNo: c.partNo,
                    description: c.description,
                    uom: c.uom,
                  })
                }
                onText={(v, resolved) => {
                  if (resolved) {
                    setEdit({
                      ...edit,
                      partNo: resolved.partNo,
                      description: resolved.description,
                      uom: resolved.uom,
                    });
                    return;
                  }
                  // The description no longer names the part on file, so the
                  // request would otherwise keep a part number that contradicts
                  // it. Clear it rather than print a mismatched line.
                  const heldIsCataloguePart = !!partCatalog.get(edit.partNo.trim());
                  setEdit(
                    heldIsCataloguePart
                      ? { ...edit, description: v, partNo: "", uom: "PC" }
                      : { ...edit, description: v }
                  );
                }}
              />
            </Field>
            <Field label="UoM">
              <input
                className="input"
                value={edit.uom}
                onChange={(e) => setEdit({ ...edit, uom: e.target.value })}
              />
            </Field>

            <Field label="Qty Requested *">
              <input
                type="number"
                min={0}
                className="input"
                value={edit.qty}
                onChange={(e) => setEdit({ ...edit, qty: +e.target.value })}
              />
            </Field>
            <Field label="In Stock">
              <div
                className={
                  "input flex items-center " +
                  (editShort ? "text-rose-400 border-rose-500/50" : "text-slate-400")
                }
              >
                {editStock === null
                  ? "No stock record"
                  : `${fmtQty(editStock)} (${stockMonth(edit.partNo)})`}
              </div>
            </Field>            <Field label="Status">
              <select
                className="input"
                value={edit.status}
                onChange={(e) => setEdit({ ...edit, status: e.target.value as MrStatus })}
              >
                {MR_STATUSES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>

            <Field label="Purpose">
              <input
                className="input"
                value={edit.purpose}
                onChange={(e) => setEdit({ ...edit, purpose: e.target.value })}
              />
            </Field>
            <Field label="Approved By">
              <input
                className="input"
                value={edit.approvedBy ?? ""}
                onChange={(e) => setEdit({ ...edit, approvedBy: e.target.value })}
              />
            </Field>
            <Field label="Remarks">
              <input
                className="input"
                value={edit.remarks}
                onChange={(e) => setEdit({ ...edit, remarks: e.target.value })}
              />
            </Field>
          </div>

          {editShort && (
            <p className="mt-3 text-xs text-rose-400">
              Requested qty exceeds the closing stock for {stockMonth(edit.partNo)} by{" "}
              {fmtQty((Number(edit.qty) || 0) - (editStock ?? 0))} {edit.uom}. The request can
              still be raised, but the shortfall will need a purchase order.
            </p>
          )}

          <div className="flex justify-between mt-4">
            {!isNew && (
              <button className="btn-danger" onClick={() => del(edit)}>
                Delete
              </button>
            )}
            <div className="flex gap-2 ml-auto">
              {!isNew && OPEN_STATUSES.includes(edit.status) && (
                <button
                  className="btn-secondary"
                  onClick={async () => {
                    if (!confirm(`Reject request ${edit.mrNo}?`)) return;
                    await setStatus(edit, "REJECTED");
                    setEdit(null);
                  }}
                >
                  Reject
                </button>
              )}
              <button
                className="btn-secondary"
                title="Preview the printed document"
                onClick={() => {
                  if (!db.settings) return alert("Settings have not loaded yet.");
                  exportMrPdf([docLine({ ...edit, mrNo: edit.mrNo || "DRAFT" })], db.settings);
                }}
              >
                Preview PDF
              </button>
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
