/**
 * STRESS-500 FITTED PREFLOP VIEWS (2026-10-08, Brady: "a lot of spots with missing ranges"). When GTO Wizard's AI
 * preflop tree cannot hold the line (a second limper / caller: "token C is not an action at 'C'"), the replayer's
 * preflop walk stops there and every later preflop step had no view — yet the flop ranges WERE read, per seat, on a
 * FITTED line (gtowAiPreflop.arrivalRangesGtowAi: each seat on a line that keeps its own actions and folds the earliest
 * other caller). This rebuilds those reads FROM THE SOLVE CACHE ONLY — no GTO Wizard request, ever:
 *   - the arrival tree's cache key: arrivalRangesGtowAi itself is run against a cache that records the key it asks for
 *     and throws (setPreflopSolveCache) — the very key the live path used, nothing posted;
 *   - every node is read from <root>/gtow-cache.sqlite (read only); a node it lacks ends that seat's read ("fitted node
 *     not cached");
 *   - the fit is gtowAiPreflop's own rule (fitAiLine = utils/fitLine.foldEarliestCaller + the line walked onto the tree's
 *     codes), re-stated here because services/ is not touched; the walk is walkArrivalRanges itself.
 * When the AI tree holds the whole line (the CHART's walk stopped, the flop read the AI tree exactly), the steps get the
 * exact AI walk ("exact").
 */
import { Database } from "bun:sqlite";
import { aiStepsToViews, type NodeView } from "./views";

type AnyHand = any;
export interface FittedResult {
  views: Record<number, NodeView>;
  /** per missing step, why it has no view */
  missing: Record<number, string>;
  /** the arrival tree used (its id and cache key), or why none */
  tree: { id: string; key: string } | { error: string };
}

/** a read-only node getter on the stress root's solve cache (gtowSolveCache's table, gzip replies) */
export function cacheReader(path: string) {
  const db = new Database(path, { readonly: true });
  const q = db.query<{ status: number; reply: Uint8Array | null }, [string, string]>("SELECT status, reply FROM gtow_cache_nodes WHERE key = ? AND addr = ?");
  const hasTree = (key: string): boolean => !!db.query("SELECT 1 FROM gtow_cache_trees WHERE key = ? AND kind = 'pre'").get(key);
  const misses = new Set<string>();
  const node = (key: string, line: string): { data: any; cached: true } | { error: string } => {
    const row = q.get(key, `${line}||||`);
    if (!row) { misses.add(`${key}|${line}`); return { error: `fitted node not cached ('${line || "root"}')` }; }
    if (row.status === 200 && row.reply) {
      try { return { data: JSON.parse(new TextDecoder().decode(Bun.gunzipSync(row.reply as Uint8Array<ArrayBuffer>))), cached: true }; } catch { return { error: "unreadable cached node" }; }
    }
    if (row.status === -204) return { error: `line ends the hand at '${line || "root"}' — no decision node` };
    return { error: `GTO Wizard refused '${line || "root"}' (${row.status})` };
  };
  return { node, hasTree, misses };
}

const STOP = "stress500-fitted: key recorded";

/** `context`: what the hand's flop answer did with these reads — said after every label when it was not the per-seat fit
 *  (a REDUCED tree, or no flop answer at all) */
