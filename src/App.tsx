import { useEffect, useRef, useState } from "react";
import {
  DbProvider,
  useDb,
  type DbData,
} from "./db-context";
import { computeMrp } from "./lib/mrp";
import { DEFAULT_SETTINGS, effectiveMonthlySeries, type Settings } from "./types";
import Dashboard from "./pages/Dashboard";
import Items from "./pages/Items";
import Suppliers from "./pages/Suppliers";
import Inventory from "./pages/Inventory";
import PurchaseOrders from "./pages/PurchaseOrders";
import PurchaseRequisitions from "./pages/PurchaseRequisitions";
import MaterialRequests from "./pages/MaterialRequests";
import Forecast from "./pages/Forecast";
import Bom from "./pages/Bom";
import MrpPage from "./pages/Mrp";
import Maintenance from "./pages/Maintenance";
import MaintenanceDowntime from "./pages/MaintenanceDowntime";
import MaintFormList from "./pages/MaintFormList";
import Production from "./pages/Production";
import ProductionImport from "./pages/ProductionImport";
import StockTakePage from "./pages/StockTake";
import ImportPage from "./pages/Import";
import SettingsPage from "./pages/Settings";
import { useTheme } from "./lib/theme";

const SUPPLY_CHAIN = "Supply Chain";
const MAINTENANCE = "Maintenance";
const PRODUCTION = "Production";

type NavItem = { key: string; label: string; icon: string; group?: string };

const NAV = [
  { key: "dashboard", label: "Dashboard", icon: "▤", group: SUPPLY_CHAIN },
  { key: "mrp", label: "MRP Plan", icon: "▦", group: SUPPLY_CHAIN },
  { key: "items", label: "Master Items", icon: "☰", group: SUPPLY_CHAIN },
  { key: "inventory", label: "Inventory", icon: "▧", group: SUPPLY_CHAIN },
  { key: "stocktake", label: "Stock Take", icon: "⊞", group: SUPPLY_CHAIN },
  { key: "po", label: "Purchase Orders", icon: "▣", group: SUPPLY_CHAIN },
  { key: "pr", label: "Purchase Requisition", icon: "▤", group: SUPPLY_CHAIN },
  { key: "matreq", label: "Material Requests", icon: "✎", group: SUPPLY_CHAIN },
  { key: "forecast", label: "Forecast", icon: "◈", group: SUPPLY_CHAIN },
  { key: "bom", label: "BOM", icon: "◉", group: SUPPLY_CHAIN },
  { key: "suppliers", label: "Suppliers", icon: "◎", group: SUPPLY_CHAIN },
  { key: "maintenance", label: "Spare Part Status", icon: "⛭", group: MAINTENANCE },
  { key: "downtime", label: "Machine Downtime", icon: "⏱", group: MAINTENANCE },
  { key: "maintform", label: "Maintenance Form", icon: "✉", group: MAINTENANCE },
  { key: "production", label: "Production Dashboard", icon: "▩", group: PRODUCTION },
  { key: "prodimport", label: "Import IPQC", icon: "⇪", group: PRODUCTION },
  { key: "import", label: "Import Excel", icon: "⇪", group: "" },
  { key: "settings", label: "Settings", icon: "⚙", group: "" },
] as const satisfies readonly NavItem[];

// Tabs shown in the mobile bottom bar (max 5)
const MOBILE_TABS = ["dashboard", "mrp", "po", "inventory", "more"] as const;
type NavKey = (typeof NAV)[number]["key"];

const COLLAPSE_KEY = "sc.nav.collapsed";

function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : null;
      return Array.isArray(v) ? v.filter((g): g is string => typeof g === "string") : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch {
      /* storage unavailable — collapse state is session-only */
    }
  }, [collapsed]);

  const toggle = (group: string) =>
    setCollapsed((prev) =>
      prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group]
    );

  const expand = (group: string) =>
    setCollapsed((prev) => (prev.includes(group) ? prev.filter((g) => g !== group) : prev));

  return { collapsed, toggle, expand };
}

