import type { Database } from "bun:sqlite";
import { gtowApi } from "./gtowApi";
import { solveAiChain, type ChainTrace, type ChainTraceNode } from "./aiChain";
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
 */

export interface ReplayDiff { what: string; live: string; replay: string }
export interface ReplayResult { ok: boolean | null; diffs: ReplayDiff[]; note: string | null }

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
    summary: api.treeRequestSummary };
  const asked: string[] = [];
  api.ensureCustomSolution = async (input: any) => {
    const street = String(input.startingStreet ?? "FLOP");
    if (!rec.streets.has(street)) return { ok: false, status: 404, error: `the replay asked for a ${street} tree the live walk never built` };
    return { ok: true, solId: `replay-${street}`, created: false, session: "replay" };
  };
  api.customNode = async (solId: string, q: any) => {
    const street = String(solId).replace(/^replay-/, "");
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
    const data = rec.nodes.get(`${String(solId).replace(/^replay-/, "")}|${String(q.flopActions ?? q.turnActions ?? q.riverActions ?? "")}`);
    return data ?? null;
  };
  api.forgetSolution = () => {};
  try {
    // a fresh hand key: the replay must not find (or leave) any of the live hand's memo or facts
    const r = await solveAiChain({ ...trace.spec, handKey: `replay:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}` });
    const diffs: ReplayDiff[] = [];
    const replayTraceOut = r.trace;
    if (!r.ok || !replayTraceOut) {
      diffs.push({ what: "result", live: `ok · ${trace.result.line ?? ""}`, replay: `failed: ${(r as { why?: string }).why ?? "?"}` });
      return { ok: false, diffs, note: asked.length ? `asked for unrecorded nodes: ${asked.join(", ")}` : null };
    }
    if ((r.line ?? "") !== (trace.result.line ?? "")) diffs.push({ what: "line", live: trace.result.line ?? "—", replay: r.line ?? "—" });
    for (const ls of trace.streets) {
      const rs = replayTraceOut.streets.find((s) => s.street === ls.street);
      if (!rs) { diffs.push({ what: `${ls.street} street`, live: "walked", replay: "not walked" }); continue; }
      if (Math.abs(ls.potIn - rs.potIn) > 1e-6) diffs.push({ what: `${ls.street} pot in`, live: String(ls.potIn), replay: String(rs.potIn) });
      if (Math.abs(ls.stackIn - rs.stackIn) > 1e-6) diffs.push({ what: `${ls.street} stack in`, live: String(ls.stackIn), replay: String(rs.stackIn) });
      if (ls.sent && rs.sent) compareSent(ls.sent, rs.sent, `${ls.street} tree request`, diffs);
      const lw = walkOf(trace.nodes ?? [], ls.street), rw = walkOf(replayTraceOut.nodes ?? [], ls.street);
      if (lw !== rw) diffs.push({ what: `${ls.street} walk`, live: lw || "—", replay: rw || "—" });
    }
    return { ok: diffs.length === 0, diffs, note: null };
  } catch (e) {
    return { ok: null, diffs: [], note: `the replay threw: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  } finally {
    api.ensureCustomSolution = saved.ensure; api.customNode = saved.node; api.peekSolution = saved.peek; api.peekNode = saved.peekNode; api.forgetSolution = saved.forget;
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