export async function fittedPreflopViews(hand: AnyHand, heroPos: string, existing: Record<number, unknown>, treeIds: string[],
  cache: ReturnType<typeof cacheReader>, context = ""): Promise<FittedResult> {
  const P = await import("../../services/gtowAiPreflop");
  const { truncateAt, roundContributions } = await import("../../utils/archivedHand/archivedHand");
  const { foldEarliestCaller, actorsWithAllins } = await import("../../utils/fitLine/fitLine");
  const views: Record<number, NodeView> = {}, missing: Record<number, string> = {};
  const firstPost = hand.actions.findIndex((x: any) => x.street !== "preflop");
  const upto = firstPost >= 0 ? firstPost : hand.actions.length;
  const want = [] as number[];
  for (let i = 0; i < upto; i++) if (!/^post/.test(hand.actions[i].type) && !existing[i]) want.push(i);
  if (!want.length) return { views, missing, tree: { error: "nothing missing" } };
  const cut = truncateAt(hand, upto);
  const t: any = { ...cut, street: "preflop", board: [], committed: Object.fromEntries((roundContributions as any)(hand, upto).get("preflop") ?? []), currentNode: { ...cut.currentNode, street: "preflop", pot: 0 } };

  // THE ARRIVAL TREE'S KEY, as the live path asks for it (dealt = the logged tree's stacks, else the table's)
  const keyFor = async (dealt: Record<number, number> | undefined): Promise<string | null> => {
    let got: string | null = null;
    P.setPreflopSolveCache({ enabled: true, hasTree: (k: string) => { got = k; throw new Error(STOP); } } as any);
    try { await P.arrivalRangesGtowAi(t, heroPos, 6, dealt); } catch { /* the recorder threw on purpose */ } finally { P.setPreflopSolveCache(null); }
    return got;
  };
  let tree: { id: string; key: string; dealt: Record<number, number> | undefined } | null = null;
  const tried: string[] = [];
  for (const id of [...treeIds, null]) {
    const dealt = id ? P.dealtFromTreeId(t, heroPos, id) ?? undefined : undefined;
    if (id && !dealt) continue;
    const key = await keyFor(dealt);
    if (!key) continue;
    tried.push(key.slice(0, 8));
    if (cache.hasTree(key)) { tree = { id: id ?? "(table stacks)", key, dealt }; break; }
  }
  if (!tree) {
    const why = tried.length ? `the arrival tree is not in the solve cache (key ${tried.join(" / ")}): fitted node not cached` : "no AI arrival tree for this hand";
    for (const i of want) missing[i] = why;
    return { views, missing, tree: { error: why } };
  }
  const shape = P.shapeOf(t, heroPos, 0, undefined, tree.dealt);
  if ("error" in shape) { for (const i of want) missing[i] = shape.error; return { views, missing, tree: { error: shape.error } }; }
  const { tokens } = P.lineOf(t, shape);
  const get = async (line: string) => cache.node(tree!.key, line);
  const apiToTable: Record<string, string> = {};
  for (const [tablePos, api] of Object.entries(shape.apiOf)) apiToTable[String(api)] = tablePos;
  const treeId = `gtow-ai · ${shape.n}-handed · ${shape.positions.map((p: string) => `${p}:${shape.stacks[p]}`).join("/")}`;

  /** the line walked onto the tree's own codes (gtowAiPreflop.repairLine, cache only) */
  const repair = async (toks: string[]): Promise<{ line: string } | { error: string }> => {
    const out: string[] = [];
    for (const tok of toks) {
      const n = await get(out.join("-"));
      if ("error" in n) return { error: n.error };
      const pick = P.matchToken(tok, n.data?.action_solutions ?? []);
      if (!pick) return { error: `'${tok}' is not offered at '${out.join("-") || "root"}'` };
      out.push(pick.code);
    }
    return { line: out.join("-") };
  };
  /** gtowAiPreflop.fitAiLine, cache only */
  const fitLine = async (keep: string[], keepHero: boolean): Promise<{ line: string; folds: string[]; tokens: string[] } | { error: string }> => {
    const keepSet = new Set([keepHero ? shape.heroApiPos : null, ...keep].filter(Boolean).map((x) => String(x).toUpperCase()));
    let cur = tokens.slice();
    const folds: string[] = [];
    for (let k = 0; k < 4; k++) {
      const step = foldEarliestCaller(cur, { keep: keepSet, stack: shape.stacks, seats: shape.positions });
      if (!step) return { error: "no fit holds this line (the live flop ranges came from the reduced tree)" };
      cur = step.tokens;
      folds.push(step.fold.seat);
      const r = await repair(cur);
      if (!("error" in r)) return { line: r.line, folds, tokens: cur };
      if (!/is not offered/.test(r.error)) return { error: r.error };
    }
    return { error: "no fit holds this line within 4 folds" };
  };
  /** a walk's views, and the seat's k-th own step → view */
  const walk = async (toks: string[]): Promise<{ views: NodeView[]; ok: boolean; why: string | null }> => {
    const steps: any[] = [];
    const w = await P.walkArrivalRanges(shape, toks, get, 6, (s: any) => steps.push(s));
    return { views: aiStepsToViews(steps, apiToTable, shape.positions, treeId), ok: (w as any).ok, why: (w as any).ok ? null : (w as any).reason };
  };
  const ownIndex = (i: number): number => {
    const seat = hand.actions[i].seatId;
    let k = 0;
    for (let j = 0; j < i; j++) if (hand.actions[j].seatId === seat && hand.actions[j].street === "preflop" && !/^post/.test(hand.actions[j].type)) k++;
    return k;
  };
  const take = (vs: NodeView[], pos: string, k: number): NodeView | null => vs.filter((v) => String(v.actor).toUpperCase() === pos.toUpperCase())[k] ?? null;

  // the AI tree holds the whole line (the chart's walk stopped, not the AI tree's): the exact walk
  const exact = await walk(tokens);
  if (exact.ok) {
    for (const i of want) {
      const pos = String(hand.positions[hand.actions[i].seatId]);
      const v = take(exact.views, pos, ownIndex(i));
      if (v) views[i] = { ...v, fitted: `${v.line || "root"} — the AI tree holds this line exactly (the chart could not)${context}`, fitKind: "exact" };
      else missing[i] = "the AI tree's exact walk has no node for this action";
    }
    return { views, missing, tree: { id: treeId, key: tree.key } };
  }
  if (!/is not an action|is not offered|not cached/.test(exact.why ?? "")) {
    for (const i of want) missing[i] = `the AI tree's walk failed: ${exact.why}`;
    return { views, missing, tree: { id: treeId, key: tree.key } };
  }
  // PER SEAT, AS arrivalRangesGtowAi READS THE FLOP RANGES: a fit that keeps the seat, else (not hero) one that folds
  // hero's limp too
  const who = actorsWithAllins(tokens, shape.stacks, shape.positions);
  const bySeat = new Map<string, number[]>();
  for (const i of want) { const p = String(hand.positions[hand.actions[i].seatId]); bySeat.set(p, [...(bySeat.get(p) ?? []), i]); }
  for (const [pos, steps] of bySeat) {
    const api = shape.apiOf[pos.toUpperCase()] ?? pos.toUpperCase();
    let fit = await fitLine([api], true);
    if ("error" in fit && api !== shape.heroApiPos) { const f2 = await fitLine([api], false); if (!("error" in f2)) fit = f2; }
    if ("error" in fit) { for (const i of steps) missing[i] = fit.error; continue; }
    const r = await walk(fit.tokens);
    const folded = fit.folds.map((f) => apiToTable[f] ?? f).join("+");
    const folder = !tokens.some((tk, i) => tk !== "F" && who[i] === api) ? " — he folds: no flop range rests on this read" : "";
    for (const i of steps) {
      const v = take(r.views, pos, ownIndex(i));
      if (v) views[i] = { ...v, src: `${treeId} · fitted ${fit.line}`, fitted: `${fit.line} (${folded} folded out)${folder}${context}`, fitKind: "fit" };
      else missing[i] = r.ok ? "the fitted walk has no node for this action" : /not cached/.test(r.why ?? "") ? `fitted node not cached (${String(r.why).replace(/^GTO Wizard AI preflop ranges: /, "")})` : `the fitted walk failed: ${r.why}`;
    }
  }
  return { views, missing, tree: { id: treeId, key: tree.key } };
}
