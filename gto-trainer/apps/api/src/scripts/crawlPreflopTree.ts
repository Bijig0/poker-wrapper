/**
 * Crawl GTO Wizard's preflop trees into a local SQLite DB, so live preflop
 * answers come from a ~0ms local lookup instead of a 3-8s CDP navigation.
 *
 * Method: the same URL-first navigation + grid scrape that exportPreflopRanges
 * proved out — navigate each node via /solutions URL, wait for a stable grid,
 * validate the URL matches the intended line, store the FULL strategy (every
 * action × 169 hand classes), then enqueue each child node weighted by how
 * often it is reached (product of action frequencies along the path). Nodes
 * are crawled in reach order with a floor, so the spots that actually occur
 * in real play are captured first and vanishingly-rare branches are skipped.
 *
 * Resumable: crawled nodes and the frontier live in the DB; re-running picks
 * up where it stopped. A GTO Wizard daily-limit overlay (429) checkpoints and
 * exits cleanly.
 *
 * Usage (GTO Wizard running with --remote-debugging-port=9222):
 *   bun run src/scripts/crawlPreflopTree.ts --all             # full plan
 *   bun run src/scripts/crawlPreflopTree.ts --set hu --depth 100
 *   bun run src/scripts/crawlPreflopTree.ts --set 6max --depth 100 --floor 0.0005 --budget 2000
 *
 * The crawler pauses the study poller for the duration (both drive the same
 * GTO Wizard window) and restarts it on exit. Don't play with Study Answers
 * on while a crawl is running.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { gtowCdp, SOLUTION_SETS } from "../services/gtowCdp";
import { parseBetLabel } from "../utils/parseBetLabel/parseBetLabel";

// ---- Config ----
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] == null ? "1" : process.argv[++i]!);
}
const FLOOR = parseFloat(args.get("floor") ?? "0.0005"); // min path-reach to crawl a node
const BUDGET = parseInt(args.get("budget") ?? "1000000", 10); // max nodes this run
const NAV_GAP_MS = parseInt(args.get("gap") ?? "1600", 10); // politeness floor between navigations
const API_BASE = process.env.GTOW_API_URL ?? "http://localhost:2000";

/** The crawl plan, in the order the data matters for live play: the sets the
 *  live path actually uses first (HU trees are small — knock them out early). */
const PLAN: { setId: string; depth: number }[] = [
  { setId: "hu", depth: 100 },
  { setId: "6max", depth: 100 },
  { setId: "hu", depth: 150 }, { setId: "hu", depth: 80 }, { setId: "hu", depth: 60 },
  { setId: "hu", depth: 40 }, { setId: "hu", depth: 20 },
  { setId: "6max", depth: 150 }, { setId: "6max", depth: 75 }, { setId: "6max", depth: 50 },
  { setId: "6max", depth: 40 }, { setId: "6max", depth: 20 },
  { setId: "hu-simple", depth: 100 }, { setId: "hu-simple", depth: 150 }, { setId: "hu-simple", depth: 80 },
  { setId: "hu-simple", depth: 60 }, { setId: "hu-simple", depth: 40 }, { setId: "hu-simple", depth: 20 },
  { setId: "6max-complex", depth: 100 },
];

