import * as XLSX from "xlsx";
import type {
  MasterItem,
  PurchaseOrderLine,
  StockRecord,
  FGStockRecord,
  ForecastLine,
  BomLine,
} from "../types";
import { num, str, excelDateToISO, monthEnd } from "./format";
import { deriveCategory } from "./category";

export interface ParseResult {
  items: MasterItem[];
  suppliers: string[];
  rawStock: StockRecord[];
  fgStock: FGStockRecord[];
  poLines: PurchaseOrderLine[];
  forecasts: ForecastLine[];
  bom: BomLine[];
  planMonth: string;
  monthlySeries: string[];
  warnings: string[];
}

function cell(row: unknown[], idx: number) {
  return idx < row.length ? row[idx] : undefined;
}

export async function parseWorkbook(file: File): Promise<ParseResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { cellDates: true });

  const warnings: string[] = [];
  const result: ParseResult = {
    items: [],
    suppliers: [],
    rawStock: [],
    fgStock: [],
    poLines: [],
    forecasts: [],
    bom: [],
    planMonth: "",
    monthlySeries: [],
    warnings,
  };

  parseMasterList(wb, result);
  parseRawStock(wb, result);
  parseFGStock(wb, result);
  parseOpenPO(wb, result);
  parseForecast(wb, result);
  parseBOM(wb, result);

  // Deduplicate suppliers from master
  const supSet = new Map<string, { point: string }>();
  for (const it of result.items) {
    if (!it.supplier) continue;
    const existing = supSet.get(it.supplier);
    if (existing) {
      if (!existing.point && it.shippingPoint) existing.point = it.shippingPoint;
    } else {
      supSet.set(it.supplier, { point: it.shippingPoint });
    }
  }
  result.suppliers = [...supSet.keys()].sort();

  if (result.items.length === 0)
    warnings.push("No items parsed from 'MASTER LIST' sheet.");
  return result;
}

function parseMasterList(wb: XLSX.WorkBook, r: ParseResult) {
  const ws = wb.Sheets["MASTER LIST"];
  if (!ws) {
    r.warnings.push("Sheet 'MASTER LIST' not found.");
    return;
  }
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  // header at index 1 (row 2): No | PNA Part No | Supplier Part No | Description | Supplier | Shipping Point | UoM | Where Use | Curr | Price | MOQ | MPQ | Supplier LT | Shipment LT | Total LT | Payment Term | Remarks
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    const pna = str(cell(row, 1));
    if (!pna) continue;
    const supLt = num(cell(row, 12));
    const shipLt = num(cell(row, 13));
    r.items.push({
      pnaPartNo: pna,
      supplierPartNo: str(cell(row, 2)),
      description: str(cell(row, 3)),
      category: deriveCategory(str(cell(row, 3))),
      supplier: str(cell(row, 4)),
      shippingPoint: str(cell(row, 5)),
      uom: str(cell(row, 6)),
      whereUse: str(cell(row, 7)),
      curr: str(cell(row, 8)) || "RM",
      price: num(cell(row, 9)),
      moq: num(cell(row, 10)),
      mpq: num(cell(row, 11)),
      supplierLeadTimeWeeks: supLt,
      shipmentLeadTimeWeeks: shipLt,
      totalLeadTimeWeeks: num(cell(row, 14)) || supLt + shipLt,
      paymentTerm: str(cell(row, 15)),
      remarks: str(cell(row, 16)),
      createdAt: Date.now(),
    });
  }
}

