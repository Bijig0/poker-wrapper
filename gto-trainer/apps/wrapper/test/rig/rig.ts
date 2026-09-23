/**
 * Is the thing on the other end of WRAPPER_URL actually the Ignition test rig? (port of tests/rig.py, 2026-09-24)
 *
 * THE PORT IS SHARED (2026-09-20): the rig's default :7701 was also the retired CoinPoker wrapper's panel port, and
 * when that one was running every fixture came back HTTP 404 — sixty failures that said nothing about the reader.
 * Two fields in /state settle it: only the Ignition wrapper publishes `fakeTable` at all, and only a rig started
 * with --fake has a fake table to load. A tier that cannot find its rig exits 2 (UNAVAILABLE), never 1 (FAIL).
 *
 * Shared by the rig clients here (spotAudit.ts, answerSuite.ts).
 */
import { pyStr } from "../../src/py";

export const WRAPPER = (process.env.WRAPPER_URL || "http://127.0.0.1:7701").replace(/\/$/, "");
export const API = "http://127.0.0.1:2000";

/** JSON in, JSON out; an HTTP error with a JSON body is returned as that body (feed-spot reports 4xx that way). */
export async function req(url: string, body?: unknown, timeoutS = 30): Promise<any> {
  const r = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutS * 1000),
  });
  const text = await r.text();
  try {
    return JSON.parse(text || "{}");
  } catch {
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    throw new Error(`${url}: not JSON (${text.slice(0, 80)})`);
  }
}

/** null when `base` is the Ignition fake rig, else the sentence to print. */
export async function rigCheck(base: string, timeoutS = 5): Promise<string | null> {
  let st: any;
  try {
    st = await req(base.replace(/\/$/, "") + "/state", undefined, timeoutS);
  } catch (e: any) {
    return `wrapper not reachable on ${base} - launch the Poker Wrapper test rig first (${pyStr(e?.message ?? e)})`;
  }
  if (!st || typeof st !== "object" || Array.isArray(st) || !("fakeTable" in st)) {
    return `${base} is answering, but it is NOT the Poker Wrapper (no fakeTable in /state). Start the test rig ` +
      `(gto-trainer/study-tool.pyw's replacement: study-tool.vbs), or point WRAPPER_URL at it.`;
  }
  if (!st.fakeTable && !st.fakeRig) {
    return `${base} is the Poker Wrapper but NOT a test rig (--fake): it has no fake table to load, so this tier ` +
      `would test nothing. 7700 is the live rig.`;
  }
  return null;
}

export const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

export interface Check { label: string; ok: boolean; detail: string }

export class Case {
  checks: Check[] = [];
  notes: [string, string][] = [];
  constructor(public name: string) {}
  check(ok: unknown, label: string, detail = ""): void {
    this.checks.push({ label, ok: !!ok, detail });
  }
  /** A documented limitation: shown every run, never a failure. */
  known(label: string, detail = ""): void {
    this.notes.push([label, detail]);
  }
  get failed(): Check[] {
    return this.checks.filter((c) => !c.ok);
  }
}
