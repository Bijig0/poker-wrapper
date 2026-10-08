/**
 * Pin the postflop menu switches for one test file (2026-10-08 evening: HU_FIXED_MENU=f, THREEWAY_MENU=c and MENU_POT=net
 * became the defaults). Files whose cases were written for the menus before — heads-up B (33/75 | 60) or AUTOMATIC,
 * three-way B, sizes on the gross pot — call `useMenus(OLD_MENUS)` (or with their own HU_FIXED_MENU) so they keep testing
 * those rules; the new menus have their own file (services/gtowApi.menus.test.ts).
 */
import { afterAll, beforeAll } from "bun:test";

export const MENU_SWITCHES = ["HU_FIXED_MENU", "THREEWAY_MENU", "MENU_POT", "THREEWAY_NODE_TIMEOUT_MS"] as const;
export type MenuEnv = Partial<Record<(typeof MENU_SWITCHES)[number], string>>;
/** the request of fada815: heads-up B, three-way B, the gross pot */
export const OLD_MENUS: MenuEnv = { HU_FIXED_MENU: "b", THREEWAY_MENU: "b", MENU_POT: "gross" };

/** Set `env` for the file (beforeAll), restore every switch as it was (afterAll). */
export function useMenus(env: MenuEnv): void {
  const before: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of MENU_SWITCHES) before[k] = process.env[k];
    for (const k of MENU_SWITCHES) { const v = env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  });
  afterAll(() => {
    for (const k of MENU_SWITCHES) { const v = before[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  });
}
