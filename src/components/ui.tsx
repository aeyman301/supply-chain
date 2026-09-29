import React, { useState } from "react";
import { fmtQty } from "../lib/format";

export function Card({
  title,
  right,
  children,
  className = "",
}: {
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between mb-3">
          {title && <h3 className="font-semibold text-sm text-slate-300">{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "danger" | "warn" | "ok";
}) {
  const toneCls =
    tone === "danger"
      ? "text-rose-400"
      : tone === "warn"
        ? "text-amber-400"
        : tone === "ok"
          ? "text-emerald-400"
          : "";
  return (
    <div className="card">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${toneCls}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  value?: (row: T) => string | number;
  align?: "left" | "right" | "center";
  width?: string;
  className?: (row: T) => string;
}

export function DataTable<T>({
  columns,
  rows,
  onRowClick,
  pageSize = 50,
  emptyText = "No data",
  dense = false,
}: {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  pageSize?: number;
  emptyText?: string;
  dense?: boolean;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const slice = rows.slice(safePage * pageSize, (safePage + 1) * pageSize);

  if (rows.length === 0)
    return <div className="text-sm text-slate-500 py-8 text-center">{emptyText}</div>;

  return (
    <div>
      <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="text-left text-xs uppercase text-slate-500 border-b border-slate-800">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`py-2 px-2 font-medium whitespace-nowrap ${
                    c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""
                  } ${c.width ? "" : ""}`}
                  style={c.width ? { width: c.width } : undefined}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((row, i) => (
              <tr
                key={(row as { id?: string }).id ?? i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-b border-slate-800/60 hover:bg-slate-800/40 transition-colors ${
                  onRowClick ? "cursor-pointer" : ""
                }`}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`${dense ? "py-1 px-2" : "py-2 px-2"} whitespace-nowrap ${
                      c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""
                    } ${c.className ? c.className(row) : ""}`}
                  >
                    {c.render ? c.render(row) : String(c.value ? c.value(row) : "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs text-slate-500">
          <span>
            {fmtQty(rows.length)} rows · page {safePage + 1} / {pages}
          </span>
          <div className="flex gap-1">
            <button
              className="btn-secondary !py-1 !px-2"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            >
              Prev
            </button>
            <button
              className="btn-secondary !py-1 !px-2"
              disabled={safePage >= pages - 1}
              onClick={() => setPage(safePage + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`card w-full ${wide ? "sm:max-w-4xl" : "sm:max-w-lg"} max-h-[92vh] overflow-y-auto rounded-b-none sm:rounded-lg`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4 sticky -top-4 bg-slate-900 pt-1 -mt-1 pb-1">
          <h3 className="font-semibold">{title}</h3>
          <button className="text-slate-400 hover:text-white text-2xl leading-none px-1" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400 block mb-1">{label}</span>
      {children}
    </label>
  );
}

export function Badge({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "danger" | "warn" | "ok" | "info";
}) {
  const map = {
    default: "bg-slate-700 text-slate-200",
    danger: "bg-rose-900/50 text-rose-300",
    warn: "bg-amber-900/50 text-amber-300",
    ok: "bg-emerald-900/50 text-emerald-300",
    info: "bg-sky-900/50 text-sky-300",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${map[tone]}`}>
      {children}
    </span>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="input max-w-xs"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function exportCsv<T>(filename: string, rows: T[], columns: Column<T>[]) {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const header = columns.map((c) => esc(c.header)).join(",");
  const lines = rows.map((r: T) =>
    columns
      .map((c) => {
        const v = c.value ? c.value(r) : "";
        return esc(String(v ?? ""));
      })
      .join(",")
  );
  const blob = new Blob(["\uFEFF" + header + "\n" + lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
