import type { Database } from "bun:sqlite";
import { gtowApi, huMenuMode, menuPotMode, threeWayMenuMode } from "./gtowApi";
import { forgetAnsweredHeroNodes, seedAnsweredHeroNodes, solveAiChain, walkPolicy, type ChainTrace, type ChainTraceNode } from "./aiChain";
import { openStore, solvesDbPath } from "./storePaths";

/**
 * CHECK #13 — REPLAY DETERMINISM (2026-09-27, services/chainChecks). Same capture ⇒ same trees and the same walk. Every
 * live decision stores its whole chain trace (services/solveStore): the spec it was solved from, each street's tree
 * request as sent, and every node GTO Wizard returned. Replaying the spec against a GTO Wizard that can answer ONLY
 * from that recording costs no quota and isolates our half of the answer: if the replay asks for a different tree,
 * walks a different line, or reaches a different node than the live walk did, our code is not deterministic (hidden
 * state, map ordering, time, a memo leaking between hands) — the class of bug this whole ticklist exists to catch.
 *
 * NOT FOR THE LIVE PROCESS: replayTrace swaps gtowApi's network calls for the recording while it runs. It is called by
 * scripts/replayDeterminism.ts, a process of its own (services/replayScheduler starts it once a day when the table is
 * quiet); the API only reads the results table.
 *
 * WHAT THE REPLAY SEEDS (2026-10-14, the audit's finding 6): the replay runs under a hand key of its own, so the live
 * walk's hero narrowing — his earlier action multiplied by the strategy he was ANSWERED with on another tree or SERVED
 * on another plan (aiChain heroAnswered, retree-consistency) — is seeded from the trace before the walk
 * (aiChain.seedAnsweredHeroNodes, the hero-floor A/B harness's mechanism); until then every one of the 16 range-weight
 * fails in replay_checks was hero's seat narrowed by the walking tree instead (8441 / 4923565359 turn SB 210.08 live vs
 * 105.15). A MENU RULE THAT CHANGED since the hand was played (HU_FIXED_MENU, THREEWAY_MENU, MENU_POT — 4923350087's
 * AUTOMATIC trees replayed after the fixed menu landed) makes the request's bet sizes differ and nothing else: that is
 * `note: menu-rule-changed`, not replayable, never a fail.
 *
 * WHAT THE REPLAY RUNS UNDER (2026-10-14): the rules the live walk ran under — the trace's `policy` (aiChain.walkPolicy,
 * recorded since 2026-10-14), set in process.env for the walk and restored after; a trace from before it gets what the
 * trace itself shows (derivedWalkPolicy: the off-tree soft record's mode / weight / temperature and whether a lock was
 * posted, the hero floor's mode — abs when no floor record exists). Seven of the audit's 16 range fails were the
 * off-tree rule alone (played under OFFTREE_RANGE=soft, replayed under the 10-13 blend + lock: 7468 / 4923391721 SB
 * 142.51 live vs 29.65). A live mid-street node lock is replayed as the recording: the child's nodes are the ones read.
 */

export interface ReplayDiff { what: string; live: string; replay: string }
/** ok null = not replayable: the note says why (`menu-rule-changed: …` when only the menu differs — see the header) */
export interface ReplayResult { ok: boolean | null; diffs: ReplayDiff[]; note: string | null }

/** The menu a tree request asked for, seat by seat on its first street: "OOP AUTOMATIC · IP FIXED 33%/75% | 60%". */
export function menuOf(sent: unknown): string {
  type Seat = { position?: string; type?: string; bet_sizes?: string[]; raise_sizes?: string[] };
  const first = (sent as { bet_sizes?: { street_bet_sizes?: { position_bet_sizes?: Seat[] }[] } } | null)?.bet_sizes?.street_bet_sizes?.[0];
  if (!first?.position_bet_sizes?.length) return "?";
  return first.position_bet_sizes.map((p) => `${p.position ?? "?"} ${p.type ?? "?"}${p.bet_sizes?.length ? ` ${p.bet_sizes.join("/")}` : ""}${p.raise_sizes?.length ? ` | ${p.raise_sizes.join("/")}` : ""}`).join(" · ");
}
/** The menu rules in effect for this replay (gtowApi reads them at every tree). */
export const menuRulesNow = (): string => `HU_FIXED_MENU=${huMenuMode()}, THREEWAY_MENU=${threeWayMenuMode()}, MENU_POT=${menuPotMode()}`;