// ---- DB ----
const dataDir = join(import.meta.dir, "..", "..", "data");
mkdirSync(dataDir, { recursive: true });
const db = new Database(join(dataDir, "preflop-db.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS nodes (
    gametype TEXT NOT NULL,
    depth INTEGER NOT NULL,
    line TEXT NOT NULL,
    pos TEXT,
    reach REAL NOT NULL,
    actions TEXT NOT NULL,   -- JSON [{action, rangePct, combos, token}]
    cells TEXT NOT NULL,     -- JSON [{hand, actions: {label: pct}}] in-range only
    terminal INTEGER NOT NULL DEFAULT 0,
    crawled_at INTEGER NOT NULL,
    PRIMARY KEY (gametype, depth, line)
  );
  CREATE TABLE IF NOT EXISTS frontier (
    gametype TEXT NOT NULL,
    depth INTEGER NOT NULL,
    line TEXT NOT NULL,
    spot INTEGER NOT NULL,
    reach REAL NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (gametype, depth, line)
  );
`);
const qHasNode = db.query("SELECT 1 FROM nodes WHERE gametype=? AND depth=? AND line=?");
const qInsertNode = db.query(
  "INSERT OR REPLACE INTO nodes (gametype, depth, line, pos, reach, actions, cells, terminal, crawled_at) VALUES (?,?,?,?,?,?,?,?,?)"
);
const qNextFrontier = db.query(
  "SELECT line, spot, reach, tries FROM frontier WHERE gametype=? AND depth=? ORDER BY reach DESC LIMIT 1"
);
const qUpsertFrontier = db.query(
  "INSERT OR IGNORE INTO frontier (gametype, depth, line, spot, reach) VALUES (?,?,?,?,?)"
);
const qDeleteFrontier = db.query("DELETE FROM frontier WHERE gametype=? AND depth=? AND line=?");
const qBumpTries = db.query("UPDATE frontier SET tries = tries + 1, reach = reach * 0.5 WHERE gametype=? AND depth=? AND line=?");
const qCounts = db.query(
  "SELECT (SELECT COUNT(*) FROM nodes WHERE gametype=? AND depth=?) AS done, (SELECT COUNT(*) FROM frontier WHERE gametype=? AND depth=?) AS todo"
);

// ---- Helpers ----
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Action label → URL token (mirrors actionToken's encoding). */
function labelToToken(label: string): string | null {
  const b = parseBetLabel(label);
  if (!b) return null;
  if (b.kind === "fold") return "F";
  if (b.kind === "check") return "X";
  if (b.kind === "call") return "C";
  if (b.kind === "allin") return "RAI"; // the app's literal all-in URL token (not R<bb>)
  if (b.amount == null) return null; // sized action without a bb amount — can't encode
  const n = Math.round(b.amount * 100) / 100;
  return `R${n}`;
}

/** Pause/resume the study poller around the crawl — both drive one window. */
async function setPoller(on: boolean): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/study-poller/${on ? "start" : "stop"}`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* API not running — nothing to pause */
  }
}

interface GridNode {
  position: string | null;
  url: string;
  actions: { action: string; rangePct: number | null; combos: number | null }[];
  cells: { hand: string; inRange: boolean; actions: Record<string, number> }[];
}

