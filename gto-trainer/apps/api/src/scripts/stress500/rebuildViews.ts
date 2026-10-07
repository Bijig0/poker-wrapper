/**
 * STRESS-500 VIEWS REBUILT FROM THE STORE (2026-10-08) — no answer is re-run, no GTO Wizard request is sent.
 *
 *   bun src/scripts/stress500/rebuildViews.ts [--data C:/Users/Brady/poker-data-stress500] [--only id,id] [--dry]
 *
 * For every hands/<id>.json: the postflop views and their alternatives from the run's stored chain traces
 * (views.postflopViewsByDecision — every ok tree of the decision a step leads to, the trees that hold the acting seat
 * first, the rest as `absent` views; the tree of the EARLIEST decision whose walk covers the step, so a later decision's
 * tree never replaces the one that was being answered), and the preflop steps the walk could not reach (the AI tree
 * cannot hold a second caller) from the per-seat FITTED reads in the solve cache (fitted.ts). decisions, mixes, grades,
 * replies and marks are left exactly as stored; hands/ is copied to hands_pre_altviews/ first (once).
 * GTOW_BLOCK=1 for the whole process: nothing can leave it.
 */
import { Database } from "bun:sqlite";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const DATA = (arg("data") ?? "C:/Users/Brady/poker-data-stress500").replace(/\\/g, "/");
const ONLY = arg("only")?.split(",").filter(Boolean) ?? null;
const DRY = argv.includes("--dry");
const WORK = join(DATA, "root");
const ENV_FILE = "C:/Users/Brady/poker-wrapper/config/local.env";
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
  }
}
Object.assign(process.env, {
  POKER_DATA_DIR: WORK, GTOW_CACHE_DB_PATH: join(WORK, "gtow-cache.sqlite"), HAND_FACTS_DB_PATH: ":memory:", ANSWERS_DB_PATH: ":memory:",
  GTOW_BLOCK: "1", GTOW_PREFETCH: "0", GTOW_REQUEST_ORIGIN: "stress500-rebuild", GTOW_REQUESTS_PATH: join(WORK, "rebuild-requests.sqlite"), RIVER_MES: "off",
});

const { normalizeHand } = await import("../../feed/normalizeHand/normalizeHand");
const V = await import("./views");
const { cacheReader, fittedPreflopViews } = await import("./fitted");

const db = new Database(join(WORK, "poker.sqlite"), { readonly: true });
const cache = cacheReader(join(WORK, "gtow-cache.sqlite"));
const scen = new Map((JSON.parse(readFileSync(join(DATA, "scenarios.json"), "utf8")).scenarios as any[]).map((s) => [s.id, s]));
export const sinceOf = (h: { startedAt?: string | null; ranAt?: string | null; ms?: number | null }): number =>
  h.startedAt ? Date.parse(h.startedAt) : h.ranAt && Number.isFinite(Number(h.ms)) ? Date.parse(h.ranAt) - Number(h.ms) - 500 : 0;
const decisionIndexOf = (key: string | null): number | null => { try { const k = JSON.parse(key ?? "null"); const i = Array.isArray(k) ? Number(k[k.length - 1]) : NaN; return Number.isFinite(i) ? i : null; } catch { return null; } };
const commit = (() => { try { return require("node:child_process").execSync("git rev-parse --short HEAD", { cwd: import.meta.dir }).toString().trim(); } catch { return "?"; } })();

const HANDS = join(DATA, "hands");
const BACKUP = join(DATA, "hands_pre_altviews");
if (!DRY && !existsSync(BACKUP)) { cpSync(HANDS, BACKUP, { recursive: true }); console.log(`backup: ${BACKUP}`); }

