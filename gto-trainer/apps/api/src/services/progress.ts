import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { evaluate, loadLedger, expectedChartIds, isBoxGrid, BOX_GRID_KINDS, MES_HANDOFF, HRC_API, type EvaluatedConfig } from "./ledger";
import { chartStates, runEstimate } from "./chartProgress";
import { jobs, type JobRow } from "./jobs";
import { hrcJobsFor } from "./runbook";
import { getCatalog } from "./chartCatalog";

/**
 * PROGRESS — what a running proposal is doing right now, per solve.
 *
 *   fleet (MES locks on Hetzner): every box in fleet_ips_<tag>.json is asked over ssh
 *     what is in its runs/ directory — a board is done when its .locked.json is there,
 *     locking when its .exploit.log is, solving when only its .driver.log is; the
 *     driver / exploitsolve process tells which board is being worked on and for how
 *     long. Polled at most every 30 s, only while someone is looking.
 *   hrc (preflop charts on this machine): the HRC Runner's queue.json + queue.state.json
 *     + runner.log say which row is running, which are done (output present), which wait.
 *   scripts: the job runner's own step counter and the tail of its log.
 */

const SSH = existsSync("C:/Program Files/Git/usr/bin/ssh.exe") ? "C:/Program Files/Git/usr/bin/ssh.exe" : "ssh";
const BOX_RUNS = "~/poker/analysis/pipeline/limp_study/mes_handoff/runs";
const REMOTE_CMD = `cd ${BOX_RUNS} 2>/dev/null || { echo NO_RUNS; exit 0; }; ls -1; echo @@; tail -n 12 batch.log 2>/dev/null; echo @@; cat /proc/loadavg; echo @@; ps -eo etimes=,args= | grep -E 'release/(driver|exploitsolve) ' | grep -v grep | head -3; echo @@; free -m | awk 'NR==2{print $3"/"$2}'`;
const FAMILIES = ["M2_heroBTN_srp_vs_BB", "M1_heroSB_bvb_cbet", "M2_heroBTN_srp_vs_BB_p4", "M1_heroSB_bvb_cbet_p4"];
const FLEET_TTL_MS = 30_000;

export interface BoxBoard { family: string; board: string; state: "done" | "locking" | "solving" | "failed" | "pending" }
export interface BoxSnap {
  name: string; ip: string; index: number; reachable: boolean; error?: string; noRuns?: boolean;
  total: number; done: number; boards: BoxBoard[];
  current: { family: string; board: string; phase: string; elapsedS: number } | null;
  load: string; mem: string; lastLines: string[]; allDone: boolean;
}
export interface FleetSnap { tag: string; at: number | null; polling: boolean; hasIps: boolean; ipsPath: string; boxes: BoxSnap[]; total: number; done: number }

const fleetCache = new Map<string, FleetSnap>();

function readJson<T>(p: string): T | null { try { return JSON.parse(readFileSync(p, "utf-8")) as T; } catch { return null; } }

/** The boards box i is responsible for: shard i of every family in FAMILIES (those with a shard spec). */
function boardsForBox(suffix: string, i: number): { family: string; board: string }[] {
  const out: { family: string; board: string }[] = [];
  for (const fam of FAMILIES) {
    const sp = readJson<{ boards?: string[] }>(join(MES_HANDOFF, `${fam}${suffix}.shard${i}.json`));
    for (const b of sp?.boards ?? []) out.push({ family: fam, board: b });
  }
  return out;
}

