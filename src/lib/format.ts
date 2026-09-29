export function fmtQty(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

export function fmtNum(n: number | null | undefined, dp = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  }).format(n);
}

export function fmtMoney(n: number | null | undefined, curr = ""): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  const s = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  return curr ? `${curr} ${s}` : s;
}

export function monthLabel(ym: string): string {
  // "2026-09" -> "Sep 26"
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

export function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

export function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

export function excelDateToISO(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") {
    // Excel serial date (days since 1899-12-30)
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }
  if (typeof v === "string") {
    const parsed = new Date(v);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return v;
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}
