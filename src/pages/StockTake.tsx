import { useMemo, useState } from "react";
import { Card, DataTable, Modal, Field, Badge, SearchBox, exportCsv, Stat, type Column } from "../components/ui";
import { fmtQty, monthLabel, todayISO, currentMonth } from "../lib/format";
import { dbPush, dbSet, dbPushMany, dbRemove } from "../lib/db";
import { sanitizeKey } from "../lib/db";
import type { StockTake, StockTakeLine, StockRecord } from "../types";
import type { DbData } from "../db-context";

// Firebase strips null values, so a never-counted line comes back with
// countedQty === undefined. Treat null/undefined uniformly as "not counted".
const isCounted = (l: StockTakeLine) => l.countedQty !== null && l.countedQty !== undefined;
const varianceOf = (l: StockTakeLine) => (isCounted(l) ? (l.countedQty as number) - l.systemQty : 0);

function stockToLines(db: DbData): Record<string, StockTakeLine> {
  const map: Record<string, StockTakeLine> = {};
  for (const s of db.rawStock) {
    const key = sanitizeKey(s.partNo);
    if (!map[key]) {
      map[key] = {
        partNo: s.partNo,
        description: s.description,
        supplier: s.supplier,
        uom: s.uom,
        systemQty: 0,
        countedQty: null,
        remarks: "",
      };
    }
    map[key].systemQty += s.closing;
  }
  return map;
}

