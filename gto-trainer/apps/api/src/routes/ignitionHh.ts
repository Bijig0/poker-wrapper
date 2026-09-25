/**
 * GET /api/ignition-hh/:id[?refresh=1] — Ignition's own record of a hand read into our terms, with its check against
 * the archived copy (services/hhCheck). Opening a hand records its verdict; retrying a missing record is the checker's
 * job, so a failed fetch here changes nothing.
 */
import { Hono } from "hono";
import { compareRecord, freshCheck, hhCheckStore, nextCheck } from "../services/hhCheck";
import { fetchIgnitionRecord } from "../services/ignitionRecord";
import { parseIgnitionHh } from "../utils/ignitionHh/ignitionHh";
import { archivedByClientHandId, isIgnitionHandId } from "./dashboard";

const app = new Hono();

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
