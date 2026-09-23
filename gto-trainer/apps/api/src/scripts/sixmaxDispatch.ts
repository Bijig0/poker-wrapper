/**
 * 6-max run watchdog: keep every HRC box busy while the proposal has work left, and report anything odd. Port of
 * sixmaxDispatch.py (2026-09-24).
 *
 *   bun src/scripts/sixmaxDispatch.ts [--api http://localhost:2000] [--dry-run]
 *
 * The box keeper (services/boxKeeper.ts) revives a FAILED job and repairs a sick box. It does not notice a box that is
 * simply IDLE because its own shard finished while another config still has trees to solve — that gap left all four
 * Hetzner boxes idle for 5-12 hours on 2026-09-14. This closes it: for each box lane with no live job, pick the first
 * config of the run that is not done and still has work this box can do (Linux boxes cannot finish a limp tree), and
 * queue it there. One line per action or problem; silence means busy and healthy. Safe to run every few minutes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// the run's configs, in the order a free box should pick them up: finish the first pass before the second
const ORDER = ["grid-6max-nl200", "grid-6max-nl200-asym", "grid-6max-nl200-r2", "grid-6max-nl200-asym-r2"];
const WIN_ONLY = "olimp";          // limp trees: Windows boxes only
const TIMEOUT_S = 90;

async function api(base: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(TIMEOUT_S * 1000),
    headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP Error ${r.status}: ${r.statusText}`);
  return r.json();
}
const num = (x: unknown) => String(x).replace(/\./g, "_");

/** The chart ids a 6-max config is expected to produce — the same formula as services/ledger.ts. */
function expectedIds(cfg: any): string[] {
  const env = cfg.env || {};
  const site = String(env.SITES || "ign200").split(",")[0]!.trim();
  const ids: string[] = [];
  if (env.GRID !== "off") {
    const depths: string[] = env.DEPTHS ? String(env.DEPTHS).split(",").map((d) => d.trim()) : (cfg.depths || [100]).map(String);
    const opens = String(env.OPENS || "2.5,3,2,3.5,limp").split(",").map((o) => o.trim());
    for (const o of opens) for (const d of depths) ids.push(`${site}_6max_D${num(d)}_o${o === "limp" ? "limp" : num(o)}`);
  }
  const a = env.ASYM;
  if (a) {
    const kv = Object.fromEntries(String(a).split(";").filter((p) => p.includes("=")).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
    const deep = String(kv.deep ?? "100").trim();
    const shorts = String(kv.shorts ?? "30,50").split(",").map((s) => s.trim());
    const opens = String(kv.opens ?? "2.5,3").split(",").map((o) => o.trim());
    const seats = String(kv.seats ?? "all").trim() === "all" ? ["UTG", "HJ", "CO", "BTN", "SB", "BB"] : String(kv.seats).split(",").map((s) => s.trim().toUpperCase());
    for (const sh of shorts) for (const o of opens) for (const seat of seats) ids.push(`${site}_6max_D${num(deep)}_s${num(sh)}_${seat}_o${o === "limp" ? "limp" : num(o)}`);
  }
  return ids;
}

async function chartStates(base: string, cfgId: string, ids: string[]): Promise<Map<string, string>> {
  const q = encodeURIComponent(JSON.stringify({ kind: "charts", config: cfgId, ids }));
  const d = await api(base, `/api/ledger/work-data?d=${q}`);
  return new Map(d.sections[0].table.rows.map((r: any[]) => [r[0], r[1]]));
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const base = (argv.includes("--api") ? argv[argv.indexOf("--api") + 1]! : "http://localhost:2000").replace(/\/+$/, "");
  const dryRun = argv.includes("--dry-run");
  let L: any, jobs: any[];
  try {
    L = await api(base, "/api/ledger");
    jobs = (await api(base, "/api/ledger/jobs?limit=250")).jobs;
  } catch (e: any) {   // the API restarts on its own; a tick that cannot read it simply says so
    console.log(`dispatch: API unreachable (${String(e?.message ?? e).slice(0, 80)}) — nothing done this tick`);
    return 0;
  }
  let boxes = L.boxes || {};
  if (!Object.keys(boxes).length) {
    try {
      boxes = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "data", "ledger.json"), "utf8")).boxes;
    } catch {
      console.log("dispatch: cannot read the box list");
      return 1;
    }
  }
  const lanes: [string, string][] = [
    ...(boxes["hrc-box"] || []).filter((b: any) => b.host !== "local").map((b: any) => [`hrc-box:${b.label}`, b.label] as [string, string]),
    ...(boxes["hrc-linux"] || []).map((b: any) => [`hrc-linux:${b.label}`, b.label] as [string, string]),
  ];
  const byId = new Map<string, any>(L.configs.map((c: any) => [c.id, c]));
  const isLive = (j: any) => j.status === "running" || (j.status === "queued" && !j.waitInputs);
  const liveLanes = new Set(jobs.filter(isLive).map((j) => j.lane));
  const liveCfgLane = new Set(jobs.filter((j) => j.status === "running" || j.status === "queued").map((j) => `${j.config}|${j.lane}`));
  // a config whose fan-out is still running anywhere is OFF LIMITS: queueing it again re-splits the plan against the
  // shards already in flight
  const liveCfgs = new Set(jobs.filter(isLive).map((j) => j.config));

  // what is left per config, once per tick
  const left = new Map<string, { all: string[]; anyBox: string[] }>();
  for (const cid of ORDER) {
    const c = byId.get(cid);
    if (!c || c.effective === "done") continue;
    const ids = expectedIds(c);
    if (!ids.length) continue;
    let st: Map<string, string>;
    try {
      st = await chartStates(base, cid, ids);
    } catch (e: any) {
      console.log(`dispatch: could not read ${cid} chart states (${String(e?.message ?? e).slice(0, 60)})`);
      continue;
    }
    const todo = [...st].filter(([, s]) => s !== "done").map(([i]) => i);
    left.set(cid, { all: todo, anyBox: todo.filter((i) => !i.includes(WIN_ONLY)) });
  }
  if (!left.size) return 0;

  // Group the idle lanes by the config they should pick up and queue each config ONCE across all of them: a job
  // queued for a single box is a one-box fan-out (the WHOLE remaining plan), so queueing box by box had two boxes
  // solve the same tree (hrc-l3 and hrc-l4 both on D150_o2, 2026-09-14). One request per config splits the work i/n.
  const want = new Map<string, string[]>();
  for (const [lane, label] of lanes) {
    if (liveLanes.has(lane)) continue;
    const isLinux = lane.startsWith("hrc-linux:");
    for (const cid of ORDER) {
      const l = left.get(cid);
      if (!l || liveCfgLane.has(`${cid}|${lane}`) || liveCfgs.has(cid)) continue;
      if (!(isLinux ? l.anyBox : l.all).length) continue;
      if (!want.has(cid)) want.set(cid, []);
      want.get(cid)!.push(label);
      break;
    }
  }
  for (const [cid, labels] of want) {
    const nLeft = left.get(cid)!.all.length;
    if (dryRun) {
      console.log(`dispatch: would queue ${cid} across ${labels.join(", ")} (${nLeft} tree(s) left)`);
      continue;
    }
    let r: any;
    try {
      r = await api(base, "/api/ledger/jobs", { config: cid, boxes: labels });
    } catch (e: any) {
      console.log(`dispatch: queueing ${cid} across ${labels.join(", ")} failed (${String(e?.message ?? e).slice(0, 60)})`);
      continue;
    }
    if (r.ok) console.log(`dispatch: idle ${labels.join(", ")} -> queued ${cid} split ${labels.length} way(s) (job ${r.job.id}, ${nLeft} tree(s) left)`);
    else console.log(`dispatch: ${cid} refused for ${labels.join(", ")}: ${String(r.error ?? "None").slice(0, 80)}`);
  }

  // A config down to limp trees with every Windows box busy is a WAIT, not a problem: say it once and stay quiet
  // until the situation changes.
  const statePath = join(import.meta.dir, ".dispatch_state.json");
  let seen: Record<string, boolean> = {};
  try {
    seen = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {}
  const nowState: Record<string, boolean> = {};
  for (const [cid, d] of left) {
    if (d.all.length && !d.anyBox.length && !lanes.some(([l]) => l.startsWith("hrc-box:") && !liveLanes.has(l))) {
      const key = `limp:${cid}:${d.all.length}`;
      nowState[key] = true;
      if (!seen[key]) console.log(`dispatch: ${cid} is down to ${d.all.length} limp tree(s) and every Windows box is busy — they run when one frees up (said once)`);
    }
  }
  try {
    writeFileSync(statePath, JSON.stringify(nowState));
  } catch {}
  return 0;
}

process.exit(await main());
