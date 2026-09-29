import { useState } from "react";
import { Card, Field } from "../components/ui";
import { dbSet } from "../lib/db";
import { monthLabel } from "../lib/format";
import { DEFAULT_SETTINGS, effectiveMonthlySeries, type Settings } from "../types";
import type { DbData } from "../db-context";

function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export default function SettingsPage({ db }: { db: DbData }) {
  const current: Settings = db.settings ?? DEFAULT_SETTINGS;
  const [draft, setDraft] = useState<Settings>(current);
  const [saved, setSaved] = useState(false);
  const settingsId = db.settings && (db.settings as any).id ? (db.settings as any).id : null;

  const start = draft.monthlySeries[0] ?? draft.planMonth ?? currentMonthFallback();

  // live preview uses the same logic as the app shell
  const preview = effectiveMonthlySeries({
    ...draft,
    monthlySeries: draft.horizonAutoRoll
      ? draft.monthlySeries
      : draft.monthlySeries.filter((m) => /^\d{4}-\d{2}$/.test(m)),
  });

  const setHorizon = (startYm: string, len: number) => {
    const s = /^\d{4}-\d{2}$/.test(startYm) ? startYm : start;
    const n = Math.min(24, Math.max(1, Math.round(len) || 1));
    const series = Array.from({ length: n }, (_, i) => addMonths(s, i));
    setDraft({ ...draft, monthlySeries: series, planMonth: series[0] });
  };

  const setHorizonFrom = setHorizon;

  const save = async () => {
    const rec: Settings = {
      ...draft,
      planMonth: draft.horizonAutoRoll ? preview[0] ?? draft.planMonth : draft.planMonth,
      monthlySeries: draft.horizonAutoRoll ? preview : draft.monthlySeries.slice().sort(),
    };
    if (settingsId) await dbSet(`settings/${settingsId}`, rec);
    else await dbSet("settings", { main: rec });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm text-slate-500">Global planning parameters</p>
      </div>

      <Card>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Company name">
            <input className="input" value={draft.companyName} onChange={(e) => setDraft({ ...draft, companyName: e.target.value })} />
          </Field>
          <Field label="Plan month">
            <input type="month" className="input" value={draft.planMonth} onChange={(e) => setDraft({ ...draft, planMonth: e.target.value })} />
          </Field>
          <Field label="Buffer weeks (safety stock)">
            <input type="number" className="input" value={draft.bufferWeeks} onChange={(e) => setDraft({ ...draft, bufferWeeks: +e.target.value })} />
          </Field>
          <Field label="JPY → RM rate">
            <input type="number" step="0.0001" className="input" value={draft.jpyRate} onChange={(e) => setDraft({ ...draft, jpyRate: +e.target.value })} />
          </Field>
          <Field label="USD → RM rate">
            <input type="number" step="0.01" className="input" value={draft.usdRate} onChange={(e) => setDraft({ ...draft, usdRate: +e.target.value })} />
          </Field>
        </div>

        <div className="mt-4 pt-4 border-t border-slate-800">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Monthly horizon</div>

          <label className="flex items-center gap-2 text-sm mb-3 cursor-pointer">
            <input
              type="checkbox"
              className="accent-sky-500 w-4 h-4"
              checked={draft.horizonAutoRoll ?? true}
              onChange={(e) =>
                setDraft({ ...draft, horizonAutoRoll: e.target.checked })
              }
            />
            <span>
              <b>Auto-roll</b> — always plan from the current month
              <span className="text-slate-500"> (recommended; no maintenance needed)</span>
            </span>
          </label>

          {draft.horizonAutoRoll ? (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-slate-400">Plan</span>
              <button className="btn-secondary !px-3" onClick={() => setDraft({ ...draft, horizonMonths: Math.max(1, (draft.horizonMonths ?? 12) - 1) })}>
                −
              </button>
              <input
                type="number"
                min={1}
                max={24}
                className="input !w-16 text-center"
                value={draft.horizonMonths ?? 12}
                onChange={(e) => setDraft({ ...draft, horizonMonths: Math.min(24, Math.max(1, +e.target.value || 1)) })}
              />
              <button className="btn-secondary !px-3" onClick={() => setDraft({ ...draft, horizonMonths: Math.min(24, (draft.horizonMonths ?? 12) + 1) })}>
                +
              </button>
              <span className="text-sm text-slate-400">months ahead</span>
              <div className="flex gap-1">
                {[6, 10, 12].map((n) => (
                  <button
                    key={n}
                    className={`btn-secondary !py-1 !px-2 text-xs ${(draft.horizonMonths ?? 12) === n ? "!border-sky-500 !text-sky-300" : ""}`}
                    onClick={() => setDraft({ ...draft, horizonMonths: n })}
                  >
                    {n}M
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Start month">
                <input
                  type="month"
                  className="input"
                  value={draft.monthlySeries[0] ?? ""}
                  onChange={(e) => setHorizonFrom(e.target.value, draft.monthlySeries.length)}
                />
              </Field>
              <Field label="Number of months">
                <div className="flex items-center gap-2">
                  <button className="btn-secondary !px-3" onClick={() => setHorizonFrom(draft.monthlySeries[0] ?? start, draft.monthlySeries.length - 1)}>
                    −
                  </button>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    className="input !w-16 text-center"
                    value={draft.monthlySeries.length}
                    onChange={(e) => setHorizonFrom(draft.monthlySeries[0] ?? start, +e.target.value)}
                  />
                  <button className="btn-secondary !px-3" onClick={() => setHorizonFrom(draft.monthlySeries[0] ?? start, draft.monthlySeries.length + 1)}>
                    +
                  </button>
                </div>
              </Field>
            </div>
          )}

          <div className="text-xs text-slate-500 mt-2">
            {preview.map(monthLabel).join(" → ")}
            {draft.horizonAutoRoll && (
              <span className="text-sky-400"> · rolls forward automatically each month</span>
            )}
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-slate-800">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">
            Requisition document
          </div>
          <p className="text-xs text-slate-500 mb-3">
            Printed on the letterhead of every exported purchase requisition PDF.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Registered company name">
              <input
                className="input"
                value={draft.companyLegalName ?? ""}
                onChange={(e) => setDraft({ ...draft, companyLegalName: e.target.value })}
              />
            </Field>
            <Field label="Registration no.">
              <input
                className="input"
                value={draft.companyRegNo ?? ""}
                onChange={(e) => setDraft({ ...draft, companyRegNo: e.target.value })}
              />
            </Field>
            <Field label="PR form code (bottom right)">
              <input
                className="input font-mono"
                value={draft.prFooterCode ?? ""}
                onChange={(e) => setDraft({ ...draft, prFooterCode: e.target.value })}
              />
            </Field>
            <Field label="MR form code (bottom right)">
              <input
                className="input font-mono"
                value={draft.mrFooterCode ?? ""}
                onChange={(e) => setDraft({ ...draft, mrFooterCode: e.target.value })}
              />
            </Field>
            <Field label="Logo URL">
              <input
                className="input"
                value={draft.prLogoUrl ?? ""}
                onChange={(e) => setDraft({ ...draft, prLogoUrl: e.target.value })}
              />
            </Field>
            <div className="md:col-span-2">
              <Field label="Registered address">
                <input
                  className="input"
                  value={draft.companyAddress ?? ""}
                  onChange={(e) => setDraft({ ...draft, companyAddress: e.target.value })}
                />
              </Field>
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button className="btn-primary" onClick={save}>
            Save Settings
          </button>
          {saved && <span className="text-emerald-400 text-sm">Saved ✔</span>}
        </div>
      </Card>

      <Card title="Firebase">
        <div className="text-sm text-slate-400 space-y-1">
          <div>Project: <code className="text-sky-300">supply-chain-88a2e</code></div>
          <div>Region: asia-southeast1 (Realtime Database)</div>
          <div className="text-xs text-slate-500 mt-2">
            Collections: items, suppliers, rawStock, fgStock, poLines, forecasts, bom, stockTakes, settings
          </div>
        </div>
      </Card>
    </div>
  );
}

function currentMonthFallback() {
  return new Date().toISOString().slice(0, 7);
}
