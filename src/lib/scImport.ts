import type {
  MasterItem,
  StockRecord,
  FGStockRecord,
  PurchaseOrderLine,
  ForecastLine,
  BomLine,
} from "../types";

/** Detect the snapshot month (YYYY-MM) from a supply-chain workbook filename
 * e.g. "SEP-26_MRP_PLAN_ALL Rev0.xlsx" -> "2026-09".
 * Supported patterns: "SEP-26", "SEPT 2026", "9. STOCK ... 2026", plain month+year. */
export function detectScMonth(filename: string): string {
  const up = filename.toUpperCase();
  const MONTHS: Record<string, number> = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
  };
  // "SEP-26" / "SEP26" style
  const short = /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[-\s]?(\d{2})\b/.exec(up);
  if (short) {
    const mon = MONTHS[short[1]];
    const yy = Number(short[2]);
    const year = yy < 50 ? 2000 + yy : 1900 + yy;
    return `${year}-${String(mon).padStart(2, "0")}`;
  }
  // "SEPT 2026" style
  const long = /\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s*,?\s*(\d{4})\b/.exec(up);
  if (long) {
    const map: Record<string, number> = {
      JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
      JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
    };
    return `${long[2]}-${String(map[long[1]]).padStart(2, "0")}`;
  }
  // leading "9." + year
  const m2 = /^(\d{1,2})\.\s/.exec(filename.trim());
  const y = up.match(/(20\d{2})/);
  if (m2 && y) {
    const mon = Number(m2[1]);
    if (mon >= 1 && mon <= 12) return `${y[1]}-${String(mon).padStart(2, "0")}`;
  }
  return new Date().toISOString().slice(0, 7);
}

export type WithId<T> = T & { id: string };

/** Records arrive from the realtime listener with an optional `id`; anything
 * without a key cannot be addressed for an in-place update. */
const hasId = <T extends { id?: string }>(r: T): r is WithId<T> =>
  typeof r.id === "string" && r.id.length > 0;

export interface ScMergeCounts {
  itemsUpdated: number;
  itemsAdded: number;
  stockUpdated: number;
  stockAdded: number;
  fgUpdated: number;
  fgAdded: number;
  poUpdated: number;
  poAdded: number;
  fcUpdated: number;
  fcAdded: number;
  bomUpdated: number;
  bomAdded: number;
}

export interface ScQueuedOps {
  itemUpdates: { id: string; rec: MasterItem }[];
  itemAdds: MasterItem[];
  stockUpdates: { id: string; rec: StockRecord }[];
  stockAdds: StockRecord[];
  stockRemoves: string[];
  fgUpdates: { id: string; rec: FGStockRecord }[];
  fgAdds: FGStockRecord[];
  poUpdates: { id: string; rec: PurchaseOrderLine }[];
  poAdds: PurchaseOrderLine[];
  fcUpdates: { id: string; rec: ForecastLine }[];
  fcAdds: ForecastLine[];
  bomKeyUpdates: { key: string; rec: BomLine }[];
  bomAdds: BomLine[];
  counts: ScMergeCounts;
}

export interface ScDbSnapshot {
  items: MasterItem[];
  rawStock: StockRecord[];
  fgStock: FGStockRecord[];
  poLines: PurchaseOrderLine[];
  forecasts: ForecastLine[];
  bom: BomLine[];
}

const keyOf = (...parts: (string | undefined)[]) =>
  parts.map((p) => (p ?? "").trim().toUpperCase()).join("::");

/**
 * Build month-aware merge operations for a supply-chain workbook.
 * - Items: upsert by pnaPartNo (prices/lead times refreshed, never duplicated)
 * - Raw stock: existing line for same part+month → update; else add
 * - FG stock: same by part+month
 * - PO lines: same part + same PO no + not yet received → update qty/ETA; else add
 * - Forecast: same part → merge monthly map; else add
 * - BOM: same component+harness+qty → skip; else add (BOM lines are additive)
 */