const tot = { hands: 0, postSteps: 0, srcChanged: 0, srcOtherDecision: 0, srcOtherDecisionHero: 0, heroDecSteps: 0, heroWasForeign: 0, heroNowForeign: 0, newViews: 0, altSteps: 0, absent: 0, pfWanted: 0, pfFilled: 0, pfExact: 0, why: {} as Record<string, number> };
const changedEx: string[] = [];
for (const f of readdirSync(HANDS).filter((x) => x.endsWith(".json")).sort()) {
  const id = f.replace(/\.json$/, "");
  if (ONLY && !ONLY.includes(id)) continue;
  const file = join(HANDS, f);
  const h = JSON.parse(readFileSync(file, "utf8"));
  const sc = scen.get(id);
  if (!sc) { console.log(`${id}: not in scenarios.json — skipped`); continue; }
  const hand = normalizeHand(sc.raw).hand;
  const cid = String(sc.raw?.clientHandId ?? `stress-s5-${id}`);
  const rows = db.query("select id, decision_key, ok, trace from solves where client_hand_id = ? and ts >= ? order by ts").all(cid, sinceOf(h)) as any[];
  const traces = rows.flatMap((r) => { try { return [{ id: r.id, decisionIndex: decisionIndexOf(r.decision_key), ok: !!r.ok, trace: JSON.parse(Buffer.from(Bun.gunzipSync(r.trace)).toString("utf-8")) }]; } catch { return []; } });

  // ── postflop: by the decision being answered ──
  const old: Record<string, any> = h.views ?? {};
  const by = V.postflopViewsByDecision(h.hand.actions, h.hand.positions, traces);
  const views: Record<string, any> = {};
  for (const [i, v] of Object.entries(old)) if (h.hand.actions[Number(i)]?.street === "preflop" && !(v as any)?.fitted) views[i] = v;
  for (let i = 0; i < h.hand.actions.length; i++) {
    const a = h.hand.actions[i];
    if (a.street === "preflop" || /^post/.test(a.type)) continue;
    tot.postSteps++;
    const was = old[i]?.src ?? null, now = by.views[i]?.src ?? null;
    if (was && now && was !== now && !by.views[i]?.absent) {
      tot.srcChanged++;
      // the tree's decision: another decision's tree (the bug: a later decision's tree replaying this street) or the same
      // decision's lowest-id tree instead of another of its plans
      const dOf = (src: string) => { const m = /^tree #(\d+)/.exec(src); const t = m ? traces.find((x) => x.id === Number(m[1])) : null; return t ? t.decisionIndex : null; };
      if (dOf(was) !== dOf(now)) { tot.srcOtherDecision++; if (a.hero) tot.srcOtherDecisionHero++; if (changedEx.length < 12) changedEx.push(`${id}#${i}: ${was.split(" · ")[0]} (decision ${dOf(was)}) → ${now.split(" · ")[0]} (decision ${dOf(now)})`); }
    }
    if (a.hero && h.decisions?.some((d: any) => d.index === i && d.ok)) {
      tot.heroDecSteps++;
      const own = new Set(traces.filter((t) => t.decisionIndex === i).map((t) => t.id));
      const idOf = (src: string | null) => Number(/^tree #(\d+)/.exec(src ?? "")?.[1] ?? NaN);
      if (own.size && was && !own.has(idOf(was))) tot.heroWasForeign++;
      if (own.size && now && !own.has(idOf(now))) tot.heroNowForeign++;
    }
    if (!was && now) tot.newViews++;
  }
  Object.assign(views, by.views);
  tot.altSteps += Object.keys(by.alts).length;
  tot.absent += Object.values(by.alts).flat().filter((v) => v.absent).length + Object.values(by.views).filter((v) => v.absent).length;

  // ── preflop: the steps the walk could not reach, from the fitted reads in the solve cache ──
  let fittedMeta: any = null;
  if (/walk stopped/.test(h.preflopNote ?? "")) {
    const treeIds = [...new Set([/(gtow-ai · \d-handed · \S+)/.exec(String(h.preflopNote))?.[1], ...traces.map((t) => t.trace?.spec?.rangeSource)]
      .filter((x): x is string => typeof x === "string" && x.startsWith("gtow-ai")))];
    const heroPos = String(h.hero ?? hand.positions[hand.heroSeatId] ?? "");
    const post = (h.decisions ?? []).filter((d: any) => d.street !== "preflop");
    const reduced = post.some((d: any) => /reduced tree/i.test(`${d.warning ?? ""} ${JSON.stringify(d.path?.reasons ?? [])}`));
    const context = !post.length ? " — the hand never reached a flop answer: no live range rests on this read"
      : reduced ? " — this hand's flop ranges came from the REDUCED tree (a seat's fit failed), not from this read" : "";
    const r = await fittedPreflopViews(hand, heroPos, views, treeIds, cache, context);
    const wanted = Object.keys(r.views).length + Object.keys(r.missing).length;
    tot.pfWanted += wanted; tot.pfFilled += Object.keys(r.views).length;
    tot.pfExact += Object.values(r.views).filter((v) => v.fitKind === "exact").length;
    for (const w of Object.values(r.missing)) { const k = w.replace(/\(.*$/, "").replace(/'[^']*'/g, "'…'").trim().slice(0, 70); tot.why[k] = (tot.why[k] ?? 0) + 1; }
    Object.assign(views, r.views);
    fittedMeta = { tree: r.tree, filled: Object.keys(r.views).map(Number), missing: r.missing };
    if (argv.includes("--dump")) {
      console.log(`${id}: tree ${JSON.stringify(r.tree).slice(0, 140)}`);
      for (const [i, v] of Object.entries(r.views)) console.log(`  #${i} ${v.actor} line '${v.line}' took ${v.taken} [${v.actions.join(", ")}] tot ${JSON.stringify(v.totals)} ranges ${Object.keys(v.ranges).join(",")} · ${v.fitted}`);
      for (const [i, w] of Object.entries(r.missing)) console.log(`  #${i} MISSING ${w}`);
    }
  }
  h.views = views;
  h.alt = by.alts;
  h.viewsMeta = { rebuiltAt: new Date().toISOString(), commit, traces: traces.map((t) => [t.id, t.decisionIndex, t.ok ? 1 : 0]), fitted: fittedMeta };
  tot.hands++;
  if (!DRY) { writeFileSync(file + ".tmp", JSON.stringify(h)); renameSync(file + ".tmp", file); }
}
console.log(JSON.stringify({ ...tot, why: undefined }, null, 0));
console.log("preflop steps not filled, by reason:", tot.why);
console.log("examples of a step whose view changed tree:", changedEx);
process.exit(0);
