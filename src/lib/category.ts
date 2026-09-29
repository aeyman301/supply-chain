const PREFIX_MAP: Record<string, string> = {
  TERM: "TERMINAL",
  CLIP: "CLIP",
  CONN: "CONNECTOR",
  TAPE: "TAPE",
  VTA: "TAPE",
  TUBV: "TUBE",
  TUBH: "TUBE",
  TUBT: "TUBE",
  TUBC: "TUBE",
  TUBR: "TUBE",
  TUBE: "TUBE",
  WIRE: "CABLE",
  CBL: "CABLE",
  CABL: "CABLE",
  CABLE: "CABLE",
  SLVE: "SLEEVE",
  SHEV: "SLEEVE",
  SLEEVE: "SLEEVE",
  GROM: "GROMMET",
  GRO: "GROMMET",
  SEAL: "SEAL",
  SEALER: "SEALER",
  GRSE: "GREASE",
  GREASE: "GREASE",
  NAMS: "LABEL",
  LABL: "LABEL",
  LABEL: "LABEL",
  PROT: "PROTECTOR",
  HST: "HEAT SHRINK",
  PLUG: "PLUG",
  CAP: "CAPACITOR",
  RES: "RESISTOR",
  FUSE: "FUSE",
  REL: "RELAY",
  SW: "SWITCH",
  SWTH: "SWITCH",
  BOLT: "BOLT",
  NUT: "NUT",
  SNUT: "NUT",
  BND: "BANDING",
  SPI: "SPIRAL",
  GEAR: "GEAR",
  HOLD: "HOLDER",
  COV: "COVER",
  COVE: "COVER",
  MOTO: "MOTOR",
  SPRG: "SPRING",
  RING: "RING",
  LEVE: "LEVER",
  LEV: "LEVER",
  OTH: "OTHERS",
  OTHE: "OTHERS",
  MISC: "OTHERS",
};

/** Derive a material category from a description like "TERM- TERMINAL", "VTA - 0.07MM x ...", "CLIP- CLIP..." */
export function deriveCategory(description: string): string {
  const d = (description ?? "").trim();
  const m = /^([A-Za-z]{2,6})\s*[-–]/.exec(d);
  if (m) {
    const token = m[1].toUpperCase();
    return PREFIX_MAP[token] ?? token;
  }
  // descriptions starting with a known word e.g. "WIRE FR DOOR RH"
  const first = d.split(/[\s,]/)[0]?.toUpperCase() ?? "";
  if (PREFIX_MAP[first]) return PREFIX_MAP[first];
  return "OTHERS";
}

export const CORE_CATEGORIES = [
  "TERMINAL",
  "CLIP",
  "CONNECTOR",
  "CABLE",
  "TAPE",
  "TUBE",
  "SLEEVE",
  "GROMMET",
  "SEAL",
  "SEALER",
  "GREASE",
  "LABEL",
  "PROTECTOR",
  "HEAT SHRINK",
  "PLUG",
  "OTHERS",
];
