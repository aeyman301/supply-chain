import { useMemo, useState } from "react";
import { Badge, Card, DataTable, Modal, SearchBox, Stat, type Column } from "../components/ui";
import { fmtQty } from "../lib/format";
import {
  MAINT_REQUEST_STATUSES,
  MAINT_STATUS_LABELS,
  type MaintRequest,
} from "../types";
import { fmtDateTime, fmtTimestamp, photoUrl, statusCell, statusLabel, statusTone, SUBMIT_URL, toMs } from "../lib/maintForm";
import { useDb } from "../db-context";

const STATUS_FILTERS = ["SEMUA", ...MAINT_REQUEST_STATUSES] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** Reproduces view_requests.php?export=excel: a summary block, then the detail
 * rows, as a single .xls (HTML table) file. */
function exportExcel(rows: MaintRequest[], all: MaintRequest[]) {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

  const esc = (s: unknown) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");

  const byStatus = MAINT_REQUEST_STATUSES.map((s) => ({
    s,
    n: all.filter((r) => r.status === s).length,
  }));

  const summaryRows = [
    `<tr><td>Dijana Pada</td><td>${esc(fmtTimestamp(now.getTime()))}</td></tr>`,
    `<tr><td>Jumlah Rekod</td><td>${all.length}</td></tr>`,
    ...byStatus.map((x) => `<tr><td>Status ${esc(MAINT_STATUS_LABELS[x.s])}</td><td>${x.n}</td></tr>`),
    `<tr><td>Selesai</td><td>${all.filter((r) => r.status === "selesai").length}</td></tr>`,
  ].join("");

  const head = ["ID", "Nama", "Lokasi", "Tarikh", "Kerosakkan", "Gambar", "Status Semasa"];
  const detail = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.id ?? "")}</td><td>${esc(r.nama)}</td><td>${esc(r.lokasi)}</td>` +
        `<td>${esc(r.tarikh)}</td><td>${esc(r.kerosakkan)}</td>` +
        `<td>${r.gambar ? "Ada" : "Tiada"}</td><td>${esc(statusCell(r))}</td></tr>`
    )
    .join("");

  const html =
    `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body>` +
    `<table border="1"><tr><th colspan="2">Laporan Penyelenggaraan</th></tr>${summaryRows}</table><br/>` +
    `<table border="1"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>` +
    `<tbody>${detail || `<tr><td colspan="7">Tiada rekod dijumpai.</td></tr>`}</tbody></table>` +
    `</body></html>`;

  const blob = new Blob(["\uFEFF" + html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `penyelenggaraan_${stamp}.xls`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Read-only mirror of the submissions made through the standalone PHP form at
 * /maintenance/form_aduan/. The form itself lives on cPanel and writes to
 * MySQL; a cPanel cron job (sync_maint_firebase.php) mirrors those rows into
 * the `maintRequests` Firebase node that this page reads.
 */
export default function MaintFormList() {
  const db = useDb();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("SEMUA");
  const [view, setView] = useState<MaintRequest | null>(null);

  // view_requests.php: ORDER BY tarikh DESC, created_at DESC
  const all = useMemo(
    () =>
      [...db.maintRequests].sort(
        (a, b) =>
          (b.tarikh ?? "").localeCompare(a.tarikh ?? "") ||
          (toMs(b.created_at) ?? 0) - (toMs(a.created_at) ?? 0)
      ),
    [db.maintRequests]
  );

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return all
      .filter((r) => (status === "SEMUA" ? true : r.status === status))
      .filter((r) =>
        term
          ? [r.id, r.nama, r.lokasi, r.kerosakkan, r.jenis_kerosakkan]
              .filter(Boolean)
              .some((v) => String(v).toLowerCase().includes(term))
          : true
      );
  }, [all, q, status]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { SEMUA: all.length };
    for (const s of MAINT_REQUEST_STATUSES) c[s] = all.filter((r) => r.status === s).length;
    return c;
  }, [all]);

  const columns: Column<MaintRequest>[] = [
    {
      key: "id",
      header: "ID",
      value: (r) => r.id ?? "",
      render: (r) => <span className="font-mono text-xs text-slate-400">{r.id ?? "-"}</span>,
    },
    { key: "nama", header: "Nama", value: (r) => r.nama },
    {
      key: "lokasi",
      header: "Lokasi",
      value: (r) => r.lokasi,
      render: (r) => <span className="block max-w-48 truncate">{r.lokasi}</span>,
    },
    { key: "tarikh", header: "Tarikh", value: (r) => r.tarikh },
    {
      key: "kerosakkan",
      header: "Kerosakkan",
      value: (r) => r.kerosakkan,
      render: (r) => (
        <span className="block max-w-72 truncate" title={r.kerosakkan}>
          {r.kerosakkan}
        </span>
      ),
    },
    {
      key: "gambar",
      header: "Gambar",
      value: (r) => (r.gambar ? "Ada" : "Tiada"),
      render: (r) => {
        const url = photoUrl(r);
        return url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-sky-400 hover:underline text-xs"
          >
            Lihat Gambar
          </a>
        ) : (
          <span className="text-slate-500 text-xs">Tiada</span>
        );
      },
    },
    {
      key: "status",
      header: "Status Semasa",
      value: (r) => statusCell(r),
      render: (r) => (
        <div>
          <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
          {r.status === "selesai" && (r.completed_at || r.completed_by) && (
            <div className="text-[11px] text-slate-500 mt-1 leading-tight">
              {r.completed_at && <div>Completed On: {fmtTimestamp(r.completed_at)}</div>}
              {r.completed_by && <div>Completed By: {r.completed_by}</div>}
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="page-toolbar">
        <div>
          <h1 className="text-xl font-bold">Maintenance Form</h1>
          <p className="text-sm text-slate-500">
            Laporan dihantar melalui borang{" "}
            <a href={SUBMIT_URL} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
              /maintenance/form_aduan/
            </a>{" "}
            — paparan sahaja
          </p>
        </div>
        <button
          className="btn-secondary"
          disabled={all.length === 0}
          onClick={() => exportExcel(rows, all)}
          title="Export the Excel report (all statuses counted, current filter applied)"
        >
          ⇩ Export Excel
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="Jumlah" value={fmtQty(counts.SEMUA ?? 0)} />
        <Stat label="Baru" value={fmtQty(counts.baru ?? 0)} />
        <Stat label="Sedang Diproses" value={fmtQty(counts.sedang_diproses ?? 0)} tone="warn" />
        <Stat label="Selesai" value={fmtQty(counts.selesai ?? 0)} tone="ok" />
        <Stat label="Dibatalkan" value={fmtQty(counts.dibatalkan ?? 0)} tone="danger" />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <SearchBox value={q} onChange={setQ} placeholder="Cari nama, lokasi, kerosakkan…" />
          <select
            className="input max-w-56"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === "SEMUA" ? "Semua status" : MAINT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <span className="text-xs text-slate-500 ml-auto">{fmtQty(rows.length)} rekod</span>
        </div>

        <DataTable
          columns={columns}
          rows={rows}
          onRowClick={setView}
          emptyText="Tiada rekod dijumpai."
          dense
        />
      </Card>

      {view && (
        <Modal title={`Rekod ${view.id ?? ""}`} onClose={() => setView(null)}>
          <div className="space-y-3 text-sm">
            <Row label="Nama" value={view.nama} />
            <Row label="Lokasi" value={view.lokasi} />
            <Row label="Tarikh" value={view.tarikh} />
            <Row label="Tarikh & Masa Dikesan" value={fmtDateTime(view.masa_dikesan)} />
            <Row label="Jenis Kerosakkan" value={view.jenis_kerosakkan || "-"} />
            <div>
              <div className="text-xs text-slate-500">Kerosakkan</div>
              <div className="whitespace-pre-wrap text-slate-200">{view.kerosakkan || "-"}</div>
            </div>
            <Row
              label="Status Semasa"
              value={<Badge tone={statusTone(view.status)}>{statusLabel(view.status)}</Badge>}
            />
            {view.completed_at && <Row label="Completed On" value={fmtTimestamp(view.completed_at)} />}
            {view.completed_by && <Row label="Completed By" value={view.completed_by} />}
            {photoUrl(view) && (
              <div>
                <div className="text-xs text-slate-500 mb-1">Gambar</div>
                <a href={photoUrl(view)!} target="_blank" rel="noreferrer" className="inline-block">
                  <img
                    src={photoUrl(view)!}
                    alt="Gambar laporan"
                    className="max-h-72 rounded border border-slate-700 object-contain"
                  />
                </a>
              </div>
            )}
            <div className="text-xs text-slate-500 pt-2">
              Rekod ini disalin daripada MySQL oleh cron sinkronisasi. Untuk mengubah status,
              gunakan{" "}
              <a href={SUBMIT_URL} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                view_requests.php
              </a>
              .
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="text-xs text-slate-500 w-40 shrink-0">{label}</div>
      <div className="text-slate-200 min-w-0 break-words">{value}</div>
    </div>
  );
}
