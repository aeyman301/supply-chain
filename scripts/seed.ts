/**
 * Seed Firebase Realtime Database from the monthly MRP workbook.
 * Build: esbuild scripts/seed.ts --bundle --platform=node --external:firebase --outfile=scripts/seed.mjs
 * Usage: node scripts/seed.mjs "z:\Aeyman\supply chain\SEP-26_MRP_PLAN_ALL Rev0.xlsx"
 */
// @ts-nocheck
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, remove, push, get } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyDYF--dL7Yv9TylCOlVGiV3iviaaiqFJ5c",
  authDomain: "supply-chain-88a2e.firebaseapp.com",
  databaseURL:
    "https://supply-chain-88a2e-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "supply-chain-88a2e",
  storageBucket: "supply-chain-88a2e.firebasestorage.app",
  messagingSenderId: "287209341838",
  appId: "1:287209341838:web:8f96ea5927b05b82879adf",
};

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/seed.mjs <path-to-xlsx>");
  process.exit(1);
}

const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? 0 : Number(v));
const str = (v) => (v == null ? "" : String(v).trim());
const cell = (row, i) => (row && i < row.length ? row[i] : undefined);
function iso(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}

const wb = XLSX.read(readFileSync(file), { cellDates: true });
const rowsOf = (name) => {
  const ws = wb.Sheets[name];
  return ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) : null;
};

const out = { items: [], rawStock: [], fgStock: [], poLines: [], forecasts: [], bom: [] };
let planMonth = "";
let monthlySeries = [];

// MASTER LIST
let rows = rowsOf("MASTER LIST");
if (rows) {
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    const pna = str(cell(r, 1));
    if (!pna) continue;
    const supLt = num(cell(r, 12)), shipLt = num(cell(r, 13));
    out.items.push({
      pnaPartNo: pna, supplierPartNo: str(cell(r, 2)), description: str(cell(r, 3)),
      supplier: str(cell(r, 4)), shippingPoint: str(cell(r, 5)), uom: str(cell(r, 6)),
      whereUse: str(cell(r, 7)), curr: str(cell(r, 8)) || "RM", price: num(cell(r, 9)),
      moq: num(cell(r, 10)), mpq: num(cell(r, 11)),
      supplierLeadTimeWeeks: supLt, shipmentLeadTimeWeeks: shipLt,
      totalLeadTimeWeeks: num(cell(r, 14)) || supLt + shipLt,
      paymentTerm: str(cell(r, 15)), remarks: str(cell(r, 16)), createdAt: Date.now(),
    });
  }
}

// RAW STOCK
rows = rowsOf("1. Raw Stock - Warehouse");
if (rows) {
  const pm = iso(cell(rows[3], 1));
  if (/^\d{4}-\d{2}/.test(pm)) planMonth = pm.slice(0, 7);
  for (let i = 6; i < rows.length; i++) {
    const r = rows[i];
    const partNo = str(cell(r, 1));
    if (!partNo) continue;
    const opening = num(cell(r, 16)), receiving = num(cell(r, 17)), issuance = num(cell(r, 18)), closing = num(cell(r, 20));
    if (!opening && !receiving && !issuance && !closing) continue;
    out.rawStock.push({
      partNo, supplierPartNo: str(cell(r, 2)), description: str(cell(r, 3)),
      supplier: str(cell(r, 4)), model: str(cell(r, 5)), uom: str(cell(r, 15)) || str(cell(r, 6)),
      month: planMonth, opening, receiving, issuance, closing, updatedAt: Date.now(),
    });
  }
}

// FG STOCK
rows = rowsOf("2. FG Stock - PPC");
if (rows) {
  const pm = iso(cell(rows[3], 1));
  const month = /^\d{4}-\d{2}/.test(pm) ? pm.slice(0, 7) : planMonth;
  for (let i = 6; i < rows.length; i++) {
    const r = rows[i];
    const partNo = str(cell(r, 1));
    if (!partNo) continue;
    out.fgStock.push({
      partNo, description: str(cell(r, 2)), model: str(cell(r, 3)), customer: str(cell(r, 4)),
      month, opening: num(cell(r, 5)), incoming: num(cell(r, 6)), production: num(cell(r, 7)),
      delivery: num(cell(r, 8)), closing: num(cell(r, 10)), updatedAt: Date.now(),
    });
  }
}