export function buildScMergeOps(
  db: ScDbSnapshot,
  parsed: {
    items: MasterItem[];
    rawStock: StockRecord[];
    fgStock: FGStockRecord[];
    poLines: PurchaseOrderLine[];
    forecasts: ForecastLine[];
    bom: BomLine[];
  }
): ScQueuedOps {
  const ops: ScQueuedOps = {
    itemUpdates: [], itemAdds: [],
    stockUpdates: [], stockAdds: [], stockRemoves: [],
    fgUpdates: [], fgAdds: [],
    poUpdates: [], poAdds: [],
    fcUpdates: [], fcAdds: [],
    bomKeyUpdates: [], bomAdds: [],
    counts: {
      itemsUpdated: 0, itemsAdded: 0,
      stockUpdated: 0, stockAdded: 0,
      fgUpdated: 0, fgAdded: 0,
      poUpdated: 0, poAdded: 0,
      fcUpdated: 0, fcAdded: 0,
      bomUpdated: 0, bomAdded: 0,
    },
  };

  // ---- items ----
  const itemById = new Map(db.items.map((i) => [i.pnaPartNo.trim().toUpperCase(), i]));
  for (const inc of parsed.items) {
    const prev = itemById.get(inc.pnaPartNo.trim().toUpperCase());
    if (prev && hasId(prev)) {
      ops.itemUpdates.push({ id: prev.id, rec: { ...inc } });
      ops.counts.itemsUpdated++;
    } else {
      ops.itemAdds.push(inc);
      ops.counts.itemsAdded++;
    }
  }

  // ---- raw stock ----
  // Stock lines are keyed by part no + month: re-importing the same month
  // replaces that month's lines (all old lines for that part+month removed,
  // new lines from the file added). Other months are untouched.
  const stockSeenMonths = new Set(parsed.rawStock.map((s) => s.month));
  const stockParsedParts = new Set(parsed.rawStock.map((s) => s.partNo.trim().toUpperCase()));
  for (const s of db.rawStock) {
    if (
      hasId(s) &&
      stockSeenMonths.has(s.month) &&
      stockParsedParts.has(s.partNo.trim().toUpperCase())
    ) {
      ops.stockRemoves.push(s.id);
    }
  }
  for (const rec of parsed.rawStock) {
    ops.stockAdds.push(rec);
    ops.counts.stockAdded++;
  }

  // ---- FG stock ----
  const fgByPartMonth = new Map<string, WithId<FGStockRecord>>();
  for (const f of db.fgStock) if (hasId(f)) fgByPartMonth.set(keyOf(f.partNo, f.month), f);
  for (const rec of parsed.fgStock) {
    const prev = fgByPartMonth.get(keyOf(rec.partNo, rec.month));
    if (prev) {
      ops.fgUpdates.push({ id: prev.id, rec });
      ops.counts.fgUpdated++;
    } else {
      ops.fgAdds.push(rec);
      ops.counts.fgAdded++;
    }
  }

  // ---- PO lines ----
  // same part + same PO no → refresh qty/ETA unless already RECEIVED/CANCELLED
  const poByPartNo = new Map<string, WithId<PurchaseOrderLine>[]>();
  for (const p of db.poLines) {
    if (!hasId(p)) continue;
    const k = keyOf(p.partNo, p.poNo);
    const arr = poByPartNo.get(k) ?? [];
    arr.push(p);
    poByPartNo.set(k, arr);
  }
  for (const rec of parsed.poLines) {
    const candidates = poByPartNo.get(keyOf(rec.partNo, rec.poNo)) ?? [];
    const open = candidates.find((c) => c.status !== "RECEIVED" && c.status !== "CANCELLED");
    if (open) {
      ops.poUpdates.push({ id: open.id, rec: { ...rec, status: open.status } });
      ops.counts.poUpdated++;
    } else {
      ops.poAdds.push(rec);
      ops.counts.poAdded++;
    }
  }

  // ---- forecast ----
  const fcByPart = new Map(
    db.forecasts.filter(hasId).map((f) => [f.partNo.trim().toUpperCase(), f])
  );
  for (const rec of parsed.forecasts) {
    const prev = fcByPart.get(rec.partNo.trim().toUpperCase());
    if (prev) {
      ops.fcUpdates.push({
        id: prev.id,
        rec: {
          ...rec,
          monthly: { ...prev.monthly, ...rec.monthly }, // newest file wins per month
        },
      });
      ops.counts.fcUpdated++;
    } else {
      ops.fcAdds.push(rec);
      ops.counts.fcAdded++;
    }
  }

  // ---- BOM ----
  const bomByKey = new Map(
    db.bom.filter(hasId).map((b) => [
      keyOf(b.componentPartNo, b.harnessPartNo),
      b,
    ])
  );
  for (const rec of parsed.bom) {
    const k = keyOf(rec.componentPartNo, rec.harnessPartNo);
    const prev = bomByKey.get(k);
    if (prev) {
      if (Math.abs(prev.qtyPerHarness - rec.qtyPerHarness) > 1e-9) {
        ops.bomKeyUpdates.push({ key: prev.id, rec });
        ops.counts.bomUpdated++;
      }
    } else {
      ops.bomAdds.push(rec);
      ops.counts.bomAdded++;
    }
  }

  return ops;
}