export default function StockTakePage({ db }: { db: DbData }) {
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newMonth, setNewMonth] = useState(currentMonth());
  const [newName, setNewName] = useState("");
  const [newRemarks, setNewRemarks] = useState("");
  const [busy, setBusy] = useState(false);

  const takes = useMemo(
    () => [...db.stockTakes].sort((a, b) => b.createdAt - a.createdAt),
    [db.stockTakes]
  );
  const sel = takes.find((t) => t.id === selId) ?? null;

  const lines = useMemo(() => {
    if (!sel) return [];
    const n = q.toLowerCase();
    return Object.values(sel.lines ?? {})
      .filter(
        (l) =>
          !n ||
          l.partNo.toLowerCase().includes(n) ||
          l.description.toLowerCase().includes(n) ||
          l.supplier.toLowerCase().includes(n)
      )
      .sort((a, b) => a.partNo.localeCompare(b.partNo));
  }, [sel, q]);

  const stats = useMemo(() => {
    if (!sel) return null;
    const all = Object.values(sel.lines ?? {});
    const counted = all.filter(isCounted);
    const diffLines = counted.filter((l) => l.countedQty !== l.systemQty);
    const varianceQty = counted.reduce((s, l) => s + ((l.countedQty ?? 0) - l.systemQty), 0);
    const varianceValue = counted.reduce((s, l) => {
      const item = db.items.find((i) => i.pnaPartNo === l.partNo);
      return s + ((l.countedQty ?? 0) - l.systemQty) * (item?.price ?? 0);
    }, 0);
    return { total: all.length, counted: counted.length, diffLines: diffLines.length, varianceQty, varianceValue };
  }, [sel, db.items]);

  const create = async () => {
    setBusy(true);
    try {
      const take: Omit<StockTake, "id"> = {
        name: newName.trim() || `Stock Take ${newMonth || ""}`.trim(),
        month: newMonth,
        status: "OPEN",
        createdAt: Date.now(),
        remarks: newRemarks,
        lines: stockToLines(db),
      };
      const id = await dbPush("stockTakes", take);
      setCreating(false);
      setSelId(id);
      setNewName("");
      setNewRemarks("");
    } finally {
      setBusy(false);
    }
  };

  const saveLine = async (key: string, line: StockTakeLine) => {
    if (!sel) return;
    await dbSet(`stockTakes/${sel.id}/lines/${key}`, line);
  };

  const post = async () => {
    if (!sel || !stats) return;
    const counted = Object.values(sel.lines).filter(isCounted);
    if (counted.length === 0) {
      alert("Enter at least one counted quantity before posting.");
      return;
    }
    if (
      !confirm(
        `Post stock take ${monthLabel(sel.month)} to Inventory?\n` +
          `${counted.length} counted lines will REPLACE the closing qty in rawStock for month ${sel.month}.\n` +
          `Parts not counted keep their current closing qty.`
      )
    )
      return;
    setBusy(true);
    try {
      // Build updated stock: keep uncounted parts as-is; counted parts become adjustments
      const byKey = new Map<string, StockTakeLine>();
      for (const [k, l] of Object.entries(sel.lines)) byKey.set(k, l);

      // group existing rawStock lines per part (keep multiple lines if different supplier/model, adjust proportionally on first line)
      const existing = new Map<string, StockRecord[]>();
      for (const s of db.rawStock) {
        const arr = existing.get(s.partNo) ?? [];
        arr.push(s);
        existing.set(s.partNo, arr);
      }

      const updates: Record<string, unknown> = {};
      const adds: Omit<StockRecord, "id">[] = [];
      const applied: string[] = [];

      for (const line of byKey.values()) {
        if (!isCounted(line)) continue;
        const countedQty = Number(line.countedQty) || 0;
        const variance = countedQty - (Number(line.systemQty) || 0);
        const recs = existing.get(line.partNo) ?? [];
        if (recs.length === 0) {
          adds.push({
            partNo: line.partNo,
            supplierPartNo: "",
            description: line.description ?? "",
            supplier: line.supplier ?? "",
            model: "",
            uom: line.uom ?? "PC",
            month: sel.month,
            opening: 0,
            receiving: variance > 0 ? variance : 0,
            issuance: variance < 0 ? -variance : 0,
            closing: countedQty,
            updatedAt: Date.now(),
          });
          applied.push(`${line.partNo}: NEW line closing=${countedQty}`);
        } else if (recs.length === 1) {
          const rec = recs[0];
          updates[`rawStock/${rec.id}`] = {
            ...rec,
            partNo: rec.partNo ?? line.partNo,
            description: rec.description ?? line.description ?? "",
            supplier: rec.supplier ?? line.supplier ?? "",
            supplierPartNo: rec.supplierPartNo ?? "",
            model: rec.model ?? "",
            uom: rec.uom ?? line.uom ?? "PC",
            opening: Number(rec.opening) || 0,
            receiving: variance >= 0 ? (Number(rec.receiving) || 0) + variance : Number(rec.receiving) || 0,
            issuance: variance < 0 ? (Number(rec.issuance) || 0) - variance : Number(rec.issuance) || 0,
            closing: countedQty,
            month: sel.month,
            updatedAt: Date.now(),
          };
          applied.push(`${line.partNo}: ${Number(rec.closing) || 0} → ${countedQty}`);
        } else {
          // multiple lines: scale proportionally, largest line absorbs rounding
          const total = recs.reduce((s, r) => s + (Number(r.closing) || 0), 0);
          const sorted = [...recs].sort((a, b) => (Number(b.closing) || 0) - (Number(a.closing) || 0));
          let remaining = countedQty;
          sorted.forEach((rec, idx) => {
            const share = Math.max(
              0,
              idx === sorted.length - 1
                ? remaining
                : Math.round(total > 0 ? ((Number(rec.closing) || 0) / total) * countedQty : 0)
            );
            remaining -= share;
            updates[`rawStock/${rec.id}`] = {
              ...rec,
              closing: share,
              month: sel.month,
              updatedAt: Date.now(),
            };
          });
          applied.push(`${line.partNo}: ${recs.length} lines re-split to total ${countedQty}`);
        }
      }

      try {
        await dbPushMany("rawStock", adds);
        for (const [path, val] of Object.entries(updates)) {
          await dbSet(path, val);
        }
      } catch (e: any) {
        alert(
          `Posting FAILED while writing to Inventory: ${e?.message ?? e}\n` +
            `Nothing was marked posted — check connection/rules and try again.`
        );
        return;
      }

      await dbSet(`stockTakes/${sel.id}/status`, "POSTED");
      await dbSet(`stockTakes/${sel.id}/postedAt`, Date.now());
      await dbSet(`stockTakes/${sel.id}/status`, "OPEN"); // posting no longer closes the session
      alert(
        `Posted to Inventory ✔ — session stays OPEN for more counting.\n\n` +
          applied
            .slice(0, 15)
            .map((a) => `• ${a}`)
            .join("\n") +
          (applied.length > 15 ? `\n… and ${applied.length - 15} more` : "")
      );
    } finally {
      setBusy(false);
    }
  };

  const closeSession = async () => {
    if (!sel) return;
    const counted = Object.values(sel.lines).filter(isCounted);
    const unposted = sel.status === "OPEN" && !sel.postedAt;
    const msg =
      `Close stock take session "${sel.name || "(unnamed)"}"?\n\n` +
      `Counted lines: ${counted.length}\n` +
      (unposted
        ? `⚠ This session has NEVER been posted to Inventory. Closing it now locks counting without applying your counts.\n`
        : ``) +
      `A closed session is read-only: no more edits or posting. You can reopen it later if needed.`;
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      await dbSet(`stockTakes/${sel.id}/status`, "CLOSED");
      await dbSet(`stockTakes/${sel.id}/closedAt`, Date.now());
    } finally {
      setBusy(false);
    }
  };

  const reopenSession = async () => {
    if (!sel) return;
    if (!confirm(`Reopen session "${sel.name || "(unnamed)"}" for editing?`)) return;
    setBusy(true);
    try {
      await dbSet(`stockTakes/${sel.id}/status`, "OPEN");
      await dbSet(`stockTakes/${sel.id}/closedAt`, null);
    } finally {
      setBusy(false);
    }
  };

  // ---- session management ----
  const [manageId, setManageId] = useState<string | null>(null);
  const [editMeta, setEditMeta] = useState<StockTake | null>(null);
  const manageTarget = takes.find((t) => t.id === manageId) ?? null;

  const saveMeta = async () => {
    if (!editMeta) return;
    setBusy(true);
    try {
      await dbSet(`stockTakes/${editMeta.id}`, {
        ...editMeta,
        name: editMeta.name.trim() || "(unnamed)",
      });
      setEditMeta(null);
    } finally {
      setBusy(false);
    }
  };

  const deleteSession = async (t: StockTake & { id: string }) => {
    if (
      !confirm(
        `DELETE session "${t.name || "(unnamed)"}" (${monthLabel(t.month)})?\n\n` +
          `Only the session record is removed. Inventory is NOT affected.\n` +
          `This cannot be undone.`
      )
    )
      return;
    setBusy(true);
    try {
      await dbRemove(`stockTakes/${t.id}`);
      if (selId === t.id) setSelId(null);
      if (manageId === t.id) setManageId(null);
    } finally {
      setBusy(false);
    }
  };

  const duplicateSession = async (t: StockTake & { id: string }) => {
    setBusy(true);
    try {
      const copy: Omit<StockTake, "id"> = {
        name: `${t.name || "(unnamed)"} (copy)`,
        month: t.month,
        status: "OPEN",
        createdAt: Date.now(),
        remarks: t.remarks ?? "",
        lines: JSON.parse(JSON.stringify(t.lines ?? {})),
      };
      // fresh copy: clear counted values so it can be reused as a re-count sheet
      if (
        confirm(
          `Duplicate "${t.name || "(unnamed)"}"?\n\nOK = blank copy (counted qty cleared, ready for a fresh count)\nCancel = keep counted values`
        )
      ) {
        for (const l of Object.values(copy.lines)) l.countedQty = null;
      }
      const id = await dbPush("stockTakes", copy);
      setManageId(null);
      setSelId(id);
    } finally {
      setBusy(false);
    }
  };

  const refreshSnapshot = async () => {
    if (!sel) return;
    if (sel.status === "CLOSED") {
      alert("Reopen the session before refreshing its snapshot.");
      return;
    }
    if (
      !confirm(
        `Refresh "System Qty" from current Inventory?\n\nCounted values are kept. Lines not present in Inventory anymore stay in the session. New stock lines are added.`
      )
    )
      return;
    setBusy(true);
    try {
      const fresh = stockToLines(db);
      const merged: Record<string, StockTakeLine> = { ...(sel.lines ?? {}) };
      for (const [k, l] of Object.entries(fresh)) {
        const prev = merged[k];
        merged[k] = prev ? { ...prev, systemQty: l.systemQty } : l;
      }
      await dbSet(`stockTakes/${sel.id}/lines`, merged);
    } finally {
      setBusy(false);
    }
  };

  const deleteLine = async (key: string, partNo: string) => {
    if (!sel) return;
    if (sel.status === "CLOSED") {
      alert("Reopen the session before removing lines.");
      return;
    }
    if (!confirm(`Remove line ${partNo} from this session?\n(Inventory is not affected.)`)) return;
    await dbRemove(`stockTakes/${sel.id}/lines/${key}`);
  };

  const takesCols: Column<StockTake & { id: string }>[] = [
    { key: "name", header: "Session Name", value: (r) => r.name || `(unnamed)`, render: (r) => <span className="font-medium">{r.name || "(unnamed)"}</span> },
    { key: "month", header: "Month", value: (r) => monthLabel(r.month) },
    {
      key: "status",
      header: "Status",
      value: (r) => r.status,
      render: (r) => (
        <Badge tone={r.status === "OPEN" ? "warn" : r.status === "CLOSED" ? "default" : "ok"}>
          {r.status === "POSTED" ? "POSTED (legacy)" : r.status}
        </Badge>
      ),
    },
    { key: "lines", header: "Lines", value: (r) => Object.keys(r.lines ?? {}).length, align: "right", render: (r) => fmtQty(Object.keys(r.lines ?? {}).length) },
    {
      key: "counted",
      header: "Counted",
      value: (r) => (Object.values(r.lines ?? {}).filter(isCounted).length),
      align: "right",
      render: (r) => {
        const c = Object.values(r.lines ?? {}).filter(isCounted).length;
        return c;
      },
    },
    { key: "created", header: "Created", value: (r) => new Date(r.createdAt).toLocaleDateString() },
    { key: "rem", header: "Remarks", value: (r) => r.remarks ?? "", render: (r) => <span className="block max-w-48 truncate">{r.remarks || "-"}</span> },
    {
      key: "manage",
      header: "Manage",
      render: (r) => (
        <button
          className="btn-secondary !py-0.5 !px-2 text-xs"
          onClick={(e) => {
            e.stopPropagation();
            setManageId(r.id);
          }}
        >
          ⚙ Manage
        </button>
      ),
    },
  ];

  const lineCols: Column<StockTakeLine & { _key: string }>[] = [
    { key: "part", header: "Part No", value: (r) => r.partNo, render: (r) => <span className="font-mono text-xs">{r.partNo}</span> },
    { key: "desc", header: "Description", value: (r) => r.description, render: (r) => <span className="block max-w-52 truncate" title={r.description}>{r.description}</span> },
    { key: "uom", header: "UoM", value: (r) => r.uom },
    { key: "sys", header: "System Qty", value: (r) => r.systemQty, align: "right", render: (r) => fmtQty(r.systemQty) },
    {
      key: "count",
      header: "Counted Qty",
      value: (r) => r.countedQty ?? "",
      align: "right",
      render: (r) => (
        <input
          type="number"
          className="input !w-28 !py-1 text-right ml-auto"
          value={r.countedQty ?? ""}
          placeholder="—"
          disabled={sel?.status === "CLOSED"}
          onClick={(e) => e.stopPropagation()}
          onChange={async (e) => {
            const v = e.target.value === "" ? null : +e.target.value;
            await saveLine(r._key, { ...r, countedQty: v });
          }}
        />
      ),
    },
    {
      key: "var",
      header: "Variance",
      value: (r) => (isCounted(r) ? r.countedQty! - r.systemQty : ""),
      align: "right",
      render: (r) => {
        if (!isCounted(r)) return <span className="text-slate-600">—</span>;
        const v = varianceOf(r);
        return v === 0 ? (
          <Badge tone="ok">0</Badge>
        ) : (
          <span className={`font-semibold ${v > 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {v > 0 ? "+" : ""}
            {fmtQty(v)}
          </span>
        );
      },
      className: (r) =>
        isCounted(r) && r.countedQty !== r.systemQty ? "bg-amber-950/20" : "",
    },
    { key: "rem", header: "Remarks", value: (r) => r.remarks, render: (r) => (
      <input
        className="input !w-40 !py-1"
        value={r.remarks}
        placeholder="note…"
        disabled={sel?.status === "CLOSED"}
        onClick={(e) => e.stopPropagation()}
        onChange={async (e) => {
          await saveLine(r._key, { ...r, remarks: e.target.value });
        }}
      />
    ) },
    {
      key: "del",
      header: "",
      render: (r) =>
        sel?.status === "CLOSED" ? null : (
          <button
            className="text-rose-500 hover:text-rose-300 px-1"
            title="Remove line from session"
            onClick={(e) => {
              e.stopPropagation();
              deleteLine(r._key, r.partNo);
            }}
          >
            ✕
          </button>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Stock Take</h1>
          <p className="text-sm text-slate-500">
            Physical count sessions · create → enter counts → post to Inventory
          </p>
        </div>
        <button
          className="btn-primary"
          disabled={busy}
          onClick={() => setCreating(true)}
        >
          + New Stock Take
        </button>
      </div>

      {takes.length === 0 ? (
        <Card>
          <div className="text-center py-10 text-slate-500 text-sm">
            No stock take sessions yet. Click <b>+ New Stock Take</b> to snapshot current system
            quantities ({fmtQty(db.rawStock.length)} stock lines) and start counting.
          </div>
        </Card>
      ) : (
        <Card>
          <DataTable columns={takesCols} rows={takes} onRowClick={(r) => setSelId(r.id)} />
        </Card>
      )}

      {/* Session detail */}
      {sel && stats && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-start justify-center p-2 sm:p-6 overflow-y-auto">
          <div className="card w-full max-w-6xl my-2">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div>
              <h3 className="font-bold text-lg">
                {sel.name || "(unnamed session)"}{" "}
                <Badge tone={sel.status === "OPEN" ? "warn" : sel.status === "CLOSED" ? "default" : "ok"}>
                  {sel.status === "POSTED" ? "POSTED (legacy)" : sel.status}
                </Badge>
                {sel.postedAt && (
                  <span className="text-xs text-emerald-400 ml-2">
                    last posted {new Date(sel.postedAt).toLocaleString()}
                  </span>
                )}
              </h3>
                <p className="text-xs text-slate-500">
                  {monthLabel(sel.month)} · {sel.remarks || "no remarks"} · created{" "}
                  {new Date(sel.createdAt).toLocaleString()}
                </p>
              </div>
              <div className="flex gap-2">
                {sel.status === "OPEN" && (
                  <>
                    <button className="btn-primary" disabled={busy} onClick={post}>
                      ✓ Post to Inventory
                    </button>
                    <button className="btn-secondary" disabled={busy} onClick={closeSession}>
                      ⏹ Close Session
                    </button>
                  </>
                )}
                {sel.status === "CLOSED" && (
                  <button className="btn-secondary" disabled={busy} onClick={reopenSession}>
                    ↺ Reopen Session
                  </button>
                )}
                <button className="btn-secondary" disabled={busy} onClick={refreshSnapshot} title="Re-snapshot System Qty from current Inventory">
                  ⟳ Refresh Snapshot
                </button>
                <button
                  className="btn-secondary"
                  onClick={() =>
                    exportCsv(`stocktake_${sel.month}.csv`, lines.map((l) => ({ ...l, _key: "" })), lineCols.slice(0, 6))
                  }
                >
                  Export
                </button>
                <button className="btn-secondary" onClick={() => setSelId(null)}>
                  Close
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3 mb-3">
              <Stat label="Lines" value={fmtQty(stats.total)} />
              <Stat label="Counted" value={fmtQty(stats.counted)} tone="ok" />
              <Stat label="Variance Lines" value={fmtQty(stats.diffLines)} tone={stats.diffLines ? "warn" : "ok"} />
              <Stat label="Variance Qty" value={`${stats.varianceQty > 0 ? "+" : ""}${fmtQty(stats.varianceQty)}`} tone={stats.varianceQty < 0 ? "danger" : "ok"} />
              <Stat label="Variance Value" tone={stats.varianceValue < 0 ? "danger" : "ok"} value={`${stats.varianceValue < 0 ? "-" : ""}${Math.abs(stats.varianceValue).toLocaleString("en-US", { maximumFractionDigits: 0 })} RM`} />
            </div>

            <div className="flex gap-2 mb-2">
              <SearchBox value={q} onChange={setQ} placeholder="Search part / description…" />
            </div>

            <DataTable
              columns={lineCols}
              rows={lines.map((l) => {
                const key = Object.entries(sel.lines ?? {}).find(
                  ([, v]) => v.partNo === l.partNo
                )?.[0];
                return { ...l, _key: key ?? sanitizeKey(l.partNo) };
              })}
              pageSize={100}
              dense
              emptyText={stats.counted === 0 ? "No lines match" : "No lines match"}
            />
            <p className="text-xs text-slate-500 mt-2">
              Counts save automatically as you type.{" "}
              {sel.status === "CLOSED"
                ? "This session is CLOSED — read-only. Reopen it to make changes."
                : "Posting applies counted quantities to Inventory but keeps the session OPEN. Use ⏹ Close Session when counting is finished."}
            </p>
          </div>
        </div>
      )}

      {/* Create modal */}
      {creating && (
        <Modal title="New Stock Take" onClose={() => setCreating(false)}>
          <div className="space-y-3">
            <Field label="Session Name">
              <input
                className="input"
                value={newName}
                placeholder="e.g. Gudang Sep 26 count"
                onChange={(e) => setNewName(e.target.value)}
              />
            </Field>
            <Field label="Count month (YYYY-MM)">
              <input className="input" value={newMonth} placeholder={todayISO().slice(0, 7)} onChange={(e) => setNewMonth(e.target.value)} />
            </Field>
            <Field label="Remarks">
              <input className="input" value={newRemarks} placeholder="e.g. Monthly warehouse count" onChange={(e) => setNewRemarks(e.target.value)} />
            </Field>
            <p className="text-xs text-slate-500">
              The session captures today's system closing qty per part as "System Qty". Counts are
              entered against it; posting applies variances to Inventory.
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="btn-primary" disabled={busy} onClick={create}>
                {busy ? "Creating…" : "Create Session"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Manage session modal */}
      {manageTarget && (
        <Modal title={`Manage — ${manageTarget.name || "(unnamed)"}`} onClose={() => setManageId(null)}>
          <div className="space-y-2 text-sm">
            <div className="grid grid-cols-2 gap-2 text-xs text-slate-400 mb-3">
              <div>Status: <b className="text-slate-200">{manageTarget.status}</b></div>
              <div>Month: <b className="text-slate-200">{monthLabel(manageTarget.month)}</b></div>
              <div>Lines: <b className="text-slate-200">{fmtQty(Object.keys(manageTarget.lines ?? {}).length)}</b></div>
              <div>Counted: <b className="text-slate-200">{fmtQty(Object.values(manageTarget.lines ?? {}).filter(isCounted).length)}</b></div>
            </div>
            <button
              className="btn-secondary w-full text-left"
              onClick={() => {
                setSelId(manageTarget.id);
                setManageId(null);
              }}
            >
              ▸ Open counting view
            </button>
            <button
              className="btn-secondary w-full text-left"
              onClick={() => {
                setEditMeta(manageTarget);
                setManageId(null);
              }}
            >
              ✎ Edit name / month / remarks
            </button>
            <button
              className="btn-secondary w-full text-left"
              disabled={busy}
              onClick={() => duplicateSession(manageTarget)}
            >
              ⧉ Duplicate session (re-count sheet)
            </button>
            {manageTarget.status === "CLOSED" && (
              <button
                className="btn-secondary w-full text-left"
                disabled={busy}
                onClick={async () => {
                  await dbSet(`stockTakes/${manageTarget.id}/status`, "OPEN");
                  await dbSet(`stockTakes/${manageTarget.id}/closedAt`, null);
                  setManageId(null);
                }}
              >
                ↺ Reopen session
              </button>
            )}
            {manageTarget.status === "OPEN" && (
              <button
                className="btn-secondary w-full text-left"
                disabled={busy}
                onClick={async () => {
                  await dbSet(`stockTakes/${manageTarget.id}/status`, "CLOSED");
                  await dbSet(`stockTakes/${manageTarget.id}/closedAt`, Date.now());
                  setManageId(null);
                }}
              >
                ⏹ Close session
              </button>
            )}
            <button
              className="btn-danger w-full text-left mt-3"
              disabled={busy}
              onClick={() => deleteSession(manageTarget)}
            >
              🗑 Delete session (Inventory untouched)
            </button>
          </div>
        </Modal>
      )}

      {/* Edit session metadata modal */}
      {editMeta && (
        <Modal title="Edit Session Details" onClose={() => setEditMeta(null)}>
          <div className="space-y-3">
            <Field label="Session Name">
              <input className="input" value={editMeta.name} onChange={(e) => setEditMeta({ ...editMeta, name: e.target.value })} />
            </Field>
            <Field label="Count month (YYYY-MM)">
              <input className="input" value={editMeta.month} onChange={(e) => setEditMeta({ ...editMeta, month: e.target.value })} />
            </Field>
            <Field label="Remarks">
              <input className="input" value={editMeta.remarks ?? ""} onChange={(e) => setEditMeta({ ...editMeta, remarks: e.target.value })} />
            </Field>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setEditMeta(null)}>
                Cancel
              </button>
              <button className="btn-primary" disabled={busy} onClick={saveMeta}>
                Save
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