// OPEN PO ALL
rows = rowsOf("OPEN PO ALL");
if (rows) {
  const header = rows[2] ?? [];
  const schedCols = [];
  for (let c = 19; c < Math.min(header.length, 40); c++) {
    const d = iso(header[c]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) schedCols.push({ col: c, ym: d.slice(0, 7) });
  }
  for (let i = 3; i < rows.length; i++) {
    const r = rows[i];
    const partNo = str(cell(r, 1));
    if (!partNo) continue;
    let totalQty = 0, firstYm = "";
    for (const sc of schedCols) {
      const q = num(cell(r, sc.col));
      if (q > 0) { totalQty += q; if (!firstYm) firstYm = sc.ym; }
    }
    const eta = iso(cell(r, 17)), etd = iso(cell(r, 12));
    const etaFinal = /^\d{4}-\d{2}-\d{2}$/.test(eta) ? eta : firstYm ? `${firstYm}-28` : "";
    if (!totalQty && !etaFinal && !str(cell(r, 11))) continue;
    out.poLines.push({
      poNo: str(cell(r, 11)) || "OPEN-PO", partNo, supplierPartNo: str(cell(r, 2)),
      description: str(cell(r, 3)), supplier: str(cell(r, 4)), model: str(cell(r, 5)),
      uom: str(cell(r, 6)), qty: totalQty, pnaRequestEtd: etd, etaPna: etaFinal,
      invoiceNo: str(cell(r, 14)), blAwb: str(cell(r, 15)), grnNo: str(cell(r, 16)),
      shippingPoint: str(cell(r, 18)), status: etaFinal ? "CONFIRMED" : "DRAFT",
      remarks: "", createdAt: Date.now(),
    });
  }
}

// FORECAST
rows = rowsOf("3. Summ FC By Harness - PPC");
if (rows) {
  const header = rows[4] ?? [];
  const months = [];
  for (let c = 6; c <= 11; c++) {
    const d = iso(header[c]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) months.push(d.slice(0, 7));
  }
  monthlySeries = months;
  for (let i = 5; i < rows.length; i++) {
    const r = rows[i];
    const partNo = str(cell(r, 1));
    if (!partNo) continue;
    const monthly = {};
    let any = false;
    months.forEach((ym, k) => { const v = num(cell(r, 6 + k)); monthly[ym] = v; if (v) any = true; });
    if (!any) continue;
    out.forecasts.push({
      partNo, partName: str(cell(r, 3)), model: str(cell(r, 4)), customer: "PERODUA",
      sellingPrice: num(cell(r, 5)), type: "FORECAST", monthly, updatedAt: Date.now(),
    });
  }
}

// BOM
rows = rowsOf("bill of materials");
if (rows) {
  const header = rows[17] ?? [];
  const harnessCols = [];
  for (let c = 8; c < header.length; c++) {
    const h = str(header[c]);
    if (h && /^\d/.test(h)) harnessCols.push({ col: c, harness: h });
  }
  for (let i = 18; i < rows.length; i++) {
    const r = rows[i];
    const comp = str(cell(r, 1));
    if (!comp) continue;
    for (const hc of harnessCols) {
      const q = num(cell(r, hc.col));
      if (q > 0)
        out.bom.push({
          componentPartNo: comp, supplierPartNo: str(cell(r, 2)), description: str(cell(r, 3)),
          supplier: str(cell(r, 4)), uom: str(cell(r, 7)), harnessPartNo: hc.harness,
          qtyPerHarness: q,
        });
    }
  }
}

console.log("Parsed:", Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])));

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

async function replace(path, arr) {
  const existing = (await get(ref(db, path))).val() ?? {};
  for (const k of Object.keys(existing)) await remove(ref(db, `${path}/${k}`));
  for (const rec of arr) await push(ref(db, path), rec);
}

await replace("items", out.items);
await replace("rawStock", out.rawStock);
await replace("fgStock", out.fgStock);
await replace("poLines", out.poLines);
await replace("forecasts", out.forecasts);
await replace("bom", out.bom);

const settingsRef = ref(db, "settings/main");
const existingSettings = (await get(ref(db, "settings"))).val();
const prev = existingSettings?.main ?? existingSettings?.[Object.keys(existingSettings ?? {})[0]] ?? {};
await set(settingsRef, {
  companyName: "PNA TECHNOLOGIES SDN BHD",
  planMonth: planMonth || "2026-09",
  monthlySeries: monthlySeries.length ? monthlySeries : ["2026-09","2026-10","2026-11","2026-12","2027-01","2027-02"],
  bufferWeeks: prev.bufferWeeks ?? 1,
  jpyRate: prev.jpyRate ?? 0.0251,
  usdRate: prev.usdRate ?? 4.0,
  // requisition letterhead — kept so a re-seed cannot drop the document details
  companyLegalName: prev.companyLegalName ?? "PNA Technologies Bdn.Bhd.",
  companyRegNo: prev.companyRegNo ?? "626024-p",
  companyAddress: prev.companyAddress ?? "Lot 4637, PT 3035, KAWASAN PERUSAHAAN KG GAJAH SIMPANG EMPAT, 36800 KAMPUNG GAJAH, PERAK DARUL RIDZUAN.",
  prFooterCode: prev.prFooterCode ?? "DMSB-PR",
  prLogoUrl: prev.prLogoUrl ?? "https://pnatech.com.my/pna%20logo.png",
});

console.log("Seed complete →", firebaseConfig.databaseURL);
process.exit(0);
