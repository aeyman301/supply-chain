import type {
  MaterialRequest,
  PurchaseRequisition,
  PurchaseRequisitionLine,
  Settings,
} from "../types";

/**
 * Purchase Requisition document generator.
 *
 * The layout is reproduced from the plant's existing printed form
 * (purchase-requisition-preview.pdf): A4 landscape, Helvetica, a 3-column meta
 * block, a 10-column bordered item table at 6.8mm rows with 0.75pt rules, and
 * the form code bottom-right.
 *
 * The document is emitted as a self-contained HTML page and printed. That is
 * deliberate over a PDF library: the target is a single dense table, HTML/CSS
 * gives exact control of the metrics with crisp selectable text, and it keeps
 * the project free of a ~350 kB dependency. The user saves it from the print
 * dialog, which is the normal path for a form that has to look identical to
 * the paper original.
 */

export const PR_CURRENCIES: Record<string, { symbol: string; label: string }> = {
  RM: { symbol: "RM", label: "Malaysian Ringgit" },
  JPY: { symbol: "¥", label: "Japanese Yen" },
  USD: { symbol: "$", label: "US Dollar" },
  EUR: { symbol: "€", label: "Euro" },
  SGD: { symbol: "S$", label: "Singapore Dollar" },
};

export function currencySymbol(code: string): string {
  return PR_CURRENCIES[code]?.symbol ?? code ?? "";
}

export function currencyLabel(code: string): string {
  return PR_CURRENCIES[code]?.label ?? code ?? "";
}

/** "¥ - Japanese Yen", matching the printed form. */
export function currencyDisplay(code: string): string {
  const c = PR_CURRENCIES[code];
  return c ? `${c.symbol} - ${c.label}` : code || "-";
}

export function lineTotal(l: PurchaseRequisitionLine): number {
  return (Number(l.unitPrice) || 0) * (Number(l.qty) || 0);
}

export interface PrTotals {
  base: number;
  budget: number;
  rate: number;
  myr: number;
  budgetMyr: number;
  lines: number;
}

/**
 * A requisition with no rate prints "N/A" for the rate and 0.00 for both MYR
 * figures — the same as the paper form, which shows 0.00 against a JPY total
 * of 293,449.00. Nothing is invented when the rate is missing.
 */
