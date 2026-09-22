/**
 * fx — the house USD→AUD rate, for DISPLAY only.
 *
 * The account is USD and every stored amount is USD cents. AUD is a conversion
 * applied when a number is shown, with the rate's date shown beside it, and it is
 * never persisted as an amount — a converted figure written down would masquerade
 * as a measurement the next time anyone read it.
 *
 * The rate itself is a dated fact: fetched at most once a day from a free source
 * (Frankfurter serves the ECB reference rate, no key), cached in data/fx.json, and
 * reported STALE once it is older than a few days so a dead source cannot quietly
 * freeze the conversion at last week's rate.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./ledger";

export interface FxRate {
  base: "USD";
  quote: "AUD";
  rate: number;
  /** when the rate was fetched (ms) */
  at: number;
  /** the source's own date for the rate, when it gives one */
  asOf: string | null;
  source: string;
}

const CACHE = join(DATA_DIR, "fx.json");
const SOURCE = process.env.FX_URL ?? "https://api.frankfurter.app/latest?from=USD&to=AUD";
const REFRESH_MS = 24 * 3600_000;
const STALE_MS = 5 * 24 * 3600_000;

let mem: FxRate | null = null;
let inflight: Promise<FxRate | null> | null = null;

function readCache(): FxRate | null {
  if (mem) return mem;
  try {
    if (!existsSync(CACHE)) return null;
    const j = JSON.parse(readFileSync(CACHE, "utf-8"));
    if (typeof j?.rate === "number" && j.rate > 0) mem = j as FxRate;
  } catch { /* unreadable cache: fetch again */ }
  return mem;
}

async function fetchRate(): Promise<FxRate | null> {
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const rate = Number(j?.rates?.AUD ?? j?.rate);
    if (!(rate > 0)) return null;
    const out: FxRate = { base: "USD", quote: "AUD", rate, at: Date.now(), asOf: typeof j?.date === "string" ? j.date : null, source: new URL(SOURCE).host };
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(out, null, 2));
    mem = out;
    return out;
  } catch {
    return null;
  }
}

/** The current rate with its provenance, refreshing in the background when a day
 *  old. Returns whatever is known immediately — a page never waits on the ECB. */
export function fxRate(): { rate: FxRate | null; stale: boolean } {
  const cur = readCache();
  const age = cur ? Date.now() - cur.at : Infinity;
  if (age > REFRESH_MS && !inflight) inflight = fetchRate().finally(() => { inflight = null; });
  return { rate: cur, stale: !cur || age > STALE_MS };
}

/** USD cents → AUD cents at the current rate, or null when there is no rate. Display only. */
export function toAudCents(usdCents: number | null | undefined): number | null {
  const { rate } = fxRate();
  if (usdCents == null || !rate) return null;
  return Math.round(usdCents * rate.rate);
}