function parseRawStock(wb: XLSX.WorkBook, r: ParseResult) {
  const ws = wb.Sheets["1. Raw Stock - Warehouse"];
  if (!ws) {
    r.warnings.push("Sheet '1. Raw Stock - Warehouse' not found.");
    return;
  }
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  // plan month at row 4 col 1
  const pm = excelDateToISO(cell(rows[3], 1));
  if (/^\d{4}-\d{2}/.test(pm)) r.planMonth = pm.slice(0, 7);
  // data rows start at row 7 (index 6); use master-UOM closing (col 20) plus BOM-UOM opening (col 7)
  for (let i = 6; i < rows.length; i++) {
    const row = rows[i];
    const partNo = str(cell(row, 1));
    if (!partNo) continue;
    const opening = num(cell(row, 16));
    const receiving = num(cell(row, 17));
    const issuance = num(cell(row, 18));
    const closing = num(cell(row, 20));
    if (opening === 0 && receiving === 0 && issuance === 0 && closing === 0) continue;
    r.rawStock.push({
      partNo,
      supplierPartNo: str(cell(row, 2)),
      description: str(cell(row, 3)),
      supplier: str(cell(row, 4)),
      model: str(cell(row, 5)),
      uom: str(cell(row, 15)) || str(cell(row, 6)),
      month: r.planMonth,
      opening,
      receiving,
      issuance,
      closing,
      updatedAt: Date.now(),
    });
  }
}

function parseFGStock(wb: XLSX.WorkBook, r: ParseResult) {
  const ws = wb.Sheets["2. FG Stock - PPC"];
  if (!ws) {
    r.warnings.push("Sheet '2. FG Stock - PPC' not found.");
    return;
  }
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const pm = excelDateToISO(cell(rows[3], 1));
  const month = /^\d{4}-\d{2}/.test(pm) ? pm.slice(0, 7) : r.planMonth;
  // header row 6 (index 5); data from index 6
  for (let i = 6; i < rows.length; i++) {
    const row = rows[i];
    const partNo = str(cell(row, 1));
    if (!partNo) continue;
    r.fgStock.push({
      partNo,
      description: str(cell(row, 2)),
      model: str(cell(row, 3)),
      customer: str(cell(row, 4)),
      month,
      opening: num(cell(row, 5)),
      incoming: num(cell(row, 6)),
      production: num(cell(row, 7)),
      delivery: num(cell(row, 8)),
      closing: num(cell(row, 10)),
      updatedAt: Date.now(),
    });
  }
}

function parseOpenPO(wb: XLSX.WorkBook, r: ParseResult) {
  const ws = wb.Sheets["OPEN PO ALL"];
  if (!ws) {
    r.warnings.push("Sheet 'OPEN PO ALL' not found.");
    return;
  }
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  // header at index 2 (row 3). Schedule columns 19..27 are month-end dates; qty under each.
  // find schedule month columns from header row
  const schedCols: { col: number; ym: string }[] = [];
  const header = rows[2] ?? [];
  for (let c = 19; c < Math.min(header.length, 40); c++) {
    const iso = excelDateToISO(header[c]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      schedCols.push({ col: c, ym: iso.slice(0, 7) });
    }
  }
  for (let i = 3; i < rows.length; i++) {
    const row = rows[i];
    const partNo = str(cell(row, 1));
    if (!partNo) continue;
    // qty: sum of scheduled amounts; eta from earliest month with qty, or ETA col 17
    let totalQty = 0;
    let firstYm = "";
    for (const sc of schedCols) {
      const q = num(cell(row, sc.col));
      if (q > 0) {
        totalQty += q;
        if (!firstYm) firstYm = sc.ym;
      }
    }
    const eta = excelDateToISO(cell(row, 17));
    const etd = excelDateToISO(cell(row, 12));
    const etaFinal = /^\d{4}-\d{2}-\d{2}$/.test(eta)
      ? eta
      : firstYm
        ? monthEnd(firstYm)
        : "";
    // skip completely empty logistics rows with zero qty and no dates
    if (totalQty === 0 && !etaFinal && !str(cell(row, 11))) continue;
    r.poLines.push({
      poNo: str(cell(row, 11)) || "OPEN-PO",
      partNo,
      supplierPartNo: str(cell(row, 2)),
      description: str(cell(row, 3)),
      supplier: str(cell(row, 4)),
      model: str(cell(row, 5)),
      uom: str(cell(row, 6)),
      qty: totalQty,
      pnaRequestEtd: etd,
      etaPna: etaFinal,
      invoiceNo: str(cell(row, 14)),
      blAwb: str(cell(row, 15)),
      grnNo: str(cell(row, 16)),
      shippingPoint: str(cell(row, 18)),
      status: etaFinal ? "CONFIRMED" : "DRAFT",
      remarks: "",
      createdAt: Date.now(),
    });
    // preserve per-month split as extra lines when spread over months
    if (schedCols.length > 0) {
      const parts = schedCols
        .map((sc) => ({ ym: sc.ym, q: num(cell(row, sc.col)) }))
        .filter((x) => x.q > 0);
      if (parts.length > 1) {
        // annotate qty split into remarks for visibility
        r.poLines[r.poLines.length - 1].remarks =
          "Schedule: " + parts.map((p) => `${p.ym}=${p.q}`).join(", ");
      }
    }
  }
}