/** The rules a trace from before the policy record (2026-10-14) shows it ran under — only what the trace carries: the
 *  off-tree soft record (OFFTREE_RANGE=soft was the rule 10-06 .. 10-13, the blend since; no `soft` on an off-tree node
 *  = off), its blend weight and temperature, whether a lock was posted; hero's class floor (abs until 10-14: no record). */
export function derivedWalkPolicy(trace: Pick<ChainTrace, "streets" | "nodes">): Record<string, string> {
  const out: Record<string, string> = {};
  const floor = (trace.streets ?? []).map((s) => s.heroFloor?.mode).find((m) => !!m);
  out.HERO_CLASS_FLOOR = floor ?? "abs";
  const offs = (trace.nodes ?? []).map((n) => n.offTree).filter((o): o is NonNullable<ChainTraceNode["offTree"]> => !!o);
  if (offs.length) {
    const soft = offs.map((o) => o.soft).find((s) => !!s);
    out.OFFTREE_RANGE = soft?.mode ?? "off";
    if (soft?.w != null) out.OFFTREE_BLEND_W = String(soft.w);
    if (soft?.t != null) out.OFFTREE_RANGE_T = String(soft.t);
    out.OFFTREE_LOCK = offs.some((o) => o.soft?.lock) ? "on" : "off";
  }
  return out;
}

/** Run `fn` with these env values set (restored after, set or unset as they were). */
export async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
}
/** The keys of `policy` whose value is not today's (the rules a replay had to set). */
const policyDiffers = (policy: Record<string, string>): string[] => {
  const now = walkPolicy();
  return Object.entries(policy).filter(([k, v]) => (now[k] ?? "") !== v).map(([k, v]) => `${k}=${v || "(unset)"}`);
};

type NodeData = { action_solutions: unknown[] };

/** The recorded answers of one trace: its nodes by street + codes, and the streets it asked trees for. */
function recording(trace: ChainTrace) {
  const nodes = new Map<string, NodeData>();
  for (const n of trace.nodes ?? []) {
    const key = `${n.street}|${n.codes.join("-")}`;
    if (nodes.has(key) && !n.heroNode) continue;   // one tree's node per address; hero's own node wins
    nodes.set(key, {
      action_solutions: n.actions.map((a) => ({
        action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: a.position },
        total_frequency: a.totalFrequency, total_ev: a.totalEv, strategy: a.strategy, evs: a.evs,
      })),
    });
  }
  return { nodes, streets: new Set<string>((trace.streets ?? []).map((s) => s.street)) };
}

/** Numbers equal to 1e-6, a range summary ({combos, weight}) within the rounding the trace stores strategies at. */
function compareSent(live: unknown, replay: unknown, path: string, out: ReplayDiff[], inRange = false): void {
  if (out.length > 12) return;
  // a range's combo COUNT is not compared: the trace stores strategies to 4 decimals, so combos the live walk kept at
  // 1e-5 of their weight round to nothing in a replay (46 of 635 real decisions differed on that alone); the weight is
  if (inRange && path.endsWith(".combos")) return;
  if (typeof live === "number" && typeof replay === "number") {
    const tol = inRange ? Math.max(0.05, 0.05 * Math.abs(live)) : 1e-6;
    if (Math.abs(live - replay) > tol) out.push({ what: path, live: String(live), replay: String(replay) });
    return;
  }
  if (live && replay && typeof live === "object" && typeof replay === "object") {
    if (Array.isArray(live) !== Array.isArray(replay)) { out.push({ what: path, live: JSON.stringify(live).slice(0, 80), replay: JSON.stringify(replay).slice(0, 80) }); return; }
    const keys = new Set([...Object.keys(live as object), ...Object.keys(replay as object)]);
    for (const k of keys) compareSent((live as any)[k], (replay as any)[k], `${path}.${k}`, out, inRange || k === "range");
    return;
  }
  if (JSON.stringify(live) !== JSON.stringify(replay)) out.push({ what: path, live: JSON.stringify(live) ?? "—", replay: JSON.stringify(replay) ?? "—" });
}

