import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { buildPreflopTokens3max } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { chartFor, fetchNode, walk3max, HRC3MAX_BASE } from "../services/hrc3max";
import { missQueue, SNAP_NOTE, type MissStatus, type MissRef } from "../services/missQueue";
import { allRows, enrichSync, truncateAt } from "./dashboard";

/**
 * /api/dashboard/miss-queue — the preflop miss queue (services/missQueue.ts).
 *
 *   GET  /                 items + stats + the sweep's state
 *   POST /sweep            { source: "archive" | "corpus" }  walk every preflop
 *                          decision of that source through the charts, in the
 *                          background; misses land in the queue
 *   GET  /sweep            the sweep's progress
 *   POST /:id/status       { status, note? }
 *   POST /:id/recheck      re-walk the stored state; a clean walk marks it solved
 *   POST /plan             write the queued items as HRC jobs: one plan file
 *                          per job + a runner queue (hrc_runner_gui.py format)
 */
const app = new Hono();

const REPO = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const CORPUS = join(REPO, "analysis", "pipeline", "limp_study", "corpus_nodes.jsonl");
const PLAN_DIR = join(REPO, "hrc-api", "solves", "threemax_asym", "miss_queue");

const is3Handed = (hand: ParsedHand, heroPos: string | null): boolean => {
  const present = new Set([...Object.values(hand.positions), ...(heroPos ? [heroPos] : [])].map((p) => p.toUpperCase()));
  return present.size === 3 && ["BTN", "SB", "BB"].every((p) => present.has(p));
};

// ---- the sweep ---------------------------------------------------------------

interface SweepState {
  running: boolean;
  source: "archive" | "corpus" | null;
  done: number;
  total: number;
  decisions: number;
  misses: number;
  charts: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}
const sweep: SweepState = { running: false, source: null, done: 0, total: 0, decisions: 0, misses: 0, charts: 0, startedAt: null, finishedAt: null, error: null };

interface Decision { hand: ParsedHand; heroPos: string | null; ref: MissRef }

/** Every hero preflop decision in the archive, as a truncated hand. */
function archiveDecisions(): Decision[] {
  const out: Decision[] = [];
  for (const row of allRows()) {
    const e = enrichSync(row);
    if (!e) continue;
    const hand = e.hand;
    const heroPost = hand.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
    const heroPos = hand.positions[hand.heroSeatId] ?? (heroPost ? (heroPost.type === "post-sb" ? "SB" : "BB") : null);
    if (!is3Handed(hand, heroPos)) continue;
    const seats = Object.keys(hand.positions).length || 3;
    hand.actions.forEach((a, i) => {
      if (a.street !== "preflop" || !a.hero || a.type === "post-sb" || a.type === "post-bb") return;
      // a walk-in is not a decision: everyone else already folded (the
      // wrapper records the BB's "check" when the pot is pushed to him)
      const before = hand.actions.slice(0, i).filter((x) => x.street === "preflop" && x.type !== "post-sb" && x.type !== "post-bb");
      const othersFolded = before.filter((x) => !x.hero && x.type === "fold").length;
      if (othersFolded >= seats - 1) return;
      // capture desyncs are not chart gaps: a BB "decision" with nothing but
      // folds (or nothing at all) in front of it is a walk-in the capture
      // mislabelled; two hero actions in a row is a missed villain action
      const isBB = (heroPos ?? "").toUpperCase() === "BB";
      if (isBB && before.every((x) => x.hero || x.type === "fold")) return;
      if (before.length && before[before.length - 1]!.hero) return;
      const t = truncateAt(hand, i);
      out.push({
        hand: { ...t, currentNode: { ...t.currentNode, toActIsHero: true } },
        heroPos,
        ref: { origin: "archive", dbId: e.dbId, clientHandId: e.clientHandId, handId: hand.handId ?? null, actionIndex: i, ts: e.playedAt ?? null },
      });
    });
  }
  return out;
}

/**
 * Every preflop node in the Zone corpus (analysis/pipeline/limp_study/
 * corpus_nodes.jsonl): the state before each action, with the ACTOR cast as
 * hero so the walk lands on their node — a villain's node the tree lacks is
 * a node hero cannot be answered past either.
 */
