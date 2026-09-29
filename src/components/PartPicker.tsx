import { useEffect, useMemo, useRef, useState } from "react";
import { buildPartCatalog, type PartRef } from "../lib/parts";
import { fmtQty } from "../lib/format";
import type { MasterItem, MaintPart } from "../types";

/**
 * Part number picker shared by Purchase Requisition and Material Request.
 *
 * A native <datalist> is not usable here. Both forms need every part — master
 * items *and* the Spare Part Status list — and a datalist can only be filtered
 * by the part number, so a requester who knows a part as "wide free electrode"
 * or "air gun" finds nothing. A datalist also breaks the layout when it opens
 * over a table row. This searches part no. and description together and lists
 * the matches in the page.
 */
export function PartPicker({
  items,
  maintParts,
  value,
  onPick,
  onText,
  placeholder,
  className = "input !py-1 font-mono",
  /** What to suggest when the box is empty. */
  emptyList = "none",
  /**
   * The caption under the box. Pass false to hide it — useful when a form shows
   * a second picker on the Part Name field and repeating the count is noise.
   */
  hint = true,
  /** Which field this picker edits; only affects the placeholder. */
  field = "partNo",
}: {
  items: (MasterItem & { id?: string })[];
  maintParts: (MaintPart & { id?: string })[];
  value: string;
  /** Called with the catalogue entry when a suggestion is chosen. */
  onPick: (c: PartRef) => void;
  /** Called on every keystroke, with the raw text and any exact match found. */
  onText?: (v: string, resolved?: PartRef) => void;
  placeholder?: string;
  className?: string;
  emptyList?: "none" | "toOrder";
  hint?: boolean;
  field?: "partNo" | "partName";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const boxRef = useRef<HTMLDivElement>(null);

  const catalog = useMemo(() => buildPartCatalog(items, maintParts), [items, maintParts]);

  // keep the box in step when a part is chosen elsewhere (e.g. reopening a form)
  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    // A requisition line carries two pickers (Part No. and Part Name), so leaving
    // focus must close this one — otherwise both lists can sit on screen at once.
    const away = (e: Event) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("focusin", away);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("focusin", away);
    };
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (!q) {
      if (emptyList !== "toOrder") return [];
      return [...catalog.values()]
        .filter((c) => (c.sparePart?.qtyToOrder ?? 0) > 0)
        .sort((a, b) => (b.sparePart?.qtyToOrder ?? 0) - (a.sparePart?.qtyToOrder ?? 0))
        .slice(0, 60);
    }

    const words = q.split(/\s+/);
    const scored: { c: PartRef; score: number }[] = [];
    for (const c of catalog.values()) {
      const no = c.partNo.toLowerCase();
      const desc = c.description.toLowerCase();
      if (!words.every((w) => no.includes(w) || desc.includes(w))) continue;
      // exact part no., then an exact part name, then a prefix, then any other
      // hit. An exact name match ranks high so choosing by name is one click.
      const score =
        no === q ? 0 : desc === q ? 1 : desc.startsWith(q) ? 2 : no.startsWith(q) ? 3 : no.includes(q) ? 4 : 5;
      scored.push({ c, score });
    }
    return scored.sort((a, b) => a.score - b.score).slice(0, 60).map((s) => s.c);
  }, [catalog, query, emptyList]);

  /**
   * Resolve free-typed text to a catalogue entry: an exact part number, or an
   * exact part name. Lets a requester type the name they know and still get the
   * part number, unit and price filled in, without using the dropdown.
   *
   * Never returns an unnumbered spare part — its key is an internal sentinel,
   * and putting that into a form would write "(no part no.) AIR GUN" into the
   * part number and onto the printed document.
   */
  const resolve = (text: string): PartRef | undefined => {
    const t = text.trim();
    if (!t) return undefined;
    const byNo = catalog.get(t);
    if (byNo && !byNo.noPartNo) return byNo;
    const lower = t.toLowerCase();
    // part numbers are treated case-insensitively — 48hw32b540 is the same part
    for (const c of catalog.values()) {
      if (!c.noPartNo && c.partNo.toLowerCase() === lower) return c;
    }
    return [...catalog.values()].find(
      (c) => !c.noPartNo && c.description.toLowerCase() === lower
    );
  };

  const blocked = matches.filter((c) => c.noPartNo).length;

  return (
    <div className="relative" ref={boxRef}>
      <input
        className={className}
        value={value}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          const v = e.target.value;
          setQuery(v);
          setOpen(true);
          onText?.(v, resolve(v));
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={
          placeholder ??
          (field === "partName"
            ? "Search parts by name…"
            : "Search by part no. or description…")
        }
      />

      {open && (
        <div
          data-picker-list={open ? "open" : "closed"}
          className="absolute left-0 z-50 mt-1 max-h-64 w-[min(28rem,80vw)] overflow-y-auto rounded-lg border border-slate-700 bg-slate-800 shadow-2xl"
        >
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400">
              {query.trim()
                ? `No part matches “${query.trim()}”. You can still type a part number that is not in either list.`
                : "Type a part number or description to search."}
            </div>
          ) : (
            matches.map((c) =>
              c.noPartNo ? (
                <div
                  key={c.partNo}
                  className="flex items-baseline justify-between gap-3 px-3 py-1.5"
                  title="This spare record has no part number. Fill one in on the Spare Part Status page before it can be requested."
                >
                  <span className="min-w-0">
                    <span className="text-amber-400 italic text-xs">no part no.</span>
                    <span className="ml-2 truncate text-xs text-slate-300">{c.description}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-amber-400">needs a part no.</span>
                </div>
              ) : (
                <button
                  key={c.partNo}
                  type="button"
                  data-picker-row={c.partNo}
                  // keep the input focused so the form does not jump on select
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onPick(c);
                    setQuery(c.partNo);
                    setOpen(false);
                  }}
                  className="flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left hover:bg-slate-700"
                >
                  <span className="min-w-0">
                    <span className="font-mono text-xs">{c.partNo}</span>
                    <span className="ml-2 truncate text-xs text-slate-300">{c.description}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-slate-400">
                    {c.spare ? "spare" : "master"}
                    {c.stock !== null ? ` · ${c.stock} in stock` : ""}
                  </span>
                </button>
              )
            )
          )}
        </div>
      )}

      {hint && (
        <span className="block text-[10px] text-slate-500 mt-0.5">
          {fmtQty(catalog.size)} parts from Master Items and Spare Part Status.
          {blocked > 0 && (
            <span className="text-amber-400">
              {" "}
              {blocked} match(es) have no part number and cannot be requested.
            </span>
          )}
        </span>
      )}
    </div>
  );
}
