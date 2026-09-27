/**
 * GET /api/ignition-hh/:id[?refresh=1] — Ignition's own record of a hand read into our terms, with its check against
 * the archived copy (services/hhCheck). Opening a hand records its verdict; retrying a missing record is the checker's
 * job, so a failed fetch here changes nothing.
 */
import { Hono } from "hono";
import { compareRecord, freshCheck, hhCheckStore, nextCheck } from "../services/hhCheck";
import { fetchIgnitionRecord } from "../services/ignitionRecord";
import { parseIgnitionHh } from "../utils/ignitionHh/ignitionHh";
import { allRows, archivedByClientHandId, isIgnitionHandId } from "./dashboard";
import { autoExecOf } from "../utils/autoExec/autoExec";

const app = new Hono();

/**
 * GET /api/ignition-hh/session/:sid — EVERY HAND OF A SESSION AGAINST IGNITION (2026-09-26, Brady: "per hand record,
 * once a hand is done the diff should be done automatically, so we can diagnose and debug"). The checker
 * (services/hhCheck) already diffs each finished hand; this reads its verdicts back for one declared session, worst
 * first: hands whose recording was wrong BEFORE hero's last action (what the answers were built on), then those wrong
 * only after it, then pending / unavailable / not yet queued. Each row also carries the hand's auto-execute verdict.
 */
app.get("/session/:sid", (c) => {
  const sid = c.req.param("sid");
  const store = hhCheckStore();
  const needle = `"sessionId": ${JSON.stringify(sid)}`;
  const hands = allRows().filter((r) => r.data.includes(needle)).map((r) => {
    let raw: Record<string, any> = {};
    try { raw = JSON.parse(r.data); } catch { /* an unreadable row still gets a line */ }
    const cid = typeof raw.clientHandId === "string" ? raw.clientHandId : null;
    const check = cid ? store.get(cid) : null;
    const state = !check ? "unchecked" : check.status === "mismatch" ? (check.throughOk ? "after-hero" : "before-hero") : check.status;
    const ax = autoExecOf(raw);
    return {
      dbId: r.rowid, clientHandId: cid, playedAt: raw.playedAt ?? null, heroCards: raw.heroCards ?? [], tableSlot: raw.tableSlot ?? null,
      state, checkedAt: check?.checkedAt ?? null, error: check?.error ?? null,
      diffs: check?.diffs.length ?? 0, through: (check?.through ?? []).slice(0, 4), firstDiffs: (check?.diffs ?? []).slice(0, 4),
      kinds: [...new Set((check?.diffs ?? []).map((d) => d.kind))],
      autoExec: ax ? { verdict: ax.verdict, label: ax.label } : null,
    };
  });
  const ORDER = ["before-hero", "after-hero", "pending", "unavailable", "unchecked", "match"];
  hands.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (a.playedAt ?? 0) - (b.playedAt ?? 0));
  const counts: Record<string, number> = {};
  for (const h of hands) counts[h.state] = (counts[h.state] ?? 0) + 1;
  // which kinds of difference, in how many hands (before hero / after), to see a pattern at a glance
  const kinds: Record<string, { beforeHero: number; afterHero: number }> = {};
  for (const h of hands) for (const k of h.kinds) {
    const e = (kinds[k] ??= { beforeHero: 0, afterHero: 0 });
    if (h.state === "before-hero") e.beforeHero++; else e.afterHero++;
  }
  return c.json({ ok: true, sessionId: sid, hands: hands.length, counts, kinds, rows: hands });
});

app.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!isIgnitionHandId(id)) return c.json({ ok: false, error: `not an Ignition hand number: ${id}` }, 400);
  const store = hhCheckStore();
  const rec = await fetchIgnitionRecord(id, { refresh: c.req.query("refresh") === "1" });
  if (!rec.ok) return c.json({ ok: false, reason: rec.reason, error: rec.error, check: store.get(id) });
  const found = { ok: true, handId: id, fetchedAt: rec.fetchedAt, cached: rec.cached };
  const archived = archivedByClientHandId(id);
  if (!archived) return c.json({ ...found, ignition: parseIgnitionHh(rec.body), dbId: null, check: null });
  const { ignition, diffs, through } = compareRecord(rec.body, archived);
  const now = Date.now();
  const check = nextCheck(store.get(id) ?? freshCheck(archived, now), { kind: "compared", diffs, through }, now);
  store.save(check);
  return c.json({ ...found, ignition, dbId: archived.dbId, check });
});

export default app;