function corpusDecisions(): Decision[] {
  if (!existsSync(CORPUS)) throw new Error(`corpus not found: ${CORPUS}`);
  const out: Decision[] = [];
  for (const line of readFileSync(CORPUS, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.street !== "preflop" || !d.hand || !d.pos) continue;
    const h = d.hand as ParsedHand;
    const actorSeat = Number(Object.entries(h.positions).find(([, p]) => String(p).toUpperCase() === String(d.pos).toUpperCase())?.[0] ?? h.currentNode?.toActSeatId ?? NaN);
    if (!Number.isFinite(actorSeat)) continue;
    const hand: ParsedHand = {
      ...h,
      heroSeatId: actorSeat,
      actions: (h.actions ?? []).map((a) => ({ ...a, hero: a.seatId === actorSeat })),
      currentNode: { ...h.currentNode, toActSeatId: actorSeat, toActIsHero: true },
    };
    const heroPos = String(d.pos).toUpperCase();
    if (!is3Handed(hand, heroPos)) continue;
    out.push({ hand, heroPos, ref: { origin: "corpus", handId: d.hand_id ?? h.handId ?? null, actionIndex: d.idx ?? null, ts: null } });
  }
  return out;
}

async function runSweep(source: "archive" | "corpus"): Promise<void> {
  Object.assign(sweep, { running: true, source, done: 0, total: 0, decisions: 0, misses: 0, charts: 0, startedAt: Date.now(), finishedAt: null, error: null });
  try {
    const probe = await fetchNode("ign200_3maxasym_D100_s100_eq", "");
    if (probe === "unreachable") throw new Error(`${HRC3MAX_BASE} is not reachable — the 3-max chart server must be up to sweep`);
    const decisions = source === "archive" ? archiveDecisions() : corpusDecisions();
    // group by chart so the server's fat-doc LRU (3 docs) is not thrashed
    const byChart = new Map<string, { chart: ReturnType<typeof chartFor>; d: Decision }[]>();
    for (const d of decisions) {
      const chart = chartFor(d.hand, d.heroPos);
      const arr = byChart.get(chart.id) ?? [];
      arr.push({ chart, d });
      byChart.set(chart.id, arr);
    }
    sweep.total = decisions.length;
    sweep.charts = byChart.size;
    missQueue.resetOrigin(source);
    for (const [, items] of byChart) {
      for (const { chart, d } of items) {
        const tokens = buildPreflopTokens3max(d.hand, d.heroPos);
        const walk = await walk3max(tokens, (line) => fetchNode(chart.id, line));
        if (!walk.ok && walk.unreachable) throw new Error("chart server became unreachable mid-sweep");
        const kinds = missQueue.observe({ chart, hand: d.hand, heroPos: d.heroPos, tokens, walk, ref: d.ref });
        sweep.decisions++;
        if (kinds.length) sweep.misses++;
        sweep.done++;
      }
    }
  } catch (e) {
    sweep.error = e instanceof Error ? e.message : String(e);
  } finally {
    sweep.running = false;
    sweep.finishedAt = Date.now();
  }
}

// ---- routes ------------------------------------------------------------------------

app.get("/", (c) => {
  const status = (c.req.query("status") ?? "all") as MissStatus | "all";
  return c.json({ ok: true, items: missQueue.list(status), stats: missQueue.stats(), sweep, snapNote: SNAP_NOTE, store: missQueue.path, corpus: existsSync(CORPUS) ? CORPUS : null, planDir: PLAN_DIR });
});

app.get("/sweep", (c) => c.json({ ok: true, sweep }));

app.post("/sweep", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { source?: string };
  const source = b.source === "corpus" ? "corpus" : b.source === "archive" ? "archive" : null;
  if (!source) return c.json({ ok: false, error: "source must be archive or corpus" }, 400);
  if (sweep.running) return c.json({ ok: false, error: `a ${sweep.source} sweep is already running`, sweep }, 409);
  void runSweep(source);
  return c.json({ ok: true, sweep });
});

app.post("/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const b = (await c.req.json().catch(() => ({}))) as { status?: string; note?: string | null };
  const status = b.status as MissStatus;
  if (!["open", "queued", "solved", "dismissed"].includes(status)) return c.json({ ok: false, error: "bad status" }, 400);
  const ok = missQueue.setStatus(id, status, b.note ?? null);
  return c.json({ ok, item: missQueue.get(id) });
});