/** Wait until the grid is stable on the intended line, or report why not. */
async function waitForGrid(
  gametype: string,
  line: string,
  spot: number,
  // Generous: a set-switch first-load can take 20s+; terminals and healthy
  // nodes exit early anyway, so only genuine failures pay the full window.
  timeoutMs = 40000
): Promise<{ ok: true; node: GridNode } | { ok: false; terminal?: boolean; error: string }> {
  const t0 = Date.now();
  let prev = "";
  // What the page looked like on the last URL-matched poll — a fold-closing
  // line renders the strip but never an active preflop node, and a genuine
  // failure needs its final state in the log to be diagnosable at all.
  let lastSeen: { taken: number; activeTst: string | null; pos: string | null; nActions: number; nCells: number } | null = null;
  // A hand ENDED by a closing fold settles into one of two shapes and stays
  // there — count consecutive URL-matched polls showing it so we can call it
  // a terminal in seconds instead of burning the whole timeout:
  //  (a) nothing renders at all (HU trees): no strip, no legend, no active;
  //  (b) the strip renders but the LAST TAKEN node stays active (6max trees):
  //      active spot === spot-1 while the line's final token is a fold.
  const lastToken = line.split("-").pop() ?? "";
  let terminalShapePolls = 0;
  while (Date.now() - t0 < timeoutMs) {
    const node = (await gtowCdp.readNodeStrategy().catch(() => null)) as GridNode | null;
    // Everything below is gated on the URL already matching the intended
    // line — before that, any overlay/active-node signal is from the STALE
    // previous page still unloading, and trusting it mislabels this node.
    const params = new URLSearchParams(node?.url.split("?")[1] ?? "");
    const urlOk =
      node != null &&
      (params.get("preflop_actions") ?? "") === line &&
      params.get("history_spot") === String(spot) &&
      params.get("gametype") === gametype;

    const blocker = await gtowCdp.studyBlocker().catch(() => ({ blocked: false as const }));
    if (blocker.blocked && "code" in blocker && blocker.code === "429") {
      return { ok: false, error: "429" }; // global — honor regardless of URL
    }

    if (urlOk) {
      // A line whose last action CLOSES preflop leaves a postflop node
      // active — a terminal of the preflop tree, not an error.
      const state = await gtowCdp.readNodeState().catch(() => null);
      lastSeen = {
        taken: state?.taken.length ?? 0,
        activeTst: state?.active.tst ?? null,
        pos: node!.position,
        nActions: node!.actions.length,
        nCells: node!.cells.length,
      };
      if (state?.active.tst && !state.active.tst.includes("_preflop_")) {
        return { ok: false, terminal: true, error: "active node is postflop — preflop line is complete" };
      }
      if (blocker.blocked && /no solution for this spot/i.test(("message" in blocker && blocker.message) || "")) {
        // Off the real tree (a size we mis-encoded, or a branch the library
        // doesn't carry) — record as terminal so we never retry it.
        return { ok: false, terminal: true, error: "no solution at this node" };
      }
      const fp = `${node!.position}|${node!.actions.map((a) => `${a.action}${a.rangePct}`).join(",")}|${node!.cells.length}`;
      if (node!.position && node!.actions.length > 0 && node!.cells.length >= 100 && fp === prev) {
        return { ok: true, node: node! };
      }
      prev = fp;

      // Early terminal exit: the ended-hand shapes are stable states, so a
      // few consecutive settled polls are proof — no need to burn the full
      // timeout on every closing-fold line in the tree.
      const activeSpotM = (state?.active.tst ?? "").match(/^hs_(\d+)_/);
      const activeSpot = activeSpotM ? Number(activeSpotM[1]) : null;
      // A ROOT can never be a terminal, and the first load after a solution-
      // set switch shows a blank page long enough to fake the empty shape —
      // that combination stored hu-simple roots as terminals and "completed"
      // whole sets at 1 node. Empty shape: never at root, and only after the
      // page has had a long, stable look at it.
      const emptyShape =
        spot > 0 && state?.active.tst == null && node!.actions.length === 0 && (state?.taken.length ?? 0) === 0;
      // In a genuinely ENDED hand every token is an applied (taken) action;
      // a slow set-load can leave an earlier card active with the strip only
      // partially applied — without the taken===spot check that false-fires
      // and amputates the whole subtree (bit us on 6max Complex's "F").
      const lastNodeShape =
        lastToken === "F" && activeSpot != null && activeSpot === spot - 1 && (state?.taken.length ?? -1) === spot;
      if ((emptyShape && Date.now() - t0 > 15000) || (lastNodeShape && Date.now() - t0 > 5000)) {
        if (++terminalShapePolls >= 3) {
          return {
            ok: false, terminal: true,
            error: `hand ends here (${emptyShape ? "nothing renders" : "last taken node stays active"})`,
          };
        }
      } else {
        terminalShapePolls = 0;
      }
    }
    await sleep(500);
  }
  // Timed out. A line that ENDS the hand (a closing fold, or a jam-call with
  // nothing after it in this view) renders NO strip, NO legend, and NO active
  // node for the whole window — the URL held but the page has nothing to
  // show. That's a terminal of the tree, not a failure worth retrying.
  // (Observed shape: pos=null actions=0 cells=169 taken=0 active=null.)
  // Never at the root — a blank root is a still-loading set, not a terminal.
  if (spot > 0 && lastSeen && lastSeen.activeTst == null && lastSeen.nActions === 0) {
    return { ok: false, terminal: true, error: "hand ends here (no node renders on this line)" };
  }
  // Shape (b) at timeout, in case it never held 3 consecutive polls.
  {
    const m = (lastSeen?.activeTst ?? "").match(/^hs_(\d+)_/);
    if (lastToken === "F" && m && Number(m[1]) === spot - 1 && lastSeen?.taken === spot) {
      return { ok: false, terminal: true, error: "hand ends here (last taken node stays active)" };
    }
  }
  const diag = lastSeen
    ? `pos=${lastSeen.pos} actions=${lastSeen.nActions} cells=${lastSeen.nCells} taken=${lastSeen.taken} active=${lastSeen.activeTst}`
    : "URL never matched (navigation didn't land)";
  return { ok: false, error: `grid never stabilized [${diag}]` };
}

