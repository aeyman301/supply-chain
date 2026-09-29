import React, { createContext, useContext } from "react";
import { useDbList } from "./lib/db";
import type { IpqcDailyRec } from "./lib/ipqcMerge";
import type { DowntimeMonthRec, DowntimeRec } from "./lib/downtimeMerge";
import {
  DEFAULT_SETTINGS,
  type MasterItem,
  type Supplier,
  type StockRecord,
  type FGStockRecord,
  type PurchaseOrderLine,
  type ForecastLine,
  type BomLine,
  type Settings,
  type StockTake,
  type MaintPart,
  type MaintIssue,
  type MaintRequest,
  type ProdDaily,
  type ProdPlanGroup,
  type MaterialRequest,
  type PurchaseRequisition,
} from "./types";

export interface DbData {
  items: MasterItem[];
  suppliers: Supplier[];
  rawStock: StockRecord[];
  fgStock: FGStockRecord[];
  poLines: PurchaseOrderLine[];
  forecasts: ForecastLine[];
  bom: BomLine[];
  settings: Settings | null;
  stockTakes: (StockTake & { id: string })[];
  maintParts: (MaintPart & { id: string })[];
  maintIssues: (MaintIssue & { id: string })[];
  maintRequests: (MaintRequest & { id: string })[];
  prodDaily: (ProdDaily & { id: string })[];
  prodIpqc: (IpqcDailyRec & { id: string })[];
  materialRequests: (MaterialRequest & { id: string })[];
  downtime: (DowntimeRec & { id: string })[];
  downtimeMeta: (DowntimeMonthRec & { id: string })[];
  prodPlan: (ProdPlanGroup & { id: string })[];
  prs: (PurchaseRequisition & { id: string })[];
}

const Ctx = createContext<DbData | null>(null);

export function DbProvider({ children }: { children: React.ReactNode }) {
  const itemsQ = useDbList<MasterItem>("items");
  const suppliersQ = useDbList<Supplier>("suppliers");
  const rawStockQ = useDbList<StockRecord>("rawStock");
  const fgStockQ = useDbList<FGStockRecord>("fgStock");
  const poQ = useDbList<PurchaseOrderLine>("poLines");
  const fcQ = useDbList<ForecastLine>("forecasts");
  const bomQ = useDbList<BomLine>("bom");
  const settingsQ = useDbList<Settings>("settings");
  const stockTakeQ = useDbList<StockTake>("stockTakes");
  const maintPartQ = useDbList<MaintPart>("maintParts");
  const maintIssueQ = useDbList<MaintIssue>("maintIssues");
  const maintReqQ = useDbList<MaintRequest>("maintRequests");
  const prodDailyQ = useDbList<ProdDaily>("prodDaily");
  const prodIpqcQ = useDbList<IpqcDailyRec>("prodIpqc");
  const matReqQ = useDbList<MaterialRequest>("materialRequests");
  const downtimeQ = useDbList<DowntimeRec>("downtime");
  const downtimeMetaQ = useDbList<DowntimeMonthRec>("downtimeMeta");
  const prodPlanQ = useDbList<ProdPlanGroup>("prodPlan");
  const prsQ = useDbList<PurchaseRequisition>("prs");

  const dbError =
    itemsQ.error ||
    rawStockQ.error ||
    poQ.error ||
    fcQ.error ||
    bomQ.error ||
    settingsQ.error;

  const value: DbData = {
    items: itemsQ.list,
    suppliers: suppliersQ.list,
    rawStock: rawStockQ.list,
    fgStock: fgStockQ.list,
    poLines: poQ.list,
    forecasts: fcQ.list,
    bom: bomQ.list,
    settings: settingsQ.list[0] ?? null,
    stockTakes: stockTakeQ.list,
    maintParts: maintPartQ.list,
    maintIssues: maintIssueQ.list,
    maintRequests: maintReqQ.list,
    prodDaily: prodDailyQ.list,
    prodIpqc: prodIpqcQ.list,
    materialRequests: matReqQ.list,
    downtime: downtimeQ.list,
    downtimeMeta: downtimeMetaQ.list,
    prodPlan: prodPlanQ.list,
    prs: prsQ.list,
  };

  const loading =
    itemsQ.loading ||
    rawStockQ.loading ||
    poQ.loading ||
    fcQ.loading ||
    bomQ.loading ||
    settingsQ.loading ||
    stockTakeQ.loading ||
    maintPartQ.loading;

  if (dbError) {
    const denied = /permission|denied|auth|401|unauthorized/i.test(dbError);
    return (
      <div className="flex items-center justify-center min-h-screen p-6">
        <div className="card max-w-xl">
          <h2 className="font-bold text-rose-400 mb-2">Firebase access error</h2>
          <p className="text-sm text-slate-300 mb-3 font-mono break-all">{dbError}</p>
          {denied ? (
            <div className="text-sm text-slate-400 space-y-2">
              <p>
                Your Realtime Database rules block reads/writes. Open{" "}
                <a
                  className="text-sky-400 underline"
                  href="https://console.firebase.google.com/project/supply-chain-88a2e/database/supply-chain-88a2e-default-rtdb/rules"
                  target="_blank"
                  rel="noreferrer"
                >
                  Firebase Console → Realtime Database → Rules
                </a>{" "}
                and publish one of:
              </p>
              <pre className="bg-slate-800 rounded p-2 text-xs overflow-x-auto">{`// quick dev (open) — never ship to prod
{
  "rules": { ".read": true, ".write": true }
}`}</pre>
              <pre className="bg-slate-800 rounded p-2 text-xs overflow-x-auto">{`// safer: any signed-in user
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}`}</pre>
              <p>After publishing rules, reload this page.</p>
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              Check your internet connection and that the database URL is reachable, then reload.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen text-slate-500">
        Connecting to Firebase…
      </div>
    );
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDb(): DbData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDb must be used within DbProvider");
  return v;
}

export { DEFAULT_SETTINGS };
