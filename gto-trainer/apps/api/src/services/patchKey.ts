/**
 * The PATCH CHART id for one 6-max table state — ONE rule, shared by the two sides that must agree on it:
 *   - services/patchJobs.ts turns a live approximation into the charts the box queue solves;
 *   - services/hrc6max.ts (chartFor6max) looks the same ids up for every live decision and answers from a solved one.
 * If the two ever computed different ids, a solved patch would sit in the catalog and never answer anything.
 *
 * A patch chart is a 6-max tree solved at one table's own per-seat stacks: `ign200_6max_P_<SEATnn…|EVEN>_o<open>`
 * (e.g. ign200_6max_P_BTN150_BB80_o2), plus `_i|_3b|_4b|_5b<sizes>` when raise sizes were added to a menu level.
 * Two keys per state:
 *   capped — every seat capped at the 100bb baseline, rounded to 5bb (hero always reloads to 100; a deep folder plays
 *            like 100);
 *   exact  — the stacks as dealt, capped at the 150bb ceiling, rounded to 5bb.
 * A seat not dealt counts as 100 (it is absent from the id). An all-100 key is the even chart, which exists, unless
 * sizes are being added (then it is an EVEN patch with a wider menu). Identical keys collapse to one.
 */
export const PATCH_SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
const LEVEL_TAG = ["i", "3b", "4b", "5b"];

const r5 = (x: number) => Math.round(x / 5) * 5;
export const fmtSize = (x: number) => String(x).replace(".", "_");

export interface PatchKey {
  id: string; stacks: Record<string, number>; open: number | "limp"; variant: "capped" | "exact";
  /** SIZE PATCH: raise-to sizes ADDED to a menu level ("0" iso in a limp tree, "1" 3-bet, "2" 4-bet, "3" 5-bet) */
  sizesAdd?: Record<string, number[]>;
}

/** the patch keys for one table state, capped first (0-2 of them: all-100 keys are the even chart) */
export function patchKeys(site: string, stacksBB: Partial<Record<string, number>>, open: number | "limp",
                          sizesAdd?: Record<string, number[]>): PatchKey[] {
  const out: PatchKey[] = [];
  for (const variant of ["capped", "exact"] as const) {
    // limp trees deeper than 100bb do not fit in HRC's memory with our menus (wizard probe, 2026-09-22), so a limp
    // state's exact key is capped at 100 too — and then collapses into the capped key
    const ceil = variant === "capped" || open === "limp" ? 100 : 150;
    const stacks: Record<string, number> = {};
    for (const s of PATCH_SEATS) {
      const raw = stacksBB[s];
      stacks[s] = raw == null ? 100 : Math.max(5, r5(Math.min(raw, ceil)));
    }
    const parts = PATCH_SEATS.filter((s) => stacks[s] !== 100).map((s) => `${s}${stacks[s]}`);
    if (!parts.length && !sizesAdd) continue;
    const sizeTag = sizesAdd ? "_" + Object.entries(sizesAdd).map(([l, v]) => `${LEVEL_TAG[Number(l)] ?? `l${l}`}${v.map(fmtSize).join("_")}`).join("_") : "";
    const id = `${site}_6max_P_${parts.length ? parts.join("_") : "EVEN"}_o${open === "limp" ? "limp" : fmtSize(open)}${sizeTag}`;
    if (!out.some((k) => k.id === id)) out.push({ id, stacks, open, variant, ...(sizesAdd ? { sizesAdd } : {}) });
  }
  return out;
}

/** the id with any size tags removed: `…_o2_5_3b11` → `…_o2_5` (the table + open a size patch belongs to) */
export const patchBase = (id: string): string => id.replace(/(_o(?:limp|\d+(?:_5)?))(?:_(?:i|3b|4b|5b|l\d+)[\d_]+)+$/, "$1");
