/** Display helpers for the Borang Penyelenggaraan submissions mirrored from the
 * standalone PHP form (index.html + submit.php + view_requests.php). */

import { MAINT_DEFECT_TYPES, MAINT_STATUS_LABELS, type MaintRequest } from "../types";

export { MAINT_DEFECT_TYPES, MAINT_STATUS_LABELS };

/** Base of the legacy form installation on cPanel. Uploaded photos stay in its
 * public uploads/ folder, so the ERP links to them instead of duplicating
 * megabytes of image data into Firebase. */
export const SUBMIT_BASE = "https://pnatech.com.my/maintenance/form_aduan/";
export const SUBMIT_URL = `${SUBMIT_BASE}index.html`;

export function photoUrl(r: MaintRequest): string | null {
  if (r.gambar_url) return r.gambar_url;
  if (r.gambar) return `${SUBMIT_BASE}uploads/${encodeURIComponent(r.gambar)}`;
  return null;
}

export function statusTone(s: MaintRequest["status"]) {
  switch (s) {
    case "baru":
      return "info" as const;
    case "sedang_diproses":
      return "warn" as const;
    case "selesai":
      return "ok" as const;
    default:
      return "danger" as const;
  }
}

export function statusLabel(s: MaintRequest["status"]): string {
  return MAINT_STATUS_LABELS[s] ?? s;
}

/** MySQL DATETIME strings ("2026-02-27 14:51:28") arrive from the sync script as
 * text, while anything written from the app is epoch millis. Normalise both. */
export function toMs(v?: number | string | null): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim());
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0).getTime();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function fmtDateTime(iso?: string): string {
  const ms = toMs(iso);
  if (ms === null) return "-";
  return new Date(ms).toLocaleString("ms-MY", { dateStyle: "medium", timeStyle: "short" });
}

export function fmtTimestamp(v?: number | string | null): string {
  const ms = toMs(v);
  if (ms === null) return "-";
  return new Date(ms).toLocaleString("ms-MY", { dateStyle: "medium", timeStyle: "short" });
}

/** Build the "Status Baru (Completed On: … | Completed By: …)" cell the PHP
 * export produced, so downloaded reports keep the same wording. */
export function statusCell(r: MaintRequest): string {
  const base = statusLabel(r.status);
  if (r.status !== "selesai") return base;
  const bits: string[] = [];
  if (r.completed_at) bits.push(`Completed On: ${fmtTimestamp(r.completed_at)}`);
  if (r.completed_by) bits.push(`Completed By: ${r.completed_by}`);
  return bits.length ? `${base} (${bits.join(" | ")})` : base;
}
