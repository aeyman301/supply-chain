# Integrated Plant Suite — agent notes

## Build, typecheck, deploy

Always run these in this order after editing code:

```
npx tsc -b --noEmit
powershell -ExecutionPolicy Bypass -File "C:\Users\user\Desktop\supply-chain\deploy.ps1"
```

`deploy.ps1` runs the production build itself, so it is the last step. **Deploy
automatically after finishing an edit task — do not wait to be asked.** The user
requested this on 2026-09-29.

Production URL: https://pnatech.com.my/supply.chain/
Vite `base` is `"./"`. The build emits a >500 kB chunk warning; that is expected
and not a failure.

## Project facts

- Stack: Vite, React 18, TypeScript, Firebase RTDB, `xlsx`.
- Firebase project `supply-chain-88a2e`; RTDB at
  `https://supply-chain-88a2e-default-rtdb.asia-southeast1.firebasedatabase.app`.
- There is **no React Router**. Navigation is a `NAV` array in `src/App.tsx`
  (key, label, icon, group) plus a matching `pages` record. Adding a page means
  touching both, plus `src/db-context.tsx` for any new collection.
- Department groups in `src/App.tsx`: `Supply Chain`, `Maintenance`, `Production`.
  Group collapse state is in `localStorage` under `sc.nav.collapsed`.
- A collection is added by: type in `src/types.ts`, `useDbList<T>` in
  `src/db-context.tsx`, field on `DbData`, entry in the `value` object.

## Data sources

- **IPQC workbooks** — `V:\IPQC 2026`, one `.xls` per month 2026.
  Parsed by `src/lib/ipqcExcel.ts`, merged by `src/lib/ipqcMerge.ts`.
  Supplies the **Quality** component of OEE.
- **Downtime workbook** —
  `Y:\26. MARIAM\6. material for dept meeting\11. COMPILE DATA DOWNTIME LEADPREP 2026.xlsx`.
  Parsed by `src/lib/downtimeExcel.ts`, merged by `src/lib/downtimeMerge.ts`.
  Supplies the **Availability** component of OEE.
- **Maintenance form** — legacy PHP at `/maintenance/form_aduan` writes to the
  MySQL `penyelenggaraan` table (see `cpanel/sync_maint_firebase.php`); a cPanel
  cron mirrors it into the `maintRequests` node. The ERP view is read-only.

## Parser conventions

Monthly workbooks in this plant are hand-maintained and drift. Always:

- Map columns by **header text**, never by fixed index. `AUGUST 26` in the
  downtime workbook moves PROBLEM from column 6 to column 9.
- Treat a summary block at the foot of a sheet as **unreliable**. In the
  downtime workbook, June/July/August all carry May's totals verbatim. Compute
  from the dated log rows and warn on disagreement.
- Fold rows with a blank date into the event above them — they are continuation
  lines, not separate records.
- Emit warnings rather than silently reconciling, as `ipqcExcel.ts` does.

## OEE

`OEE = Availability x Performance x Quality`, in `src/lib/production.ts`.

- Quality comes from IPQC (`qualityFromIpqc`), fallback is the typed value.
- Availability comes from the downtime log, fallback is the typed value.
- **Performance has no automated source** — neither workbook records cycle
  counts. It stays manual and is flagged with `assumedAp` until the PLC
  integration lands. Do not fabricate it.

Machine identity is normalised by `canonMachine()` (whitespace and leading zeros
only, so `AC90-1`..`AC90-8` stay distinct). Do not widen it to strip prefixes
like `BD` without the user confirming the machines are the same.