async function askBox(name: string, ip: string, suffix: string): Promise<BoxSnap> {
  const index = Number((name.match(/-(\d+)$/) ?? [, "0"])[1]);
  const expected = boardsForBox(suffix, index);
  const snap: BoxSnap = { name, ip, index, reachable: false, total: expected.length, done: 0, boards: expected.map((e) => ({ ...e, state: "pending" })), current: null, load: "", mem: "", lastLines: [], allDone: false };
  let out = "";
  try {
    const proc = Bun.spawn([SSH, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", `root@${ip}`, REMOTE_CMD],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: process.env.HOME ?? process.env.USERPROFILE ?? "C:/Users/Brady" } });
    const killer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 30_000);
    const [o, e] = await Promise.all([new Response(proc.stdout as any).text(), new Response(proc.stderr as any).text()]);
    const code = await proc.exited; clearTimeout(killer);
    if (code !== 0) { snap.error = (e.trim().split("\n").pop() ?? `ssh exited ${code}`).slice(0, 160); return snap; }
    out = o;
  } catch (err) { snap.error = String(err).slice(0, 160); return snap; }
  parseBoxOutput(snap, out);
  return snap;
}

/** Turn the box's answer (file list · batch.log tail · loadavg · live solver processes · memory) into the board states. Exported for the test. */
export function parseBoxOutput(snap: BoxSnap, out: string): BoxSnap {
  snap.reachable = true;
  if (out.trim().startsWith("NO_RUNS")) { snap.noRuns = true; snap.error = "box is up, nothing launched yet (no runs/ directory)"; return snap; }
  const [filesTxt = "", tailTxt = "", loadTxt = "", psTxt = "", memTxt = ""] = out.split(/\r?\n@@\r?\n/);
  const files = new Set(filesTxt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  snap.lastLines = tailTxt.split(/\r?\n/).filter(Boolean).slice(-6);
  snap.allDone = /(^|\n)ALL_DONE/.test(tailTxt);
  snap.load = loadTxt.trim().split(" ").slice(0, 3).join(" ");
  snap.mem = memTxt.trim() ? `${memTxt.trim()} MB` : "";
  // no shard spec locally? infer the board list from what the box has
  if (!snap.boards.length) {
    for (const f of files) { const m = f.match(/^(M\d_\w+?)_([2-9TJQKA][cdhs]{1}[2-9TJQKA][cdhs][2-9TJQKA][cdhs])\.(driver\.json|locked\.json)$/); if (m && !snap.boards.some((b) => b.family === m[1] && b.board === m[2])) snap.boards.push({ family: m[1], board: m[2], state: "pending" }); }
    snap.total = snap.boards.length;
  }
  const failed = new Set<string>();
  for (const ln of tailTxt.split(/\r?\n/)) { const m = ln.match(/\]\s+(\w{6})\s+(DRIVER|EXPLOITSOLVE) FAILED/); if (m) failed.add(m[1]); }
  for (const b of snap.boards) {
    const tag = `${b.family}_${b.board}`;
    b.state = files.has(`${tag}.locked.json`) ? "done" : failed.has(b.board) ? "failed" : files.has(`${tag}.exploit.log`) ? "locking" : files.has(`${tag}.driver.log`) ? "solving" : "pending";
  }
  snap.done = snap.boards.filter((b) => b.state === "done").length;
  // the live process names the board and the phase; its age is the time on that board
  for (const ln of psTxt.split(/\r?\n/)) {
    const m = ln.trim().match(/^(\d+)\s+.*release\/(driver|exploitsolve)\s+.*?(M\d_\w+?)_([2-9TJQKA][cdhs][2-9TJQKA][cdhs][2-9TJQKA][cdhs])\.(driver|exploit)\.json/);
    if (m) { snap.current = { family: m[3], board: m[4], phase: m[2] === "driver" ? "equilibrium solve" : "locking the pool's frequencies", elapsedS: Number(m[1]) }; break; }
  }
  if (!snap.current && !snap.allDone) {
    const b = snap.boards.find((x) => x.state === "solving" || x.state === "locking");
    if (b) snap.current = { family: b.family, board: b.board, phase: b.state === "solving" ? "equilibrium solve" : "locking the pool's frequencies", elapsedS: 0 };
  }
  return snap;
}

async function refreshFleet(tag: string, suffix: string): Promise<void> {
  const snap = fleetCache.get(tag)!;
  snap.polling = true;
  try {
    const ips = readJson<Record<string, string>>(snap.ipsPath) ?? {};
    const boxes = await Promise.all(Object.entries(ips).map(([name, ip]) => askBox(name, ip, suffix)));
    boxes.sort((a, b) => a.index - b.index);
    snap.boxes = boxes; snap.total = boxes.reduce((s, b) => s + b.total, 0); snap.done = boxes.reduce((s, b) => s + b.done, 0);
  } finally { snap.at = Date.now(); snap.polling = false; }
}

/** The cached picture of one fleet; kicks off a refresh (non-blocking) when it is older than 30 s. */
export function fleetSnapshot(tag: string, suffix: string): FleetSnap {
  const ipsPath = join(MES_HANDOFF, `fleet_ips_${tag}.json`);
  let snap = fleetCache.get(tag);
  if (!snap) { snap = { tag, at: null, polling: false, hasIps: false, ipsPath, boxes: [], total: 0, done: 0 }; fleetCache.set(tag, snap); }
  snap.hasIps = existsSync(ipsPath);
  if (!snap.hasIps) { snap.boxes = []; snap.total = 0; snap.done = 0; return snap; }
  if (!snap.polling && (snap.at === null || Date.now() - snap.at > FLEET_TTL_MS)) void refreshFleet(tag, suffix);
  return snap;
}

// ---- HRC Runner ------------------------------------------------------------------

export interface HrcRow { id: string; status: string; note: string; at: string | null }
export interface HrcSnap { queuePath: string; exists: boolean; rows: HrcRow[]; done: number; total: number; current: HrcRow | null; runnerLog: string[]; runnerLogAt: number | null }

/** One HRC Runner queue read the way the GUI reads it: done_if present → done, else the state file, else pending. */
export function hrcSnapshot(queuePath: string, root: string, keep?: (id: string) => boolean): HrcSnap {
  const q = readJson<{ jobs?: { id: string; done_if?: string }[] }>(queuePath);
  const snap: HrcSnap = { queuePath, exists: !!q, rows: [], done: 0, total: 0, current: null, runnerLog: [], runnerLogAt: null };
  if (!q) return snap;
  const state = readJson<Record<string, { status?: string; note?: string; at?: string }>>(queuePath.replace(/\.json$/, ".state.json")) ?? {};
  for (const j of q.jobs ?? []) {
    if (keep && !keep(j.id)) continue;
    const st = state[j.id] ?? {};
    const done = !!j.done_if && existsSync(join(root, j.done_if));
    snap.rows.push({ id: j.id, status: done ? "done" : st.status ?? "pending", note: done ? "output present" : st.note ?? "", at: st.at ?? null });
  }
  snap.total = snap.rows.length; snap.done = snap.rows.filter((r) => r.status === "done").length;
  snap.current = snap.rows.find((r) => r.status === "running") ?? null;
  const logPath = join(dirname(queuePath), "runner.log");
  try { const t = readFileSync(logPath, "utf-8"); snap.runnerLog = t.split(/\r?\n/).filter(Boolean).slice(-8); snap.runnerLogAt = require("node:fs").statSync(logPath).mtimeMs; } catch { /* no log yet */ }
  return snap;
}

// ---- per config ------------------------------------------------------------------

export interface ConfigProgress {
  id: string; label: string; kind: string; runner: string; effective: string;
  units: { done: number; total: number; unit: string; note?: string };
  job: { id: number; status: string; started: number | null; ended: number | null; note: string | null; step: number | null; steps: number; stepLabel: string | null; stepStarted: number | null; exitCode: number | null; logTail: string[] } | null;
  fleet?: FleetSnap; hrc?: HrcSnap;
  live: boolean;
}

function jobFor(c: EvaluatedConfig, all: JobRow[]): ConfigProgress["job"] {
  const j = all.find((x) => x.config === c.id && (x.status === "running" || x.status === "queued")) ?? all.find((x) => x.config === c.id) ?? null;
  if (!j) return null;
  const lv = j.status === "running" ? jobs.live(j.id) : null;
  return { id: j.id, status: j.status, started: j.started, ended: j.ended, note: j.note, step: lv ? lv.step : null, steps: j.steps.length, stepLabel: lv ? lv.label : null, stepStarted: lv ? lv.stepStarted : null, exitCode: j.exitCode,
    logTail: j.status === "running" || j.status === "failed" ? jobs.logTail(j.id, 10).split(/\r?\n/).filter(Boolean).slice(-8) : [] };
}

function configProgress(c: EvaluatedConfig, all: JobRow[], catalogIds: Set<string>): ConfigProgress {
  const L = loadLedger();
  const job = jobFor(c, all);
  const P: ConfigProgress = { id: c.id, label: c.label, kind: c.kind, runner: c.runner, effective: c.effective, units: { done: c.effective === "done" ? 1 : 0, total: 1, unit: "step" }, job, live: !!job && (job.status === "running" || job.status === "queued") };
  if (c.kind === "mes-lock") {
    const tag = c.env?.FLEET_TAG ?? c.id.replace(/^mes-/, "");
    const suffix = c.env?.SPEC_SUFFIX ?? `_${tag}`;
    let total = 0, local = 0;
    for (const fam of FAMILIES) {
      const sp = readJson<{ boards?: string[] }>(join(MES_HANDOFF, `${fam}${suffix}.json`)) ?? readJson<{ boards?: string[] }>(join(MES_HANDOFF, `${fam}.json`));
      for (const b of sp?.boards ?? []) { total++; if (existsSync(join(MES_HANDOFF, `runs_${tag}`, `${fam}_${b}.locked.json`))) local++; }
    }
    if (c.effective !== "done") {
      P.fleet = fleetSnapshot(tag, suffix);
      const onBoxes = P.fleet.done;
      P.units = { done: Math.max(local, onBoxes), total: total || c.cost.jobs, unit: "flops", note: P.fleet.hasIps ? `${onBoxes} solved on the boxes · ${local} pulled to this machine` : local ? `${local} pulled to this machine` : undefined };
      if (P.fleet.boxes.some((b) => b.reachable && !b.allDone)) P.live = true;
    } else P.units = { done: total || c.cost.jobs, total: total || c.cost.jobs, unit: "flops" };
  } else if (c.kind === "preflop-grid" || c.kind === "locked-root") {
    const fmt = L.formats.find((f) => f.id === c.format); const t = c.tree ? L.trees[c.tree] : null;
    if (fmt && t) {
      const ids = hrcJobsFor(c, fmt, t).jobs.map((j) => j.id);
      P.units = { done: ids.filter((id) => catalogIds.has(id)).length, total: ids.length, unit: "charts" };
    }
    if (c.recipe === "hrc-plan") {
      P.hrc = hrcSnapshot(join(HRC_API, "solves", "threemax_asym", "ledger", c.id, "queue.json"), HRC_API);
      if (P.hrc.current) P.live = true;
    }
  } else if (isBoxGrid(c)) {
    const fmt = L.formats.find((f) => f.id === c.format);
    const st = chartStates(c, expectedChartIds(c, fmt));
    const lanes = Number((c as any).lanes ?? (L as any).machines?.[c.runner] ?? 1);
    const est = runEstimate(c, st, lanes);
    P.units = { done: est.done, total: st.length || c.cost.jobs, unit: "trees", note: `${est.solved ? `${est.solved} solved on the boxes, pulling · ` : ""}${est.running ? `${est.running} solving now on ${[...new Set(st.filter((x) => x.state === "running").map((x) => x.box))].join(", ")} · ` : ""}${est.text}` };
    if (est.running) P.live = true;
  }
  return P;
}

export interface ProposalProgress {
  id: string; run: string; at: number; live: boolean;
  totals: { done: number; total: number };
  parts: { title: string; configs: ConfigProgress[] }[];
}

export function proposalProgress(id: string): ProposalProgress | null {
  const L = loadLedger();
  const P = ((L as any).proposals ?? []).find((x: any) => x.id === id);
  if (!P) return null;
  const ev = evaluate();
  const byId = new Map(ev.configs.map((c) => [c.id, c]));
  let catalogIds = new Set<string>();
  try { catalogIds = new Set((getCatalog().entries as any[]).map((e) => String(e.id))); } catch { /* none */ }
  const all = jobs.list(200);
  const parts: ProposalProgress["parts"] = (P.parts ?? []).map((pp: any) => ({ title: String(pp.title), configs: (pp.steps as string[]).map((s) => byId.get(s)).filter((c): c is EvaluatedConfig => !!c).map((c) => configProgress(c, all, catalogIds)) }));
  const solveKinds = ["preflop-grid", "preflop-grid-asym", ...BOX_GRID_KINDS, "locked-root", "mes-lock"];
  const solveCfgs = parts.flatMap((p) => p.configs).filter((c) => solveKinds.includes(c.kind));
  return {
    id, run: P.run, at: Date.now(), live: parts.some((p) => p.configs.some((c) => c.live)),
    totals: { done: solveCfgs.reduce((s, c) => s + c.units.done, 0), total: solveCfgs.reduce((s, c) => s + c.units.total, 0) },
    parts,
  };
}