const walkOf = (nodes: ChainTraceNode[], street: string): string =>
  nodes.filter((n) => n.street === street).sort((a, b) => a.ti - b.ti).map((n) => `${n.codes.join("-") || "root"}${n.heroNode ? "*" : ""}`).join(" → ");

/** Replay one stored chain trace against its own recording. ok: null = not replayable (and why). */
export async function replayTrace(trace: ChainTrace): Promise<ReplayResult> {
  if (!trace?.spec || !trace.streets?.length) return { ok: null, diffs: [], note: "no spec or streets in the trace" };
  if (!trace.result?.ok) return { ok: null, diffs: [], note: "the live walk failed — nothing to reproduce" };
  const rec = recording(trace);
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peek: api.peekSolution, peekNode: api.peekNode, forget: api.forgetSolution,
    summary: api.treeRequestSummary, lock: api.lockedCustomSolution };
  const asked: string[] = [];
  // a node address asked on a street's locked child is the recording's node at that address (the live walk read it there)
  const streetOf = (solId: string) => String(solId).replace(/^replay-/, "").replace(/#lock$/, "");
  api.ensureCustomSolution = async (input: any) => {
    const street = String(input.startingStreet ?? "FLOP");
    if (!rec.streets.has(street)) return { ok: false, status: 404, error: `the replay asked for a ${street} tree the live walk never built` };
    return { ok: true, solId: `replay-${street}`, created: false, session: "replay" };
  };
  api.customNode = async (solId: string, q: any) => {
    const street = streetOf(solId);
    const codes = String(q.flopActions ?? q.turnActions ?? q.riverActions ?? "");
    const data = rec.nodes.get(`${street}|${codes}`);
    if (!data) { asked.push(`${street} [${codes || "root"}]`); return { ok: false, status: 404, error: `the replay needed node ${street} [${codes || "root"}], which the live walk never read` }; }
    return { ok: true, data, solveSecs: 0, cached: true, src: "cache" };
  };
  // THE CACHE AS THE LIVE WALK SAW IT. The chain walks a street on its size-free tree (or the three-way grid) when that
  // tree is already cached and offers the observed sizes, else it pins the sizes into a tree of their own; an empty
  // cache would make every such replay pin (39 of 635 real decisions). A tree the live walk used is "cached" here when
  // its request is the one recorded for the street; its nodes are the recorded ones.
  api.peekSolution = (input: any) => {
    const street = String(input.startingStreet ?? "FLOP");
    const live = trace.streets.find((s) => s.street === street)?.sent as { bet_sizes?: unknown } | undefined;
    if (!live) return null;
    const asked = saved.summary.call(api, input) as { bet_sizes?: unknown };
    return JSON.stringify(asked.bet_sizes) === JSON.stringify(live.bet_sizes) ? `replay-${street}` : null;
  };
  api.peekNode = (solId: string, q: any) => {
    const data = rec.nodes.get(`${streetOf(solId)}|${String(q.flopActions ?? q.turnActions ?? q.riverActions ?? "")}`);
    return data ?? null;
  };
  api.forgetSolution = () => {};
  // THE MID-STREET LOCK AS THE LIVE WALK HAD IT (OFFTREE_LOCK): posted where the live street's off-tree node records one
  // that succeeded (its nodes are the recorded ones), refused where it did not — never GTO Wizard's
  const lockedStreets = new Set<string>((trace.nodes ?? []).filter((n) => n.offTree?.soft?.lock?.ok).map((n) => n.street));
  api.lockedCustomSolution = async (parent: string) => {
    const street = streetOf(parent);
    return lockedStreets.has(street) ? { ok: true, solId: `replay-${street}#lock`, created: false, session: "replay" }
      : { ok: false, status: 0, error: `the live walk posted no node lock on the ${street} (replay)` };
  };
  // the rules the live walk ran under (the header): recorded on the trace, else derived from it
  const policy = trace.policy ?? derivedWalkPolicy(trace);
  const policySet = policyDiffers(policy);
  // a fresh hand key: the replay must not find (or leave) any of the live hand's memo or facts
  const handKey = `replay:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    // … except hero's own narrowing, which is the live hand's state and not something a walk under this key can
    // produce (the header): seeded from the trace, the checkpoint's nodes included (this walk starts at the root)
    const seeded = seedAnsweredHeroNodes(trace, handKey, { checkpoint: true });
    const notes = (...more: string[]): string | null => {
      const parts = [...more, ...(asked.length ? [`asked for unrecorded nodes: ${asked.join(", ")}`] : []), ...(seeded ? [`${seeded} hero node${seeded === 1 ? "" : "s"} seeded from the trace`] : []),
        ...(policySet.length ? [`replayed under the hand's rules (${trace.policy ? "recorded" : "derived from the trace"}): ${policySet.join(", ")}`] : [])];
      return parts.length ? parts.join("; ") : null;
    };
    const r = await withEnv(policy, () => solveAiChain({ ...trace.spec, handKey }));
    const diffs: ReplayDiff[] = [];
    const menuDiffs: ReplayDiff[] = [];
    const replayTraceOut = r.trace;
    if (!r.ok || !replayTraceOut) {
      diffs.push({ what: "result", live: `ok · ${trace.result.line ?? ""}`, replay: `failed: ${(r as { why?: string }).why ?? "?"}` });
      return { ok: false, diffs, note: notes() };
    }
    if ((r.line ?? "") !== (trace.result.line ?? "")) diffs.push({ what: "line", live: trace.result.line ?? "—", replay: r.line ?? "—" });
    const menus: string[] = [];
    for (const ls of trace.streets) {
      const rs = replayTraceOut.streets.find((s) => s.street === ls.street);
      if (!rs) { diffs.push({ what: `${ls.street} street`, live: "walked", replay: "not walked" }); continue; }
      if (Math.abs(ls.potIn - rs.potIn) > 1e-6) diffs.push({ what: `${ls.street} pot in`, live: String(ls.potIn), replay: String(rs.potIn) });
      if (Math.abs(ls.stackIn - rs.stackIn) > 1e-6) diffs.push({ what: `${ls.street} stack in`, live: String(ls.stackIn), replay: String(rs.stackIn) });
      if (ls.sent && rs.sent) {
        // the request's menu (bet_sizes) is compared apart from the rest: a menu rule that changed since the hand
        // differs there and nowhere else, and must not hide a pot or range difference behind the diff cap
        const { bet_sizes: lm, ...lrest } = ls.sent as Record<string, unknown>;
        const { bet_sizes: rm, ...rrest } = rs.sent as Record<string, unknown>;
        compareSent(lrest, rrest, `${ls.street} tree request`, diffs);
        const before = menuDiffs.length;
        compareSent(lm, rm, `${ls.street} tree request.bet_sizes`, menuDiffs);
        if (menuDiffs.length > before) menus.push(`${ls.street} live ${menuOf(ls.sent)} / replay ${menuOf(rs.sent)}`);
      }
      const lw = walkOf(trace.nodes ?? [], ls.street), rw = walkOf(replayTraceOut.nodes ?? [], ls.street);
      if (lw !== rw) diffs.push({ what: `${ls.street} walk`, live: lw || "—", replay: rw || "—" });
    }
    if (!diffs.length && menuDiffs.length) {
      return { ok: null, diffs: menuDiffs, note: notes(`menu-rule-changed: only the menu differs — ${menus.join("; ")} (now ${menuRulesNow()})`) };
    }
    diffs.push(...menuDiffs);
    return { ok: diffs.length === 0, diffs, note: diffs.length ? notes() : null };
  } catch (e) {
    return { ok: null, diffs: [], note: `the replay threw: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  } finally {
    api.ensureCustomSolution = saved.ensure; api.customNode = saved.node; api.peekSolution = saved.peek; api.peekNode = saved.peekNode; api.forgetSolution = saved.forget;
    api.lockedCustomSolution = saved.lock;
    forgetAnsweredHeroNodes(handKey);
  }
}

// ── the results table (central DB), read by the Coverage tab ────────────────────────────────────────────────────
export interface ReplayRow { solveId: number; ts: number; replayedAt: number; clientHandId: string | null; sessionId: string | null; street: string | null; ok: boolean | null; diffs: ReplayDiff[]; note: string | null }

const DDL = `CREATE TABLE IF NOT EXISTS replay_checks (
  solve_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, replayed_at INTEGER NOT NULL, client_hand_id TEXT, session_id TEXT,
  street TEXT, ok INTEGER, diffs TEXT NOT NULL, note TEXT);
CREATE INDEX IF NOT EXISTS idx_replay_checks_ts ON replay_checks(ts);
CREATE INDEX IF NOT EXISTS idx_replay_checks_session ON replay_checks(session_id)`;

export class ReplayChecks {
  private db: Database | null = null;
  constructor(private readonly path?: string) {}
  private open(): Database {
    if (this.db) return this.db;
    this.db = openStore(this.path ?? solvesDbPath());
    this.db.exec(DDL);
    return this.db;
  }
  save(r: ReplayRow): void {
    this.open().query("INSERT OR REPLACE INTO replay_checks VALUES (?,?,?,?,?,?,?,?,?)").run(
      r.solveId, r.ts, r.replayedAt, r.clientHandId, r.sessionId, r.street, r.ok == null ? null : r.ok ? 1 : 0, JSON.stringify(r.diffs), r.note);
  }
  done(solveIds: number[]): Set<number> {
    if (!solveIds.length) return new Set();
    const got = this.open().query(`SELECT solve_id FROM replay_checks WHERE solve_id IN (${solveIds.map(() => "?").join(",")})`).all(...solveIds) as { solve_id: number }[];
    return new Set(got.map((x) => x.solve_id));
  }
  lastRunAt(): number | null {
    try { return (this.open().query("SELECT max(replayed_at) m FROM replay_checks").get() as { m: number | null })?.m ?? null; } catch { return null; }
  }
  /** Decisions replayed in the window (by when they were played), for the Coverage row. */
  rows(days: number, session: string | null = null): ReplayRow[] {
    try {
      const since = Date.now() - days * 86_400_000;
      const q = session ? "SELECT * FROM replay_checks WHERE ts >= ? AND session_id = ? ORDER BY ts" : "SELECT * FROM replay_checks WHERE ts >= ? ORDER BY ts";
      return (this.open().query(q).all(...(session ? [since, session] : [since])) as any[]).map((r) => ({
        solveId: r.solve_id, ts: r.ts, replayedAt: r.replayed_at, clientHandId: r.client_hand_id, sessionId: r.session_id, street: r.street,
        ok: r.ok == null ? null : !!r.ok, diffs: JSON.parse(r.diffs || "[]"), note: r.note,
      }));
    } catch { return []; }
  }
}

export const replayChecks = new ReplayChecks();

/** A replay row as the Coverage table's example line: what differed first. */
export const replayText = (r: ReplayRow): string =>
  r.ok ? "replayed identically" : r.ok === false
    ? `replay differs — ${r.diffs.slice(0, 3).map((d) => `${d.what}: live ${d.live} / replay ${d.replay}`).join("; ")}${r.note ? ` (${r.note})` : ""}`.slice(0, 300)
    : `not replayable: ${r.note ?? "?"}`;
