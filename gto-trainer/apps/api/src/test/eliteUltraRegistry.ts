/**
 * The two-account pool the routing tests were written against: an Elite account (heads-up postflop only, tried first
 * postflop) and the Ultra primary (tried first preflop, the only one that takes multiway). The seeded registry used to
 * be exactly this; since the GTO Wizard desktop-app account was dropped (2026-10-13) it is the Ultra alone, so the
 * test preload (isolateLiveState.ts) writes THIS registry for the whole run, and a test that wants a registry of its
 * own points GTOW_ACCOUNTS_PATH at one (as gtowAccounts.test.ts and gtowRouting.test.ts do).
 */
import { writeFileSync } from "node:fs";

const row = (id: string, name: string, tier: "elite" | "ultra", multiway: boolean, port: number, order: number, preflopOrder: number) => ({
  id, name, tier, multiway, cdpHost: `127.0.0.1:${port}`, launchHint: "", client: "chrome", profileDir: null,
  enabled: true, order, preflopOrder, priceMonthly: null, notes: "", probeSolId: null, accountEmail: null, accountId: null,
});

/** Write the registry to `path`. */
export function writeEliteUltraRegistry(path: string): void {
  writeFileSync(path, JSON.stringify({ version: 1, accounts: [
    row("secondary", "Elite 1", "elite", false, 9223, 1, 2),
    row("primary", "Ultra", "ultra", true, 9222, 2, 1),
  ] }));
}
