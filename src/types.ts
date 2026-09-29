export type KeyOf = string;

export interface MasterItem {
  id?: string;
  pnaPartNo: string;
  supplierPartNo: string;
  description: string;
  category: string;
  supplier: string;
  shippingPoint: string;
  uom: string;
  whereUse: string;
  curr: string;
  price: number;
  moq: number;
  mpq: number;
  supplierLeadTimeWeeks: number;
  shipmentLeadTimeWeeks: number;
  totalLeadTimeWeeks: number;
  paymentTerm: string;
  remarks: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface Supplier {
  id?: string;
  name: string;
  shippingPoint: string;
  country: string;
  currency: string;
  paymentTerm: string;
  leadTimeWeeks: number;
  remarks: string;
}

export interface StockRecord {
  id?: string;
  partNo: string;
  supplierPartNo: string;
  description: string;
  supplier: string;
  model: string;
  uom: string;
  month: string; // YYYY-MM
  opening: number;
  receiving: number;
  issuance: number;
  closing: number;
  updatedAt?: number;
}

export interface FGStockRecord {
  id?: string;
  partNo: string;
  description: string;
  model: string;
  customer: string;
  month: string;
  opening: number;
  incoming: number;
  production: number;
  delivery: number;
  closing: number;
  updatedAt?: number;
}

export interface PurchaseOrderLine {
  id?: string;
  poNo: string;
  partNo: string;
  supplierPartNo: string;
  description: string;
  supplier: string;
  model: string;
  uom: string;
  qty: number;
  pnaRequestEtd: string; // ISO date
  etaPna: string;
  invoiceNo: string;
  blAwb: string;
  grnNo: string;
  shippingPoint: string;
  status: "DRAFT" | "CONFIRMED" | "SHIPPED" | "RECEIVED" | "CANCELLED";
  remarks: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ForecastLine {
  id?: string;
  partNo: string;
  partName: string;
  model: string;
  customer: string;
  sellingPrice: number;
  type: "FIRM" | "FORECAST";
  monthly: Record<string, number>; // YYYY-MM -> qty
  updatedAt?: number;
}

export interface BomLine {
  id?: string;
  componentPartNo: string;
  supplierPartNo: string;
  description: string;
  supplier: string;
  uom: string;
  harnessPartNo: string;
  qtyPerHarness: number;
}

export interface Settings {
  companyName: string;
  planMonth: string; // YYYY-MM
  monthlySeries: string[]; // YYYY-MM list used across MRP/forecast
  bufferWeeks: number;
  jpyRate: number;
  usdRate: number;
  horizonAutoRoll: boolean; // true = horizon computed as current month + horizonMonths
  horizonMonths: number; // length used by auto-roll
  /** Printed on requisition documents. Separate from companyName because the
   *  document carries the registered legal name, not the trading name. */
  companyLegalName?: string;
  companyRegNo?: string;
  companyAddress?: string;
  /** Form code printed bottom-right, e.g. "DMSB-PR". */
  prFooterCode?: string;
  /** Form code for exported material requests, e.g. "DMSB-MR". */
  mrFooterCode?: string;
  prLogoUrl?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  companyName: "PNA TECHNOLOGIES SDN BHD",
  planMonth: "2026-09",
  monthlySeries: [
    "2026-09",
    "2026-10",
    "2026-11",
    "2026-12",
    "2027-01",
    "2027-02",
    "2027-03",
    "2027-04",
    "2027-05",
    "2027-06",
  ],
  bufferWeeks: 1,
  jpyRate: 0.0251,
  usdRate: 4.0,
  horizonAutoRoll: true,
  horizonMonths: 12,
  companyLegalName: "PNA Technologies Bdn.Bhd.",
  companyRegNo: "626024-p",
  companyAddress:
    "Lot 4637, PT 3035, KAWASAN PERUSAHAAN KG GAJAH SIMPANG EMPAT, 36800 KAMPUNG GAJAH, PERAK DARUL RIDZUAN.",
  prFooterCode: "DMSB-PR",
  mrFooterCode: "DMSB-MR",
  prLogoUrl: "https://pnatech.com.my/pna%20logo.png",
};

/** Effective monthly horizon: auto-rolled from current month, or the stored fixed series. */
export function effectiveMonthlySeries(s: Settings | null): string[] {
  if (!s) return DEFAULT_SETTINGS.monthlySeries;
  if (s.horizonAutoRoll) {
    const n = Math.min(24, Math.max(1, Math.round(s.horizonMonths) || 12));
    const now = new Date();
    const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const [y, m] = start.split("-").map(Number);
    return Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.UTC(y, m - 1 + i, 1));
      return d.toISOString().slice(0, 7);
    });
  }
  const fixed = (s.monthlySeries ?? []).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
  return fixed.length ? fixed : DEFAULT_SETTINGS.monthlySeries;
}