function NavGroupHeader({
  group,
  open,
  onToggle,
  active,
  count,
  isFirst,
}: {
  group: string;
  open: boolean;
  onToggle: () => void;
  active: boolean;
  count: number;
  isFirst: boolean;
}) {
  return (
    <button
      type="button"
      className={`nav-group ${isFirst ? "first" : ""} ${active && !open ? "has-active" : ""}`}
      onClick={onToggle}
      aria-expanded={open}
      title={open ? `Collapse ${group} (${count} pages)` : `Expand ${group} (${count} pages)`}
    >
      <span className="nav-chevron" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="truncate">{group}</span>
      {!open && active && <span className="nav-group-dot" aria-hidden />}
      <span className="nav-group-count">{count}</span>
    </button>
  );
}

function NavButtons({
  page,
  setPage,
  onNavigate,
  collapsed,
  toggle,
  expand,
}: {
  page: NavKey;
  setPage: (k: NavKey) => void;
  onNavigate?: () => void;
  collapsed: string[];
  toggle: (g: string) => void;
  expand: (g: string) => void;
}) {
  const isOpen = (group: string) => !collapsed.includes(group);
  const groupHasActive = (group: string) => NAV.some((n) => n.group === group && n.key === page);
  const groupCount = (group: string) => NAV.filter((n) => n.group === group).length;

  // Auto-expand the group holding the active page, but only when the page
  // actually changes (mobile tab bar, dashboard shortcut, deep link). This
  // keeps a manual collapse of the group you are currently viewing.
  const lastPage = useRef(page);
  useEffect(() => {
    if (lastPage.current === page) return;
    lastPage.current = page;
    const group = NAV.find((n) => n.key === page)?.group ?? "";
    if (group !== "") expand(group);
  }, [page, expand]);

  let lastGroup: string | null = null;
  return (
    // The sidebar is a fixed-height flex column, so the nav itself is the only
    // thing that can scroll once the list outgrows the viewport. `min-h-0` is
    // required: without it a flex child refuses to shrink below its content
    // height, so the list overflows instead of scrolling.
    <nav className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-0.5 pr-0.5">
      {NAV.map((n) => {
        const group = n.group;
        const showHeader = group !== "" && group !== lastGroup;
        const showDivider = group === "" && lastGroup !== null && lastGroup !== "";
        const isFirst = lastGroup === null;
        const hidden = group !== "" && !isOpen(group);
        lastGroup = group;
        return (
          <div key={n.key}>
            {showHeader && (
              <NavGroupHeader
                group={group}
                open={isOpen(group)}
                onToggle={() => toggle(group)}
                active={groupHasActive(group)}
                count={groupCount(group)}
                isFirst={isFirst}
              />
            )}
            {showDivider && <div className="nav-divider" />}
            {!hidden && (
              <button
                className={`nav-link ${page === n.key ? "active" : ""}`}
                onClick={() => {
                  setPage(n.key);
                  onNavigate?.();
                }}
              >
                <span className="w-4 text-center">{n.icon}</span>
                {n.label}
              </button>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function Shell() {
  const [page, setPage] = useState<NavKey>("dashboard");
  const [drawer, setDrawer] = useState(false);
  const { collapsed, toggle: toggleGroup, expand } = useCollapsedGroups();
  const db = useDb();
  const { theme, toggle } = useTheme();

  const rawSettings: Settings = db.settings ?? DEFAULT_SETTINGS;
  // auto-rolled (or fixed) horizon — single source of truth for every page
  const settings: Settings = {
    ...rawSettings,
    monthlySeries: effectiveMonthlySeries(rawSettings),
  };
  const mrpRows = computeMrp({
    items: db.items,
    rawStock: db.rawStock,
    poLines: db.poLines,
    forecasts: db.forecasts,
    bom: db.bom,
    fgStock: db.fgStock,
    settings,
  });

  const pages: Record<NavKey, React.ReactNode> = {
    dashboard: <Dashboard db={db} settings={settings} mrpRows={mrpRows} onNavigate={setPage} />,
    mrp: <MrpPage settings={settings} mrpRows={mrpRows} />,
    items: <Items db={db} />,
    inventory: <Inventory db={db} settings={settings} />,
    stocktake: <StockTakePage db={db} />,
    po: <PurchaseOrders db={db} />,
    pr: <PurchaseRequisitions db={db} />,
    matreq: <MaterialRequests db={db} />,
    forecast: <Forecast db={db} settings={settings} />,
    bom: <Bom db={db} />,
    suppliers: <Suppliers db={db} />,
    maintenance: <Maintenance db={db} />,
    downtime: <MaintenanceDowntime />,
    maintform: <MaintFormList />,
    production: <Production />,
    prodimport: <ProductionImport />,
    import: <ImportPage />,
    settings: <SettingsPage db={db} />,
  };

  // close drawer on tab change (mobile)
  useEffect(() => setDrawer(false), [page]);

  const activeLabel = NAV.find((n) => n.key === page)?.label ?? "";

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-56 shrink-0 border-r border-slate-800 bg-slate-900/60 p-3 flex-col sticky top-0 h-screen">
        <div className="px-2 py-3 mb-2 flex items-center gap-2">
          <img
            src="https://pnatech.com.my/pna%20logo.png"
            alt="PNA logo"
            className="h-9 w-auto"
          />
          <div className="min-w-0">
            <div className="font-bold text-sky-400 leading-tight text-sm">
              Integrated Plant Suite
            </div>
          </div>
        </div>
        <NavButtons page={page} setPage={setPage} collapsed={collapsed} toggle={toggleGroup} expand={expand} />
        <div className="mt-auto text-xs text-slate-600 px-2">
          <button className="hover:text-slate-400" onClick={toggle}>
            {theme === "dark" ? "◐ Light mode" : "◑ Dark mode"}
          </button>
        </div>
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <aside
            className="absolute left-0 top-0 h-full w-64 bg-slate-900 border-r border-slate-800 p-3 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2 py-3 mb-2 flex items-center gap-2">
              <img src="https://pnatech.com.my/pna%20logo.png" alt="PNA logo" className="h-9 w-auto" />
              <div className="min-w-0">
                <div className="font-bold text-sky-400 leading-tight text-sm">
                  Integrated Plant Suite
                </div>
              </div>
            </div>
            <NavButtons
              page={page}
              setPage={setPage}
              onNavigate={() => setDrawer(false)}
              collapsed={collapsed}
              toggle={toggleGroup}
              expand={expand}
            />
            <div className="mt-auto text-xs text-slate-600 px-2">
              <button className="hover:text-slate-400" onClick={toggle}>
                {theme === "dark" ? "◐ Light mode" : "◑ Dark mode"}
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="md:hidden sticky top-0 z-30 bg-slate-900/95 border-b border-slate-800 px-3 py-2 flex items-center gap-2">
          <button
            className="btn-secondary !px-2 !py-1"
            aria-label="Open menu"
            onClick={() => setDrawer(true)}
          >
            ☰
          </button>
          <img src="https://pnatech.com.my/pna%20logo.png" alt="PNA logo" className="h-7 w-auto" />
          <span className="font-semibold text-sm">{activeLabel}</span>
        </header>

        <main className="flex-1 p-3 md:p-6 max-w-[1600px] w-full pb-20 md:pb-6">{pages[page]}</main>

        {/* Mobile bottom tab bar */}
        <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-slate-900/95 border-t border-slate-800 flex">
          {MOBILE_TABS.map((t) => {
            if (t === "more") {
              const inMore = !["dashboard", "mrp", "po", "inventory"].includes(page);
              return (
                <button
                  key={t}
                  className={`flex-1 py-2 flex flex-col items-center text-[10px] ${
                    inMore ? "text-sky-300" : "text-slate-400"
                  }`}
                  onClick={() => setDrawer(true)}
                >
                  <span className="text-base leading-5">⋯</span>
                  More
                </button>
              );
            }
            const n = NAV.find((x) => x.key === t)!;
            return (
              <button
                key={t}
                className={`flex-1 py-2 flex flex-col items-center text-[10px] ${
                  page === t ? "text-sky-300" : "text-slate-400"
                }`}
                onClick={() => setPage(t as NavKey)}
              >
                <span className="text-base leading-5">{n.icon}</span>
                {t === "po" ? "Orders" : t === "mrp" ? "MRP" : n.label}
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <DbProvider>
      <Shell />
    </DbProvider>
  );
}

export type { DbData };