export function prTotals(pr: PurchaseRequisition): PrTotals {
  const lines = Array.isArray(pr.lines) ? pr.lines : [];
  const base = lines.reduce((s, l) => s + lineTotal(l), 0);
  const budget = Number(pr.budgetAmount) || 0;
  const rate = Number(pr.currencyRate) || 0;
  return {
    base,
    budget,
    rate,
    myr: rate > 0 ? base * rate : 0,
    budgetMyr: rate > 0 ? budget * rate : 0,
    lines: lines.length,
  };
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const money = (n: number): string =>
  (Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const qty = (n: number): string =>
  (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

/** dd/mm/yyyy, the format used on the printed form. */
export function prDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso || "-";
}

const na = (s: string | null | undefined) => (s && s.trim() ? s.trim() : "N/A");

/** A request for a part with no stock record says so rather than showing 0. */
const stockText = (v: number | null | undefined) =>
  v === null || v === undefined ? "N/A" : qty(v);

// column widths in mm, taken from the 11 vertical rules in the source form
const COLS = [9.7, 27.3, 49.1, 24.5, 17.5, 28.5, 31.5, 33.8, 29.4, 18.8];

/**
 * The ten printed column headings. When the document has no single currency
 * the symbol is dropped from the two money columns rather than printing one
 * that would contradict a "mixed currency" total.
 */
const itemHead = (sym: string) => {
  const money = (label: string) =>
    sym ? `<th>${label} (${esc(sym)})</th>` : `<th>${label}</th>`;
  return [
    `<th>No.</th>`,
    `<th>Part No.</th>`,
    `<th>Part Name</th>`,
    `<th>Description</th>`,
    `<th>UOM</th>`,
    money("UNIT Price"),
    `<th>Quantity (UNIT)</th>`,
    money("Total Amount"),
    `<th>Required Date</th>`,
    `<th>Purpose</th>`,
  ].join("");
};

interface DocParts {
  docTitle: string;
  pageTitle: string;
  sym: string;
  metaRows: string;
  rows: string[];
  emptyNote: string;
  pairs: [string, string, string, string][];
  notes: [string, string][];
  footerCode: string;
}

/**
 * Renders the shared document shell. Purchase requisitions and material
 * requests are the same printed form with different headings and meta block,
 * so both go through here and stay pixel-identical below the title.
 */
function renderDocument(p: DocParts, settings: Settings): string {
  const head = itemHead(p.sym);
  const colgroup = COLS.map((w) => `<col style="width:${w}mm" />`).join("");
  const body = p.rows.length
    ? p.rows
        .map(
          (r, i) => `<tr>
      <td>${i + 1}</td>
      ${r}
    </tr>`
        )
        .join("\n")
    : `<tr><td colspan="10" class="empty">${esc(p.emptyNote)}</td></tr>`;

  const companyName = settings.companyLegalName || settings.companyName || "";
  const regNo = settings.companyRegNo ? ` (${settings.companyRegNo})` : "";
  const logo = settings.prLogoUrl || "";

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<title>${esc(p.pageTitle)}</title>
<style>
  @page { size: 297mm 210mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Helvetica, Arial, "Liberation Sans", sans-serif;
    font-size: 9pt; color: #000; background: #fff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet { position: relative; width: 297mm; height: 210mm; padding: 19.2mm 13.4mm 0; }
  .flow { }

  /* ---- letterhead ---- */
  .hdr { display: flex; align-items: flex-start; gap: 6mm; }
  .hdr img { width: 20.4mm; height: 13.2mm; object-fit: contain; flex: none; }
  .co-name { color: #1808a1; font-size: 10.5pt; font-weight: 700; margin-bottom: 1.6mm; }
  .co-addr { font-size: 10.5pt; line-height: 1.25; }

  /* ---- title ---- */
  .title { font-size: 12pt; font-weight: 700; text-align: center; margin: 9mm 0 5mm; }

  /* ---- 3-column meta block ----
     The three columns are not evenly spaced on the printed form: the labels
     sit at 12.3 / 106.9 / 198.1 mm, and the block starts 1.1mm left of the
     item table, so the widths below are taken from those positions. */
  .meta { width: calc(100% + 1.1mm); margin-left: -1.1mm; border-collapse: collapse; table-layout: fixed; font-size: 9pt; }
  .meta td { padding: 0 0 3.4mm; vertical-align: top; }
  .meta b { font-weight: 700; }

  .items-h { font-size: 12pt; font-weight: 700; margin: 5.5mm 0 2.5mm; }

  /* ---- item table ---- */
  .items { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9pt; }
  .items th, .items td { border: 0.75pt solid #000; padding: 0.5mm 1.5mm; height: 6.8mm; }
  .items th { text-align: center; font-weight: 700; vertical-align: middle; }
  .items td { text-align: left; vertical-align: top; }
  .items td.empty { text-align: center; color: #444; }
  .items thead { display: table-header-group; }
  .items tr { page-break-inside: avoid; }

  /* ---- totals and notes ----
     The two label/value pairs on a line are not an even split either: the
     second label starts at 131.9mm, which is 43.8% of the content width. */
  .tot { margin-top: 8mm; font-size: 9pt; }
  .tot .pair { display: grid; grid-template-columns: 43.8% 56.2%; margin-bottom: 1.4mm; }
  .tot .note { margin-bottom: 1.4mm; }
  .tot b { font-weight: 700; margin-right: 1mm; }
  .tot .v { white-space: pre-wrap; }

  /* ---- form code, bottom right of the first page ---- */
  .footcode { position: absolute; right: 15mm; bottom: 15mm; font-size: 12pt; }
</style></head>
<body>
  <div class="sheet">
    <div class="flow">
      <div class="hdr">
        ${logo ? `<img src="${esc(logo)}" alt="" onerror="this.style.display='none'" />` : ""}
        <div>
          <div class="co-name">${esc(companyName)}${esc(regNo)}</div>
          <div class="co-addr">${esc(settings.companyAddress ?? "")}</div>
        </div>
      </div>

      <div class="title">${esc(p.docTitle)}</div>

      <table class="meta">
        <colgroup><col style="width:94.6mm" /><col style="width:91.2mm" /><col /></colgroup>
        ${p.metaRows}
      </table>

      <div class="items-h">Items</div>

      <table class="items">
        <colgroup>${colgroup}</colgroup>
        <thead><tr>${head}</tr></thead>
        <tbody>
${body}
        </tbody>
      </table>

      <div class="tot">
        ${p.pairs
          .map(
            (pair) =>
              `<div class="pair"><span><b>${pair[0]}</b><span class="v">${pair[1]}</span></span><span><b>${pair[2]}</b><span class="v">${pair[3]}</span></span></div>`
          )
          .join("\n        ")}
        ${p.notes
          .map(
            (n) =>
              `<div class="note"><b>${esc(n[0])}</b><span class="v">${esc(n[1])}</span></div>`
          )
          .join("\n        ")}
      </div>
    </div>

    <div class="footcode">${esc(p.footerCode)}</div>
  </div>
</body></html>`;
}

export function buildPrHtml(pr: PurchaseRequisition, settings: Settings): string {
  const t = prTotals(pr);
  const lines = Array.isArray(pr.lines) ? pr.lines : [];
  const rate = t.rate > 0 ? String(t.rate) : "N/A";

  return renderDocument(
    {
      docTitle: "Purchase Requisition",
      pageTitle: pr.prNo || "Purchase Requisition",
      sym: currencySymbol(pr.currency),
      metaRows: `
        <tr>
          <td><b>Category:</b> ${esc(na(pr.category))}</td>
          <td><b>PR No:</b> ${esc(na(pr.prNo))}</td>
          <td><b>Date:</b> ${esc(prDate(pr.prDate ?? ""))}</td>
        </tr>
        <tr>
          <td><b>Requested By:</b> ${esc(na(pr.requestedBy))}</td>
          <td><b>Department:</b> ${esc(na(pr.department))}</td>
          <td><b>Currency:</b> ${esc(na(currencyDisplay(pr.currency)))}</td>
        </tr>
        <tr>
          <td colspan="3"><b>Currency Rate (In MYR):</b> ${esc(rate)}</td>
        </tr>`,
      rows: lines.map(
        (l) => `<td>${esc(l.partNo)}</td>
      <td>${esc(l.partName)}</td>
      <td>${esc(l.description)}</td>
      <td>${esc(l.uom)}</td>
      <td>${qty(l.unitPrice)}</td>
      <td>${qty(l.qty)}</td>
      <td>${money(lineTotal(l))}</td>
      <td>${esc(l.requiredDate ? prDate(l.requiredDate) : "")}</td>
      <td>${esc(l.purpose)}</td>`
      ),
      emptyNote: "No items on this requisition.",
      pairs: [
        ["Total Amount (based currency):", money(t.base), "Budget Amount (based currency):", money(t.budget)],
        ["Total Amount:", money(t.myr), "Budget Amount (MYR):", money(t.budgetMyr)],
      ],
      notes: [
        ["Recommended Supplier, if any:", na(pr.recommendedSupplier)],
        ["Special Requirement:", na(pr.specialRequirement)],
      ],
      footerCode: settings.prFooterCode ?? "",
    },
    settings
  );
}

/** One material request, already joined to its master item and stock balance. */
export interface MrDocLine {
  mr: MaterialRequest;
  unitPrice: number;
  currency: string;
  /** Closing balance, or null when the part has no stock record. */
  stock: number | null;
  supplier: string;
}

/** Ringgit value of a foreign-currency amount, using the stored rates. */
function toMyr(amount: number, currency: string, settings: Settings): number | null {
  if (currency === "RM" || currency === "MYR") return amount;
  if (currency === "JPY") return amount * (Number(settings.jpyRate) || 0);
  if (currency === "USD") return amount * (Number(settings.usdRate) || 0);
  return null;
}

/**
 * Material request document. A single request prints as one line; several can
 * be printed together as one consolidated sheet, which is the form a
 * requisition is usually raised from.
 */
export function buildMrHtml(lines: MrDocLine[], settings: Settings): string {
  const first = lines[0]?.mr;
  const many = lines.length > 1;

  const currencies = [...new Set(lines.map((l) => l.currency || "RM"))];
  const single = currencies.length === 1 ? currencies[0] : "";
  const sym = single ? currencySymbol(single) : "";

  const amount = lines.reduce((s, l) => s + (Number(l.unitPrice) || 0) * (Number(l.mr.qty) || 0), 0);
  const totalQty = lines.reduce((s, l) => s + (Number(l.mr.qty) || 0), 0);
  const myr = single ? toMyr(amount, single, settings) : null;

  const suppliers = [...new Set(lines.map((l) => (l.supplier ?? "").trim()).filter(Boolean))];

  const metaRows = many
    ? `
        <tr>
          <td><b>Requests:</b> ${lines.length}</td>
          <td><b>Departments:</b> ${esc(na([...new Set(lines.map((l) => l.mr.department))].join(", ")))}</td>
          <td><b>Date:</b> ${esc(prDate(lines[0].mr.reqDate ?? ""))}</td>
        </tr>
        <tr>
          <td><b>Requested By:</b> ${esc(na([...new Set(lines.map((l) => l.mr.requestedBy))].join(", ")))}</td>
          <td><b>Status:</b> ${esc(na([...new Set(lines.map((l) => l.mr.status))].join(", ")))}</td>
          <td><b>Priority:</b> ${esc(na([...new Set(lines.map((l) => l.mr.priority))].join(", ")))}</td>
        </tr>
        <tr>
          <td colspan="3"><b>MR No:</b> ${esc(na(lines.map((l) => l.mr.mrNo).join(", ")))}</td>
        </tr>`
    : `
        <tr>
          <td><b>Priority:</b> ${esc(na(first?.priority))}</td>
          <td><b>MR No:</b> ${esc(na(first?.mrNo))}</td>
          <td><b>Request Date:</b> ${esc(prDate(first?.reqDate ?? ""))}</td>
        </tr>
        <tr>
          <td><b>Requested By:</b> ${esc(na(first?.requestedBy))}</td>
          <td><b>Department:</b> ${esc(na(first?.department))}</td>
          <td><b>Status:</b> ${esc(na(first?.status))}</td>
        </tr>
        <tr>
          <td><b>Needed By:</b> ${esc(first?.neededBy ? prDate(first.neededBy) : "N/A")}</td>
          <td><b>In Stock:</b> ${esc(stockText(lines[0]?.stock))}</td>
          <td><b>Approved By:</b> ${esc(na(first?.approvedBy))}</td>
        </tr>`;

  return renderDocument(
    {
      docTitle: "Material Request",
      pageTitle: many ? `Material Request (${lines.length})` : first?.mrNo || "Material Request",
      sym,
      metaRows,
      rows: lines.map((l) => {
        const m = l.mr;
        return `<td>${esc(m.partNo)}</td>
      <td>${esc(m.description)}</td>
      <td></td>
      <td>${esc(m.uom)}</td>
      <td>${qty(l.unitPrice)}</td>
      <td>${qty(m.qty)}</td>
      <td>${money((Number(l.unitPrice) || 0) * (Number(m.qty) || 0))}</td>
      <td>${esc(m.neededBy ? prDate(m.neededBy) : "")}</td>
      <td>${esc(m.purpose)}</td>`;
      }),
      emptyNote: "No items on this request.",
      pairs: [
        [
          "Total Amount" + (single ? ` (${single}):` : ":"),
          many && !single ? "mixed currency" : money(amount),
          "Total Quantity:",
          qty(totalQty),
        ],
        [
          "Total Amount (MYR):",
          myr === null ? "rate unavailable" : money(myr),
          "Items:",
          qty(lines.length),
        ],
      ],
      notes: [
        ["Recommended Supplier, if any:", suppliers.length ? suppliers.join(", ") : "N/A"],
        [
          "Special Requirement:",
          many
            ? na(lines.map((l) => l.mr.remarks).filter(Boolean).join("; "))
            : na(first?.remarks),
        ],
      ],
      footerCode: settings.mrFooterCode ?? "",
    },
    settings
  );
}

/**
 * Open the document and send it to the print dialog, where "Save as PDF"
 * produces the file. Falls back to a hidden iframe when a popup blocker
 * refuses the window, so the button still works.
 */
function printHtml(html: string): void {
  const win = window.open("", "_blank");
  if (win) {
    win.document.open();
    win.document.write(html);
    win.document.close();
    // give the logo a chance to load so it is not missing from the printout
    const go = () => {
      win.focus();
      win.print();
    };
    if (win.document.readyState === "complete") setTimeout(go, 250);
    else win.addEventListener("load", () => setTimeout(go, 250));
    return;
  }

  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  setTimeout(() => frame.remove(), 1000);
}

export function exportPrPdf(pr: PurchaseRequisition, settings: Settings): void {
  printHtml(buildPrHtml(pr, settings));
}

export function exportMrPdf(lines: MrDocLine[], settings: Settings): void {
  printHtml(buildMrHtml(lines, settings));
}