export interface StockTakeLine {
  partNo: string;
  description: string;
  supplier: string;
  uom: string;
  systemQty: number;
  countedQty: number | null;
  remarks: string;
}

export interface StockTake {
  id?: string;
  name: string; // session name
  month: string; // YYYY-MM
  status: "OPEN" | "POSTED" | "CLOSED"; // POSTED = legacy; posting keeps sessions OPEN until manually closed
  createdAt: number;
  postedAt?: number;
  closedAt?: number;
  lines: Record<string, StockTakeLine>; // key = sanitized part no
  remarks?: string;
}

export const PR_STATUSES = ["DRAFT", "PENDING", "APPROVED", "ISSUED", "CANCELLED"] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

export const PR_CATEGORIES = ["oversea", "local"] as const;

export interface PurchaseRequisitionLine {
  partNo: string;
  partName: string;
  description: string;
  uom: string;
  unitPrice: number;
  qty: number;
  requiredDate: string; // YYYY-MM-DD
  purpose: string;
}

export interface PurchaseRequisition {
  id?: string;
  prNo: string; // PR/2026/08/194
  prDate: string; // YYYY-MM-DD
  category: string; // oversea | local
  requestedBy: string;
  department: string;
  currency: string; // JPY
  /** Rate into MYR. Absent/null prints as "N/A" and the MYR totals print as 0. */
  currencyRate?: number | null;
  /** Budget in the base currency, not MYR. */
  budgetAmount: number;
  recommendedSupplier: string;
  specialRequirement: string;
  status: PrStatus;
  lines: PurchaseRequisitionLine[];
  createdAt?: number;
  updatedAt?: number;
}

export interface MaintPart {
  id?: string;
  category: string; // MACHINE | APPLICATOR | POLE (IE) | BANDGUN (IE) | FACILITIES | PRINTFACILITIES | RAW MATERIAL (IE)
  no: string; // "No." column from the Excel sheet
  name: string;
  partNo: string;
  machineModel: string; // machine / model / usage context
  location: string;
  supplier: string;
  minStock: number;
  maxStock: number;
  currentStock: number;
  qtyToOrder: number;
  price: number;
  remarks: string;
  usage: Record<string, number>; // YYYY-MM -> qty used
  monthStock: Record<string, number>; // YYYY-MM -> stock snapshot at end of that month
  updatedAt?: number;
}

export interface MaintIssue {
  id?: string;
  partId: string;
  partNo: string;
  partName: string;
  category: string;
  type: "ISSUE" | "RECEIVE";
  qty: number;
  notes: string;
  createdAt: number;
}

export const PO_STATUSES: PurchaseOrderLine["status"][] = [
  "DRAFT",
  "CONFIRMED",
  "SHIPPED",
  "RECEIVED",
  "CANCELLED",
];

/** Daily production record for one line/machine.
 *
 * `source` distinguishes data that a PLC integration will eventually push from
 * what operators key in today, so the dashboard can show provenance and later
 * prefer (or ignore) machine-collected values. */
export type ProdSource = "MANUAL" | "PLC";