function parseForecast(wb: XLSX.WorkBook, r: ParseResult) {
  const ws = wb.Sheets["3. Summ FC By Harness - PPC"];
  if (!ws) {
    r.warnings.push("Sheet '3. Summ FC By Harness - PPC' not found.");
    return;
  }
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  // header at index 4 (row 5). Cols: 0 No, 1 PART NO, 2 (code), 3 PART NAME, 4 MODEL, 5 SELLING PRICE,
  // 6..11 monthly FIRM+FC totals, 16..21 monthly value, 25..30 FIRM monthly, 31..36 FC monthly
  const header = rows[4] ?? [];
  const months: string[] = [];
  for (let c = 6; c <= 11; c++) {
    const iso = excelDateToISO(header[c]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) months.push(iso.slice(0, 7));
  }
  if (months.length === 0) {
    r.warnings.push("Forecast months not detected in '3. Summ FC By Harness - PPC'.");
    return;
  }
  if (r.monthlySeries.length === 0) r.monthlySeries = months;
  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    const partNo = str(cell(row, 1));
    if (!partNo) continue;
    const monthly: Record<string, number> = {};
    let hasAny = false;
    months.forEach((ym, k) => {
      const v = num(cell(row, 6 + k));
      monthly[ym] = v;
      if (v > 0) hasAny = true;
    });
    if (!hasAny) continue;
    r.forecasts.push({
      partNo,
      partName: str(cell(row, 3)),
      model: str(cell(row, 4)),
      customer: "PERODUA",
      sellingPrice: num(cell(row, 5)),
      type: "FORECAST",
      monthly,
      updatedAt: Date.now(),
    });
  }
  // extend series to match forecast horizon
  for (const ym of months) {
    if (!r.monthlySeries.includes(ym)) r.monthlySeries.push(ym);
  }
}

function parseBOM(wb: XLSX.WorkBook, r: ParseResult) {
  const ws = wb.Sheets["bill of materials"];
  if (!ws) {
    r.warnings.push("Sheet 'bill of materials' not found.");
    return;
  }
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  // BOM header at index 17 (row 18): harness part numbers in cols 8..~107
  const header = rows[17] ?? [];
  const harnessCols: { col: number; harness: string }[] = [];
  for (let c = 8; c < header.length; c++) {
    const h = str(header[c]);
    if (h && /^\d/.test(h)) harnessCols.push({ col: c, harness: h });
  }
  if (harnessCols.length === 0) {
    r.warnings.push("No harness columns detected in 'bill of materials'.");
    return;
  }
  for (let i = 18; i < rows.length; i++) {
    const row = rows[i];
    const comp = str(cell(row, 1));
    if (!comp) continue;
    for (const hc of harnessCols) {
      const q = num(cell(row, hc.col));
      if (q > 0) {
        r.bom.push({
          componentPartNo: comp,
          supplierPartNo: str(cell(row, 2)),
          description: str(cell(row, 3)),
          supplier: str(cell(row, 4)),
          uom: str(cell(row, 7)),
          harnessPartNo: hc.harness,
          qtyPerHarness: q,
        });
      }
    }
  }
}