/** One status for every item that shares a suggested job — the runner's unit. */
app.post("/status-by-job", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { jobId?: string; status?: string; note?: string | null };
  const status = b.status as MissStatus;
  if (!b.jobId || !["open", "queued", "solved", "dismissed"].includes(status)) return c.json({ ok: false, error: "jobId and a valid status are required" }, 400);
  let n = 0;
  for (const it of missQueue.list("all")) if (it.job?.id === b.jobId && missQueue.setStatus(it.id, status, b.note ?? null)) n++;
  return c.json({ ok: true, updated: n });
});

/** Re-walk the stored state through today's charts; an exact walk means solved. */
app.post("/:id/recheck", async (c) => {
  const id = Number(c.req.param("id"));
  const it = missQueue.get(id);
  if (!it) return c.json({ ok: false, error: `no item #${id}` }, 404);
  const st = it.state;
  const seatOf: Record<string, number> = { BTN: 1, SB: 2, BB: 3 };
  const positions: Record<number, string> = { 1: "BTN", 2: "SB", 3: "BB" };
  const stacks: Record<number, number> = {};
  for (const [p, v] of Object.entries(st.stacksBB)) if (v != null) stacks[seatOf[p]!] = v;
  const heroSeat = st.heroPos ? seatOf[st.heroPos.toUpperCase()] ?? 1 : 1;
  const hand = {
    handId: 0, bbCents: st.bbCents ?? undefined, heroSeatId: heroSeat, heroCards: [], board: [], street: "preflop", actions: [],
    liveSeats: [1, 2, 3], committed: {}, potByStreet: {}, positions, stacks,
    currentNode: { street: "preflop", toActSeatId: heroSeat, toActIsHero: true, pot: 1.5, toCall: 1, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;
  const chart = chartFor(hand, st.heroPos);
  const walk = await walk3max(st.tokens, (line) => fetchNode(chart.id, line));
  if (!walk.ok && walk.unreachable) return c.json({ ok: false, error: `${HRC3MAX_BASE} is not reachable` }, 503);
  const far = walk.ok ? walk.repaired.filter((r) => {
    const a = parseFloat(r.from.replace(/^R/, "")), b = parseFloat(r.to.replace(/^R/, ""));
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(Math.log(a / b)) >= SNAP_NOTE;
  }) : [];
  const exact = walk.ok && far.length === 0 && chart.beyondLadder == null;
  if (exact) missQueue.setStatus(id, "solved", `re-checked ${new Date().toISOString().slice(0, 16)}: exact on ${chart.id}`);
  return c.json({ ok: true, exact, chart: chart.id, walk: walk.ok ? { tokens: walk.tokens, repaired: walk.repaired } : { reason: walk.reason }, item: missQueue.get(id) });
});

/** Write the queued (or the given) items as HRC jobs the runner can pick up. */
app.post("/plan", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { ids?: number[] };
  const items = (b.ids?.length ? b.ids.map((i) => missQueue.get(i)).filter((x): x is NonNullable<typeof x> => x != null) : missQueue.list("queued")).filter((x) => x.job);
  if (!items.length) return c.json({ ok: false, error: "nothing queued with a suggested job" }, 400);
  mkdirSync(PLAN_DIR, { recursive: true });
  const seen = new Set<string>();
  const jobs: any[] = [];
  for (const it of items) {
    const j = it.job!;
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    const { change, ...job } = j;
    jobs.push({ ...job, missQueue: { change, items: items.filter((x) => x.job?.id === j.id).map((x) => x.id) } });
  }
  const planAll = join(PLAN_DIR, "plan_miss_queue.json");
  writeFileSync(planAll, JSON.stringify(jobs, null, 1));
  const queue = {
    name: `miss queue · ${jobs.length} job(s) · ${new Date().toISOString().slice(0, 10)}`,
    jobs: jobs.map((j) => {
      const one = join(PLAN_DIR, `${j.id}.plan.json`);
      writeFileSync(one, JSON.stringify([j], null, 1));
      return {
        id: j.id,
        cmd: ["bun", "run", "scripts/threeMaxGrid.ts", `solves/threemax_asym/miss_queue/${j.id}.plan.json`],
        done_if: `solves/threemax_grid/${j.id}.charts.json`,
      };
    }),
  };
  const queuePath = join(PLAN_DIR, "queue_miss_queue.json");
  writeFileSync(queuePath, JSON.stringify(queue, null, 1));
  return c.json({ ok: true, jobs: jobs.length, plan: planAll, queue: queuePath, ids: jobs.map((j) => j.id) });
});

export default app;
