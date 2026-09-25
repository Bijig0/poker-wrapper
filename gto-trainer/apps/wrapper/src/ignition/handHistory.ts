/**
 * Ignition's own record of one hand, by hand number (our clientHandId), fetched live — the same REST lookup the
 * client's hand-history search makes, so a hand can be checked minutes after it was played instead of a day later.
 * It is NOT clairvoyant: villains' hole cards are blank unless shown at showdown. Also the day's list of hand
 * numbers, which shows the hands the reader never archived.
 *
 * The request runs INSIDE the logged-in poker page, from the client's origin with the client's headers:
 * GET https://games.<site>/poker-api-service/player/handhistory/<cash|zone>/<id>, X-Auth-Token = the session id
 * the client keeps in localStorage.sessionId. Without the X-Brand / X-PokerAPI-* headers the server answers 500.
 * /pokerapi/ is the older route (no sessionId field); zone 404s for a cash hand and vice versa, so all are tried.
 * A found hand never changes, so it is kept on disk and served from there.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../cdp";
import { DATA_DIR } from "../config";
import { S, seams } from "../state";

const FORMATS = ["cash", "zone"] as const;
const PREFIXES = ["/poker-api-service/", "/pokerapi/"];

const dir = () => join(DATA_DIR(), "hand_history");
const cachePath = (id: string) => join(dir(), `${id}.json`);

/** GET each path (relative to the games host) until one answers 2xx; a 404 skips the rest of its group. */
function pageGetJs(groups: string[][]): string {
  return `(async () => {
  const groups = ${JSON.stringify(groups)};
  let tok = localStorage.getItem("sessionId");
  try { tok = JSON.parse(tok).value; } catch (e) {}
  if (!tok) return { ok: false, error: "the poker client has no session (not signed in?)" };
  const host = location.host.split(".");
  host[0] = "games";
  const base = location.protocol + "//" + host.join(".");
  const headers = { "X-Auth-Token": tok, "X-Internal-Login": "true", "Accept": "application/json",
    "X-Brand": "IGN", "X-Territory": "DEFAULT", "X-Client-Type": "desktop", "X-Client-Version": "4.133.00", "X-Client-Language": "en",
    "X-PokerAPI-ClientType": "desktop", "X-PokerAPI-ClientVersion": "4.133.00", "X-PokerAPI-Language": "en", "X-PokerAPI-Site-Id": "140" };
  const tries = [];
  for (const [g, paths] of groups.entries()) for (const path of paths) {
    const url = base + path;
    try {
      const r = await fetch(url, { headers });
      const text = await r.text();
      tries.push({ url, status: r.status, body: r.ok ? undefined : text.slice(0, 200) });
      if (r.ok && text) {
        let body = text;
        try { body = JSON.parse(text); } catch (e) {}
        return { ok: true, group: g, url, body };
      }
      if (r.status === 404) break;
    } catch (e) { tries.push({ url, error: String((e && e.message) || e) }); }
  }
  return { ok: false, tries };
})()`;
}

async function pageGet(groups: string[][]): Promise<Record<string, any>> {
  if (S.fakeMode) return { ok: false, error: "the fake table has no Ignition hand history" };
  const t = await seams.ignitionTarget();
  if (!t) return { ok: false, error: "the Ignition poker client is not open" };
  const [res] = await cdp.commands(t.webSocketDebuggerUrl, [["Runtime.evaluate", {
    expression: pageGetJs(groups), returnByValue: true, awaitPromise: true,
  }]], 45); // Ignition answers in 1-3 s but stalls for 25 s now and then
  const exc = res?.exceptionDetails;
  if (exc) return { ok: false, error: `page error: ${(exc.exception || {}).description || exc.text}` };
  return res?.result?.value ?? { ok: false, error: "no reply from the poker page" };
}

const formatsOf = (format?: string) => (format && (FORMATS as readonly string[]).includes(format) ? [format] : [...FORMATS]);

export async function fetchHandHistory(id: string, opts: { format?: string; refresh?: boolean } = {}): Promise<Record<string, any>> {
  if (!/^\d{5,}$/.test(id)) return { ok: false, error: `not an Ignition hand number: ${JSON.stringify(id)}` };
  if (!opts.refresh && existsSync(cachePath(id))) {
    return { ...JSON.parse(readFileSync(cachePath(id), "utf8")), cached: true };
  }
  const formats = formatsOf(opts.format);
  const out = await pageGet(formats.map((f) => PREFIXES.map((p) => `${p}player/handhistory/${f}/${id}`)));
  if (!out.ok) return { handId: id, ok: false, error: out.error ?? `Ignition returned no hand history for ${id}`, tries: out.tries };
  const rec = { ok: true, handId: id, format: formats[out.group], url: out.url, fetchedAt: new Date().toISOString(), body: out.body };
  mkdirSync(dir(), { recursive: true });
  writeFileSync(cachePath(id), JSON.stringify(rec, null, 1), "utf8");
  return { ...rec, cached: false };
}

/** Every hand Ignition has for this player on a UTC day, per format: [{handId, startTime, gameName, format}]. */
export async function listHandHistory(date: string, opts: { format?: string } = {}): Promise<Record<string, any>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: `date must be YYYY-MM-DD: ${JSON.stringify(date)}` };
  const hands: { handId: string; startTime: string; gameName: string; format: string }[] = [];
  for (const f of formatsOf(opts.format)) {
    const q = `player/handhistory/${f}?date=${date}&startTime=00:00&endTime=23:59`;
    const out = await pageGet([PREFIXES.map((p) => p + q)]);
    if (!out.ok) return { ok: false, date, error: out.error ?? `Ignition returned no ${f} hand list for ${date}`, tries: out.tries };
    for (const h of Array.isArray(out.body) ? out.body : []) hands.push({ handId: String(h.handId), startTime: h.startTime, gameName: h.gameName, format: f });
  }
  return { ok: true, date, hands };
}
