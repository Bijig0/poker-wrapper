/**
 * MACHINE LOAD (2026-10-07). The latency audit found that the answers over the 15 s clock come from the study API's
 * event loop FREEZING while this machine is busy (test suites, tsc, replay gates, research runs) — not GTO Wizard.
 * The API says how loaded it is at GET <api>/api/load (memory-only, never gated):
 *   { ok: true, at, verdict: "ok" | "warn" | "heavy", reasons: string[],
 *     loop: { stalls1m, stalls5m, maxMs5m, blockedMs5m, lastStallAt }, machine: { cpuPct, heavy: [{ name, pid, cpuPct }] },
 *     sessionLive }
 * The wrapper reads it with its 15 s health check (session.ts healthLoop → /state health.load → the panel's header
 * chip) and in the preflight (an OPTIONAL "Machine load" row: it never blocks a start). A failed fetch, an API without
 * the route or a reply of another shape = not measured: no warning, never an error.
 */
import { strftime } from "./clock";
import { API } from "./sessions";

export type LoadVerdict = "ok" | "warn" | "heavy";
export type Load = { verdict: LoadVerdict; text: string; at: number | null };

export const LOAD_ADVICE = "close test runs / wait for the API to settle before starting";

const VERDICTS: LoadVerdict[] = ["ok", "warn", "heavy"];

/** The reasons in one line. The API's own `reasons` when it gives any, else what its numbers say. */
function reasonsText(j: any): string {
  const rs = Array.isArray(j.reasons) ? j.reasons.filter((r: unknown) => typeof r === "string" && r.trim()) : [];
  if (rs.length) return rs.join(" · ");
  const out: string[] = [];
  const loop = j.loop || {};
  if (Number(loop.maxMs5m) >= 1000) {
    const at = Number(loop.lastStallAt) > 0 ? ` (last at ${strftime("%H:%M", Number(loop.lastStallAt) / 1000)})` : "";
    out.push(`API froze up to ${Math.round(Number(loop.maxMs5m) / 1000)} s in the last 5 min${at}`);
  }
  for (const p of ((j.machine || {}).heavy || []).slice(0, 2)) {
    if (p && p.name) out.push(`${p.name} using ${Math.round(Number(p.cpuPct) || 0)}% CPU`);
  }
  const cpu = (j.machine || {}).cpuPct;
  if (!out.length && typeof cpu === "number") out.push(`CPU ${Math.round(cpu)}%`);
  return out.join(" · ");
}

/** The reply as the panel and the preflight use it, or null when it is not a load reply. */
export function parseLoad(j: any): Load | null {
  if (!j || typeof j !== "object" || j.ok !== true || !VERDICTS.includes(j.verdict)) return null;
  return { verdict: j.verdict, text: reasonsText(j), at: typeof j.at === "number" ? j.at : null };
}

export async function realFetchLoad(timeoutS = 3.0): Promise<Load | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutS * 1000);
  try {
    const r = await fetch(`${API()}/api/load`, { signal: ctl.signal });
    return r.ok ? parseLoad(await r.json()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Swappable for tests. */
export const loadDeps = { fetchLoad: realFetchLoad };

/** The preflight's optional row. Never required; ok only on a measured "ok" or when not measured at all. */
export function loadRow(l: Load | null): Record<string, any> {
  const base = { id: "load", label: "Machine load", required: false };
  if (!l) return { ...base, ok: true, level: "unknown", detail: "not measured — the study API did not answer /api/load" };
  if (l.verdict === "ok") return { ...base, ok: true, level: "ok", detail: l.text ? `quiet · ${l.text}` : "quiet" };
  const what = l.verdict === "heavy" ? "HEAVY" : "busy";
  return { ...base, ok: false, level: l.verdict,
           detail: `${what}${l.text ? ` — ${l.text}` : ""} · answers may run past the clock: ${LOAD_ADVICE}` };
}
