import type {
  MasterItem,
  StockRecord,
  PurchaseOrderLine,
  ForecastLine,
  BomLine,
  FGStockRecord,
  Settings,
} from "../types";
import { deriveCategory } from "./category";

export interface MrpRow {
  partNo: string;
  supplierPartNo: string;
  description: string;
  category: string;
  supplier: string;
  model: string;
  uom: string;
  stock: number;
  incoming: number; // open PO qty (not yet received)
  demandByMonth: Record<string, number>;
  supplyByMonth: Record<string, number>;
  projectedByMonth: Record<string, number>;
  shortageMonth: string | null; // first month projection < 0
  totalDemand: number;
  totalSupply: number;
  totalForecast: number;
  bufferQty: number;
  shortageTotal: number; // max deficit vs (demand + buffer)
  stockDays: number | null; // inventory days by warehouse qty
  dailyUsage: number;
  leadTimeWeeks: number;
  moq: number;
  mpq: number;
  price: number;
  curr: string;
  planToOrder: number;
  onShip: boolean;
}

export interface MrpInput {
  items: MasterItem[];
  rawStock: StockRecord[];
  poLines: PurchaseOrderLine[];
  forecasts: ForecastLine[];
  bom: BomLine[];
  fgStock: FGStockRecord[];
  settings: Settings;
}

/**
 * Component monthly demand = BOM qty x harness monthly forecast (exploded).
 * Harness (FG) demand = forecast directly.
 * Supply = closing stock + open PO scheduled by ETA month.
 */
