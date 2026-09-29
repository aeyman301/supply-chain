# Supply Chain ERP (PNA Technologies)

A realtime Supply Chain / MRP ERP built with React + Vite + Tailwind, backed by **Google Firebase Realtime Database**. Seeded from the real monthly MRP workbook (`SEP-26_MRP_PLAN_ALL Rev0.xlsx`).

## Features

- **Dashboard** — shortage KPIs, demand vs PO arrival chart, shortage by supplier, top shortage list
- **MRP Plan** — computed material requirements: stock + incoming POs − BOM-exploded forecast demand, projected monthly balances, shortage month, MOQ-rounded "plan to order" with one-click **Draft PO** creation
- **Master Items** — part master (prices, MOQ/MPQ, lead times, payment terms)
- **Inventory** — warehouse stock-take records (opening / receiving / issuance / closing)
- **Purchase Orders** — open PO tracking with status flow DRAFT → CONFIRMED → SHIPPED → RECEIVED
- **Forecast** — harness-level FIRM/FC monthly forecast with chart
- **BOM** — component × harness usage matrix (exploded into MRP demand)
- **Suppliers** — derived supplier view with open shortage exposure
- **Import Excel** — drag & drop the monthly workbook; parses all 6 core sheets and replaces cloud data
- **Settings** — plan month, 10-month horizon, buffer weeks, FX rates

## Getting started

```bash
npm install
npm run dev
```

Then either:

1. **Import the workbook** in the UI: *Import Excel* → drop `SEP-26_MRP_PLAN_ALL Rev0.xlsx` → *Replace cloud data*, or
2. **Seed from CLI**:
   ```bash
   npm i -g esbuild
   esbuild scripts/seed.ts --bundle --platform=node --external:firebase --outfile=scripts/seed.mjs
   node scripts/seed.mjs "z:\Aeyman\supply chain\SEP-26_MRP_PLAN_ALL Rev0.xlsx"
   ```

## Data model (Firebase RTD)

| Path         | Content                                          |
| ------------ | ------------------------------------------------ |
| `items`      | master item list (key = PNA part no)             |
| `rawStock`   | raw material stock-take lines per month          |
| `fgStock`    | finished goods stock per month                   |
| `poLines`    | open PO lines w/ status + ETA (drives MRP supply)|
| `forecasts`  | harness forecast, monthly qty map                |
| `bom`        | component usage per harness                      |
| `suppliers`  | supplier directory                               |
| `settings`   | plan month, horizon, buffer, FX                  |

## MRP logic (mirrors the workbook)

1. Component monthly demand = Σ (harness forecast × BOM qty-per-harness)
2. Supply = warehouse closing stock (month 0) + open PO qty by ETA month
3. Projected balance rolls forward monthly; first negative month = shortage date
4. Shortage qty = demand + buffer (daily usage × 6 × buffer weeks) − stock − incoming
5. Plan to order = shortage rounded up to MOQ

> The Excel file also remains the system of record for monthly refresh — re-import any time.
