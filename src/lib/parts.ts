import type { MasterItem, MaintPart } from "../types";

/**
 * A part resolved across the two part lists the plant keeps.
 *
 * Master Items is the purchasing catalogue; Spare Part Status is the
 * maintenance list, which carries its own live balance and ordering limits.
 * A part can appear in both, so a single catalogue entry merges them: the
 * master record supplies the purchasing fields, the spare record supplies the
 * balance and takes precedence for the price, because the spare list is what
 * the maintenance team actually maintains.
 *
 * Nothing is written back to either collection by this helper. Keeping the
 * spare list as the owner of its own stock is deliberate — copying balances
 * into the master would let the two drift apart silently.
 */
export interface PartRef {
  partNo: string;
  description: string;
  uom: string;
  price: number;
  currency: string;
  supplier: string;
  /** Closing balance, or null when the part is not on the spare list. */
  stock: number | null;
  /** True when this part comes from the Spare Part Status list. */
  spare: boolean;
  /** The master record, when the part is in Master Items. */
  master?: MasterItem;
  /** The spare record, when the part is on the Spare Part Status list. */
  sparePart?: MaintPart;
  /** Spare records sharing this part number; 1 unless the number is duplicated. */
  recordCount?: number;
  /** Spare record with no part number — findable, but not orderable. */
  noPartNo?: boolean;
}

export function buildPartCatalog(
  items: (MasterItem & { id?: string })[],
  maintParts: (MaintPart & { id?: string })[]
): Map<string, PartRef> {
  const cat = new Map<string, PartRef>();

  for (const i of items) {
    const key = (i.pnaPartNo ?? "").trim();
    if (!isUsablePartNo(key)) continue;
    cat.set(key, {
      partNo: key,
      description: i.description ?? "",
      uom: i.uom || "PC",
      price: Number(i.price) || 0,
      currency: i.curr || "RM",
      supplier: i.supplier ?? "",
      stock: null,
      spare: false,
      master: i,
      recordCount: 1,
    });
  }

  for (const p of maintParts) {
    const key = (p.partNo ?? "").trim();
    if (!isUsablePartNo(key)) continue;
    const base = cat.get(key);
    // A part number can appear on more than one spare record — the same part in
    // two categories, or a part and its refurbish. Their balances are summed
    // rather than overwritten, so picking this part number cannot understate it.
    const stock = (Number(p.currentStock) || 0) + (base?.stock ?? 0);
    cat.set(key, {
      partNo: key,
      description: p.name || base?.description || "",
      uom: base?.uom || "PC",
      price: Number(p.price) || base?.price || 0,
      currency: base?.currency || "RM",
      supplier: p.supplier || base?.supplier || "",
      stock,
      spare: true,
      master: base?.master,
      sparePart: p,
      recordCount: (base?.recordCount ?? 0) + 1,
    });
  }

  // 7 spare records have no part number at all ("-" or "0") but are real parts
  // with a name, supplier and stock. They are catalogued under a sentinel key so
  // a search for their name finds them, and flagged so the UI can explain that
  // they cannot be put on a request until the number is filled in.
  for (const p of maintParts) {
    const key = (p.partNo ?? "").trim();
    if (isUsablePartNo(key)) continue;
    const name = (p.name ?? "").trim();
    const unkeyed = NO_PART_NO_PREFIX + (name || "(unnamed part)");
    if (cat.has(unkeyed)) continue;
    cat.set(unkeyed, {
      partNo: unkeyed,
      description: name,
      uom: "PC",
      price: Number(p.price) || 0,
      currency: "RM",
      supplier: p.supplier || "",
      stock: Number(p.currentStock) || 0,
      spare: true,
      sparePart: p,
      recordCount: 1,
      noPartNo: true,
    });
  }

  return cat;
}

/**
 * Prefix keying the spare records that have no part number, so they can be
 * found in search without ever colliding with a real part number. Nothing that
 * comes off a parts sheet or the Spare Part Status list starts with "(".
 */
export const NO_PART_NO_PREFIX = "(no part no.) ";

/** True for a catalogue key that stands in for an unnumbered spare part. */
export function isNoPartNoKey(key: string): boolean {
  return (key ?? "").startsWith(NO_PART_NO_PREFIX);
}

/**
 * A part number is usable as an identifier only if it carries at least one
 * letter or digit and is not a single character. The spare list holds a few
 * placeholder rows ("-", "0") that would otherwise appear as blank parts.
 */
export function isUsablePartNo(key: string): boolean {
  const k = (key ?? "").trim();
  return k.length >= 2 && /[A-Za-z0-9]/.test(k);
}

/**
 * Fields to seed a new Master Item from a spare part. The spare list's
 * `category` is a maintenance taxonomy (MACHINE, APPLICATOR, POLE ...) and is
 * deliberately not copied — the master page derives its own categories.
 */
export function spareToMasterItem(p: MaintPart): MasterItem {
  return {
    pnaPartNo: p.partNo ?? "",
    supplierPartNo: "",
    description: p.name ?? "",
    category: "",
    supplier: p.supplier ?? "",
    shippingPoint: "",
    uom: "PC",
    whereUse: p.machineModel ?? "",
    curr: "RM",
    price: Number(p.price) || 0,
    moq: 0,
    mpq: 0,
    supplierLeadTimeWeeks: 0,
    shipmentLeadTimeWeeks: 0,
    totalLeadTimeWeeks: 0,
    paymentTerm: "",
    remarks: p.remarks ?? "",
  };
}