export function computeMrp(input: MrpInput): MrpRow[] {
  const { items, rawStock, poLines, forecasts, bom, fgStock, settings } = input;
  const months = settings.monthlySeries;
  if (months.length === 0) return [];

  const itemByPart = new Map<string, MasterItem>();
  for (const it of items) itemByPart.set(it.pnaPartNo, it);

  const stockByPart = new Map<string, number>();
  for (const s of rawStock) {
    stockByPart.set(s.partNo, (stockByPart.get(s.partNo) ?? 0) + s.closing);
  }
  const fgByPart = new Map<string, number>();
  for (const f of fgStock) {
    fgByPart.set(f.partNo, (fgByPart.get(f.partNo) ?? 0) + f.closing);
  }

  // forecast by harness by month
  const fcByHarness = new Map<string, Record<string, number>>();
  for (const f of forecasts) {
    const agg = fcByHarness.get(f.partNo) ?? {};
    for (const [ym, q] of Object.entries(f.monthly)) {
      agg[ym] = (agg[ym] ?? 0) + q;
    }
    fcByHarness.set(f.partNo, agg);
  }

  // explode BOM: component demand per month
  const compDemand = new Map<string, Record<string, number>>();
  for (const b of bom) {
    const fc = fcByHarness.get(b.harnessPartNo);
    if (!fc) continue;
    const agg = compDemand.get(b.componentPartNo) ?? {};
    for (const ym of months) {
      const q = (fc[ym] ?? 0) * b.qtyPerHarness;
      if (q !== 0) agg[ym] = (agg[ym] ?? 0) + q;
    }
    compDemand.set(b.componentPartNo, agg);
  }

  // open PO incoming by part by ETA month (excludes CANCELLED / RECEIVED)
  const incomingByPart = new Map<string, Record<string, number>>();
  const incomingTotal = new Map<string, number>();
  for (const po of poLines) {
    if (po.status === "CANCELLED" || po.status === "RECEIVED") continue;
    const ym = (po.etaPna || "").slice(0, 7) || months[0];
    const agg = incomingByPart.get(po.partNo) ?? {};
    agg[ym] = (agg[ym] ?? 0) + po.qty;
    incomingByPart.set(po.partNo, agg);
    incomingTotal.set(po.partNo, (incomingTotal.get(po.partNo) ?? 0) + po.qty);
  }

  const rows: MrpRow[] = [];
  const seenParts = new Set<string>();
  const allParts: { partNo: string; kind: "component" | "harness" }[] = [];

  for (const it of items) {
    const kind = compDemand.has(it.pnaPartNo) ? "component" : "harness";
    allParts.push({ partNo: it.pnaPartNo, kind });
    seenParts.add(it.pnaPartNo);
  }
  // include parts present in stock/PO but missing from master
  for (const p of stockByPart.keys())
    if (!seenParts.has(p)) {
      allParts.push({ partNo: p, kind: "component" });
      seenParts.add(p);
    }
  for (const p of incomingTotal.keys())
    if (!seenParts.has(p)) {
      allParts.push({ partNo: p, kind: "component" });
      seenParts.add(p);
    }

  for (const { partNo, kind } of allParts) {
    const item = itemByPart.get(partNo);
    const demandAgg =
      kind === "component"
        ? compDemand.get(partNo)
        : fcByHarness.get(partNo);
    const hasData =
      demandAgg ||
      stockByPart.has(partNo) ||
      fgByPart.has(partNo) ||
      incomingTotal.has(partNo);
    if (!hasData) continue;

    const stock = stockByPart.get(partNo) ?? fgByPart.get(partNo) ?? 0;
    const incomingAgg = incomingByPart.get(partNo) ?? {};

    // projected balance: start from stock, add supply (stock once + incoming per month), subtract demand
    const demandByMonth: Record<string, number> = {};
    const supplyByMonth: Record<string, number> = {};
    const projectedByMonth: Record<string, number> = {};

    let balance = stock;
    let shortageMonth: string | null = null;
    let totalDemand = 0;
    let totalSupply = 0;
    let totalForecast = 0;

    const dailyUsage =
      months.length > 0
        ? (demandAgg?.[months[0]] ?? 0) / 26
        : 0;

    for (const ym of months) {
      const dem = demandAgg?.[ym] ?? 0;
      const sup = incomingAgg[ym] ?? 0;
      balance = balance + sup - dem;
      demandByMonth[ym] = dem;
      supplyByMonth[ym] = sup;
      projectedByMonth[ym] = balance;
      totalDemand += dem;
      totalSupply += sup;
      totalForecast += dem;
      if (balance < 0 && !shortageMonth) shortageMonth = ym;
    }

    const bufferWeeks = settings.bufferWeeks ?? 1;
    const bufferQty = dailyUsage * 6 * bufferWeeks;
    // total needed to cover demand + buffer, net of stock and incoming
    const requiredTotal = totalDemand + bufferQty;
    const shortageTotal = Math.max(0, requiredTotal - stock - totalSupply);
    const planToOrder = moqRoundUp(shortageTotal, item?.moq ?? 0);
    const stockDays =
      dailyUsage > 0 ? Math.floor(stock / dailyUsage) : null;

    rows.push({
      partNo,
      supplierPartNo: item?.supplierPartNo ?? "",
      description: item?.description ?? "",
      category: item?.category || deriveCategory(item?.description ?? ""),
      supplier: item?.supplier ?? "",
      model: item?.whereUse ?? "",
      uom: item?.uom ?? "",
      stock,
      incoming: incomingTotal.get(partNo) ?? 0,
      demandByMonth,
      supplyByMonth,
      projectedByMonth,
      shortageMonth,
      totalDemand,
      totalSupply,
      totalForecast,
      bufferQty,
      shortageTotal,
      stockDays,
      dailyUsage,
      leadTimeWeeks: item?.totalLeadTimeWeeks ?? 0,
      moq: item?.moq ?? 0,
      mpq: item?.mpq ?? 0,
      price: item?.price ?? 0,
      curr: item?.curr ?? "",
      planToOrder,
      onShip: totalSupply > 0,
    });
  }

  // shortage rows first (most urgent), then by part no
  rows.sort((a, b) => {
    const ai = a.shortageMonth ? months.indexOf(a.shortageMonth) : 999;
    const bi = b.shortageMonth ? months.indexOf(b.shortageMonth) : 999;
    if (ai !== bi) return ai - bi;
    if (a.shortageTotal !== b.shortageTotal)
      return b.shortageTotal - a.shortageTotal;
    return a.partNo.localeCompare(b.partNo);
  });

  return rows;
}

function moqRoundUp(qty: number, moq: number): number {
  if (qty <= 0) return 0;
  if (!moq || moq <= 0) return Math.ceil(qty);
  return Math.ceil(qty / moq) * moq;
}