/** Crawl one (set, depth) until its frontier is exhausted or budget is spent. */
async function crawlSet(setId: string, depth: number, budget: { left: number }): Promise<"done" | "budget" | "429"> {
  const set = SOLUTION_SETS.find((s) => s.id === setId);
  if (!set) throw new Error(`Unknown set: ${setId}`);
  const gametype = set.gametype;

  // seed the root (empty line, spot 0) unless already crawled
  if (!qHasNode.get(gametype, depth, "") ) qUpsertFrontier.run(gametype, depth, "", 0, 1);

  let lastNavAt = 0;
  for (;;) {
    if (budget.left <= 0) return "budget";
    const next = qNextFrontier.get(gametype, depth) as { line: string; spot: number; reach: number; tries: number } | null;
    if (!next) return "done";
    const { line, spot, reach, tries } = next;

    if (tries >= 3) {
      console.log(`  [skip] ${line || "(root)"} — failed ${tries}x, dropping`);
      qDeleteFrontier.run(gametype, depth, line);
      continue;
    }

    // politeness gap between navigations
    const wait = NAV_GAP_MS - (Date.now() - lastNavAt);
    if (wait > 0) await sleep(wait);
    lastNavAt = Date.now();
    budget.left--;

    await gtowCdp.navigateToNode(gametype, depth, line, spot);
    await sleep(900);
    const res = await waitForGrid(gametype, line, spot);

    if (!res.ok && res.error === "429") return "429";
    if (!res.ok && res.terminal) {
      qInsertNode.run(gametype, depth, line, null, reach, "[]", "[]", 1, Date.now());
      qDeleteFrontier.run(gametype, depth, line);
      continue;
    }
    if (!res.ok) {
      console.log(`  [retry] ${line || "(root)"} — ${res.error}`);
      qBumpTries.run(gametype, depth, line);
      continue;
    }

    const node = res.node;
    // store the full node strategy
    const actionsOut = node.actions.map((a) => ({ ...a, token: labelToToken(a.action) }));
    const cellsOut = node.cells
      .filter((c) => c.inRange || Object.keys(c.actions).length > 0)
      .map((c) => ({ hand: c.hand, actions: c.actions }));
    qInsertNode.run(
      gametype, depth, line, node.position, reach,
      JSON.stringify(actionsOut), JSON.stringify(cellsOut), 0, Date.now()
    );
    qDeleteFrontier.run(gametype, depth, line);

    // enqueue children in reach order
    let enq = 0;
    for (const a of actionsOut) {
      if (a.token == null) continue;
      const freq = (a.rangePct ?? 0) / 100;
      const childReach = reach * freq;
      if (childReach < FLOOR) continue;
      const childLine = line ? `${line}-${a.token}` : a.token;
      if (qHasNode.get(gametype, depth, childLine)) continue;
      qUpsertFrontier.run(gametype, depth, childLine, spot + 1, childReach);
      enq++;
    }
    const counts = qCounts.get(gametype, depth, gametype, depth) as { done: number; todo: number };
    console.log(
      `  [${counts.done} done / ${counts.todo} todo] ${node.position} @ ${line || "(root)"} — ` +
      `${node.actions.map((a) => `${a.action} ${a.rangePct ?? "?"}%`).join(" · ")} (+${enq} children, reach ${(reach * 100).toFixed(3)}%)`
    );
  }
}

// ---- Main ----
const single = args.has("set") || args.has("depth");
const plan = single
  ? [{ setId: args.get("set") ?? "6max", depth: parseInt(args.get("depth") ?? "100", 10) }]
  : PLAN;

if (!args.has("all") && !single) {
  console.log("Pass --all for the full plan, or --set <id> --depth <bb> for one crawl.");
  console.log(`Plan: ${PLAN.map((p) => `${p.setId}@${p.depth}`).join(", ")}`);
  process.exit(0);
}

if (!(await gtowCdp.isConnected())) {
  console.error("GTO Wizard isn't reachable over CDP (launch it with --remote-debugging-port=9222).");
  process.exit(1);
}

console.log(`Crawl plan: ${plan.map((p) => `${p.setId}@${p.depth}`).join(", ")}  (floor ${FLOOR}, budget ${BUDGET}, gap ${NAV_GAP_MS}ms)`);
console.log("Pausing the study poller for the duration…");
await setPoller(false);
const restore = async () => { console.log("Restarting the study poller…"); await setPoller(true); };
process.on("SIGINT", async () => { await restore(); process.exit(130); });

const budget = { left: BUDGET };
try {
  for (const step of plan) {
    console.log(`\n=== ${step.setId} @ ${step.depth}bb ===`);
    const out = await crawlSet(step.setId, step.depth, budget);
    if (out === "429") {
      console.log("\nGTO Wizard's daily browsing limit hit — checkpointed. Re-run to resume when it resets.");
      break;
    }
    if (out === "budget") {
      console.log(`\nNode budget spent (${BUDGET}) — checkpointed. Re-run to continue.`);
      break;
    }
    console.log(`=== ${step.setId} @ ${step.depth}bb complete ===`);
  }
} finally {
  await restore();
}
