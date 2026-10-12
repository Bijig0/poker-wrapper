/**
 * Fill the stored hand nodes (services/handNodeStore.ts) for every finished hand now, in its own process, instead of
 * waiting for the API's idle builder (services/handNodeBuilder.ts) — the same requests, without the gaps a shared loop
 * needs. Stops when a session goes live (run it again after). Needs the API's environment and, for the 3-max charts,
 * the chart server:
 *
 *   HAND_FACTS_DB_PATH=<root>\poker.sqlite bun --env-file=..\..\..\config\local.env src/scripts/buildHandNodes.ts
 *
 * (HAND_FACTS_DB_PATH: a script keeps hand facts in memory by default, and the AI preflop nodes are read from them.)
 *
 * --rebuild-undrawn: compute again every stored row that drew no node (after a fix or a recovery, e.g.
 * scripts/recoverPreflopKeys.ts) — never the AI preflop path, which can cost GTO Wizard quota.
 */
import { handsViewReady } from "../routes/dashboard";
import { builderDeps, HandNodeBuilder } from "../services/handNodeBuilder";
import { drewNode } from "../services/handNodeStore";

const ready = await handsViewReady();
const rows = builderDeps.rows();
if (!ready || !rows) { console.error("the finished hands could not be read"); process.exit(1); }
const store = builderDeps.store;
const total = rows.length;
const b = new HandNodeBuilder({ ...builderDeps, sleep: async () => {} });
const t0 = Date.now();
if (process.argv.includes("--rebuild-undrawn")) {
  const rows = store.undrawn().filter((r) => r.key !== "preflop-path:ai");
  let drew = 0;
  for (const r of rows) {
    const m = /^answer-node:(\d+)(?::a(\d+))?(:ranges)?$/.exec(r.key);
    const url = m ? `/answer-node?dbId=${r.dbId}&upto=${m[1]}${m[2] ? `&answerId=${m[2]}` : ""}${m[3] ? "&ranges=1" : ""}&fresh=1` : `/preflop-path?dbId=${r.dbId}&fresh=1`;
    await builderDeps.request(url).catch(() => null);
    if (drewNode(store.get(r.dbId, r.key)?.body)) drew++;
  }
  console.log(`rebuilt ${rows.length} rows that drew no node: ${drew} draw one now (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exit(0);
}
console.log(`${total} finished hands, ${store.builtIds().size} built already — ${store.path}`);
for (;;) {
  const before = store.builtIds().size;
  await b.tick();
  const done = store.builtIds().size;
  const s = store.stats();
  console.log(`${new Date().toISOString().slice(11, 19)} built ${done}/${total} · ${s.rows} rows · ${(s.bytes / 1e6).toFixed(1)} MB · ${s.failedHands} hands with a failed node · ${b.last?.stoppedBy ?? ""}`);
  if (b.backoffUntil > Date.now()) { console.error("the chart server is not reachable — stopped"); process.exit(2); }
  if (builderDeps.live()) { console.error("a session is live — stopped (run again after it)"); process.exit(3); }
  if (done === before || done >= total) break;
}
console.log(`done in ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
process.exit(0);