export interface ProdDaily {
  id?: string;
  date: string; // YYYY-MM-DD
  line: string; // line / machine code, e.g. "LINE-01"
  product: string;
  plannedQty: number; // target output for the shift/day
  totalOutput: number; // good units produced
  rejectQty: number; // rejected / scrap units
  // OEE components, each 0-100. OEE = availability x performance x quality.
  availabilityPct: number;
  performancePct: number;
  qualityPct: number; // fallback only; the IPQC workbook wins when one matches
  /** True when A and P were seeded at 100% and still need a real figure. */
  assumedAp?: boolean;
  downtimeMin: number;
  source: ProdSource;
  updatedAt?: number;
  updatedBy?: string;
}

/**
 * A standing plan figure for a family of machines, keyed on the Production page.
 * Matches machines by prefix against canonMachine(), so one group covers the
 * whole "AC90-1".."AC90-8" family without listing every code.
 */
export interface ProdPlanGroup {
  id?: string;
  label: string;
  /** Case-insensitive prefix matched against canonMachine(machine). */
  match: string;
  plannedQty: number;
  /**
   * true  -> plannedQty is the plan for EACH machine in the group.
   * false -> plannedQty is the plan for the WHOLE group, divided by the number
   *          of distinct machines the group covers in the selected range.
   */
  perMachine: boolean;
  order?: number;
  updatedAt?: number;
}

export const MR_STATUSES = [
  "DRAFT",
  "PENDING",
  "APPROVED",
  "ISSUED",
  "REJECTED",
  "CANCELLED",
] as const;

export type MrStatus = (typeof MR_STATUSES)[number];

export const MR_PRIORITIES = ["NORMAL", "URGENT"] as const;

export type MrPriority = (typeof MR_PRIORITIES)[number];

/** An internal material request: a department asking the warehouse to issue
 *  materials it already owns. Distinct from a Purchase Order, which is raised
 *  against a supplier. */
export interface MaterialRequest {
  id?: string;
  mrNo: string; // e.g. "MR-2026-001"
  reqDate: string; // YYYY-MM-DD
  department: string; // requesting department / line
  requestedBy: string; // person raising the request
  partNo: string;
  description: string;
  uom: string;
  qty: number; // quantity requested
  neededBy: string; // YYYY-MM-DD
  purpose: string; // what it is for
  priority: MrPriority;
  status: MrStatus;
  /** Warehouse snapshot at the time of the request, kept so a later import
   *  cannot silently change the balance a request was approved against. */
  stockAtRequest?: number;
  approvedBy?: string;
  approvedAt?: number;
  remarks: string;
  createdAt?: number;
  updatedAt?: number;
}

export const MAINT_DEFECT_TYPES = [
  "Mekanikal",
  "Elektrikal",
  "IT / Komputer",
  "Kebersihan",
  "Lain-lain",
] as const;

/** Status values kept identical to the legacy `penyelenggaraan` MySQL table so
 * existing rows and any external reporting line up. */
export const MAINT_REQUEST_STATUSES = [
  "baru",
  "sedang_diproses",
  "selesai",
  "dibatalkan",
] as const;

export type MaintRequestStatus = (typeof MAINT_REQUEST_STATUSES)[number];

export const MAINT_STATUS_LABELS: Record<MaintRequestStatus, string> = {
  baru: "Baru",
  sedang_diproses: "Sedang Diproses",
  selesai: "Selesai",
  dibatalkan: "Dibatalkan",
};

/** A "Borang Penyelenggaraan" report, mirroring the legacy PHP form
 * (index.html + submit.php + view_requests.php) and its `penyelenggaraan`
 * table columns, now stored in Firebase Realtime Database. */
export interface MaintRequest {
  id?: string;
  nama: string; // Nama Pemohon
  lokasi: string;
  tarikh: string; // YYYY-MM-DD (defaults to the defect date, else today)
  masa_dikesan?: string; // datetime-local value
  jenis_kerosakkan: string; // "" when not chosen
  kerosakkan: string;
  gambar?: string; // uploaded filename, as stored in the legacy uploads/ folder
  gambar_url?: string; // absolute URL, set by the Firebase sync script
  status: MaintRequestStatus;
  /** MySQL DATETIME strings ("YYYY-MM-DD HH:MM:SS") or epoch millis. */
  completed_at?: number | string;
  completed_by?: string;
  created_at?: number | string;
  updated_at?: number | string;
}
