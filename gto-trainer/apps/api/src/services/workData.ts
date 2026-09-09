import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMP, MES_HANDOFF, HRC_API, loadLedger, expectedChartIds } from "./ledger";
import { fetchNode, type HrcNode } from "./hrc3max";
import { getCatalog } from "./chartCatalog";
import { jobs } from "./jobs";

/** What every live box job of a config is doing right now, read from its log: the chart it is refining, the last one parsed. */
export function boxActivity(configId: string): { lane: string; box: string; status: string; solving: string | null; lastDone: string | null; progress: string | null }[] {
  const out: ReturnType<typeof boxActivity> = [];
  for (const j of jobs.list(200)) {
    if (j.config !== configId || (j.status !== "running" && j.status !== "queued")) continue;
    const tail = jobs.logTail(j.id, 600).split("\n");
    const last = (re: RegExp) => { for (let i = tail.length - 1; i >= 0; i--) { const m = tail[i]!.match(re); if (m) return m[1] ?? m[0]; } return null; };
    out.push({ lane: j.lane, box: j.lane.split(":").pop()!, status: j.status, solving: last(/refining (\S+) for/), lastDone: last(/\] parsed (\S+):/), progress: last(/box: (\[\d+\/\d+\])/) });
  }
  return out;
}
/** status text for one chart id: done (in the catalog) / solving on hrc-N / queued */
function chartStatus(id: string, activity: ReturnType<typeof boxActivity>): string {
  if (catalogHas(id)) return "done";
  const a = activity.find((x) => x.solving === id);
  return a ? `solving on ${a.box}` : activity.length ? "queued" : "not started";
}

/**
 * The DATA behind a WORK line on the Runbook: the actual charts / ranges /
 * tables a unit of work produces or consumes. For work not solved yet it
 * shows the current-generation counterpart (clearly labelled) so the shape
 * of the deliverable is visible before it runs.
 *
 * A section is one of: a chart node grid (actions + per-class mix), a
 * weighted range grid, a table, or a list.
 */
export interface Section {
  title: string; note?: string;
  node?: { actions: string[]; cells: Record<string, Record<string, number>> };   // class -> action -> %
  range?: Record<string, number>;                                                   // class -> weight 0..1
  /** chart / status: column indexes — a row whose status is "done" gets a "view chart" button on the page */
  table?: { cols: string[]; rows: (string | number)[][]; chart?: number; status?: number };
  list?: string[];
}
export interface WorkData { title: string; sections: Section[]; }

const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const parseRangeStr = (s: string): Record<string, number> => Object.fromEntries(s.split(",").filter(Boolean).map((x) => { const [k, w] = x.split(":"); return [k!.trim(), Number(w ?? 1)]; }));
const nodeSection = (title: string, n: HrcNode, note?: string): Section => ({ title, note, node: { actions: n.actions.map((a) => a.action), cells: Object.fromEntries(n.cells.map((c) => [c.hand, c.actions])) } });

/** The lines worth showing for a 3-max chart, with plain names. */
const CHART_LINES: [string, string][] = [["", "BTN first to act"], ["F", "SB first, BTN folded"], ["R2.5", "SB facing the BTN 2.5bb open"], ["R2.5-F", "BB facing the BTN 2.5bb open, SB folded"], ["F-R3", "BB facing the SB 3bb open"]];

function catalogHas(id: string): boolean {
  try { return (getCatalog().entries as any[]).some((e) => String(e.id) === id); } catch { return false; }
}
/** NL25 / lock ids do not exist yet: the closest chart we do have (same depth, NL200 rake, current generation). */
function counterpart(id: string): string | null {
  const m = id.match(/_D([\d_]+)_s[\d_]+/); if (!m) return null;
  const D = m[1]!;
  const c2 = `ign200_3maxasym2ci_D${D}_s${D}_eq`, c1 = `ign200_3maxasym_D${D}_s${D}_eq`;
  return catalogHas(c2) ? c2 : catalogHas(c1) ? c1 : null;
}

export async function workData(d: any): Promise<WorkData> {
  const out: WorkData = { title: "", sections: [] };
  switch (d?.kind) {
    case "chart": {
      const id = String(d.id); const exists = catalogHas(id);
      const src = exists ? id : d.seats === 4 ? null : counterpart(id);
      const st = d.config ? chartStatus(id, boxActivity(String(d.config))) : (exists ? "done" : "not solved yet");
      out.title = exists ? `chart ${id} — solved` : `${id} — ${st}`;
      if (!exists && st.startsWith("solving")) { const a = boxActivity(String(d.config)).find((x) => x.solving === id); out.sections.push({ title: `${st} right now`, note: a?.progress ? `the box is at ${a.progress} of its list` : "auto-solve + Run-Nash refinement in progress" }); }
      if (!src) { out.sections.push({ title: "nothing to show yet", note: `no chart with this id in the catalog and no same-depth counterpart${d.seats === 4 ? " (there is no 4-handed chart of any generation yet)" : ""}` }); break; }
      const note = exists ? undefined : `showing the current-generation counterpart ${src} (NL200 rake) — the NL25 solve replaces it at the same nodes`;
      if (d.lock) {
        // a continuation chart: the lock range first, then the counterpart's nodes below that open
        const pm = readJson(d.poolFile && existsSync(d.poolFile) ? d.poolFile : join(LIMP, "pool_model_v4.json"));
        const key = d.lock.rangeKey; const rng = pm?.ranges?.[key];
        out.sections.push(rng ? { title: `the lock: ${d.lock.pos} ${d.lock.size === "limp" ? "limps" : `opens ${d.lock.size}bb`} with the pool's measured range "${key}"`, note: `${Object.keys(rng).length} classes · from ${pm?.chart ?? "pool model"} · width ${Math.round(100 * Object.entries(rng).reduce((s, [k, w]) => s + (k.length === 2 ? 6 : k.endsWith("s") ? 4 : 12) * Number(w), 0) / 1326)}% of hands`, range: rng }
          : { title: `the lock range "${key}" is not in the pool model yet`, note: key.includes("limp") ? "limp ranges are derived when the pool model is next rebuilt (build_pool_model.py now writes btn_limp / sb_limp_bvb)" : "rebuild the pool model" });
        const lines: [string, string][] = d.lock.size === "limp" ? (d.lock.pos === "BTN" ? [["C", "SB facing the BTN limp"], ["C-F", "BB facing the BTN limp, SB folded"]] : [["F-C", "BB facing the SB limp"]])
          : d.lock.pos === "BTN" ? [[`R${d.lock.size}`, `SB facing the BTN ${d.lock.size}bb open`], [`R${d.lock.size}-F`, `BB facing the BTN ${d.lock.size}bb open, SB folded`]] : [[`F-R${d.lock.size}`, `BB facing the SB ${d.lock.size}bb open`]];
        for (const [line, name] of lines) {
          const n = await fetchNode(src, line);
          if (n && n !== "unreachable") out.sections.push(nodeSection(`${name} — equilibrium today (${src})`, n, "the locked solve replaces this: same node, but the opener holds the pool's range above instead of the equilibrium one"));
          else out.sections.push({ title: name, note: n === "unreachable" ? "chart server (:8777) unreachable" : "node not in this chart's tree" });
        }
      } else {
        for (const [line, name] of CHART_LINES) {
          const n = await fetchNode(src, line);
          if (n && n !== "unreachable") out.sections.push(nodeSection(name, n, note));
          else out.sections.push({ title: name, note: n === "unreachable" ? "chart server (:8777) unreachable" : "node not in this chart's tree" });
        }
      }
      break;
    }
    case "lockrung": {
      out.title = `the ${d.locks?.length ?? 0} continuation charts at ${d.depth}bb`;
      {
        const L = loadLedger(); const cfg = L.configs.find((c) => c.id === d.config); const fmt = L.formats.find((f) => f.id === cfg?.format);
        const ids = cfg ? expectedChartIds(cfg, fmt).filter((x) => x.includes(`_D${String(d.depth).replace(".", "_")}_`)) : [];
        const act = boxActivity(String(d.config));
        if (ids.length) out.sections.push({ title: `${ids.length} charts at ${d.depth}bb`, note: "one row per lock; a done row opens the chart", table: { cols: ["lock", "chart", "status"], chart: 1, status: 2,
          rows: ids.map((id) => { const lk = (d.locks ?? []).find((l: any) => id.endsWith(l.size === "limp" ? `_${l.pos}limp` : `_${l.pos}${String(l.size).replace(".", "_")}x`)); return [lk ? `${lk.pos} ${lk.size === "limp" ? "limps" : `opens ${lk.size}bb`}` : "?", id, chartStatus(id, act)]; }) } });
      }
      const pm = readJson(join(LIMP, "pool_model_v4.json"));
      out.sections.push({ title: "locks", list: (d.locks ?? []).map((l: any) => `${l.pos} ${l.size === "limp" ? "limps" : `opens ${l.size}bb`} with the pool's "${l.rangeKey}" range${pm?.ranges?.[l.rangeKey] ? ` (${Object.keys(pm.ranges[l.rangeKey]).length} classes)` : " (not in the pool model yet)"}`) });
      for (const key of ["btn_open", "sb_open_bvb"]) if (pm?.ranges?.[key]) out.sections.push({ title: `pool range "${key}" (re-cut on the ${d.depth}bb chart's ranking at solve time)`, range: pm.ranges[key] });
      break;
    }
    case "asym": {
      const L = loadLedger(); const cfg = L.configs.find((c) => c.id === d.config); const fmt = L.formats.find((f) => f.id === cfg?.format);
      const st = readJson(cfg?.states ? join(HRC_API, "..", cfg.states) : join(HRC_API, "solves", "threemax_asym", "ledger", "nl25_states.json"));
      const ids = cfg ? expectedChartIds(cfg, fmt) : [];
      const act = boxActivity(String(d.config));
      out.title = `uneven-stack states ${d.from + 1}–${d.to}`;
      const rows = (st?.states ?? []).slice(d.from, d.to).map((s: any, i: number) => { const id = ids[d.from + i] ?? `ign25_3maxasym2ci_D${s.deep}_s${s.short}_${s.shortSeat}`; return [d.from + i + 1, `${s.deep} / ${s.deep} / ${s.short}bb`, s.shortSeat.toUpperCase(), s.hands, `${Math.round(100 * s.cumShareOfAllHands)}%`, id, chartStatus(id, act)]; });
      const done = rows.filter((r) => r[6] === "done").length, solving = rows.filter((r) => String(r[6]).startsWith("solving")).length;
      out.sections.push({ title: `one HRC solve per row · ${done} done${solving ? `, ${solving} solving now` : ""}`, note: "deep / deep / short stacks, which seat is short, how many of our hands sit there, cumulative coverage of all hands (even rungs included); a done row opens the chart", table: { cols: ["#", "stacks", "short seat", "hands", "coverage", "chart id", "status"], rows, chart: 5, status: 6 } });
      if (act.length) out.sections.push({ title: "boxes on this step", list: act.map((a) => `${a.box}: ${a.solving ? `solving ${a.solving}` : a.status}${a.progress ? ` · ${a.progress} of its list` : ""}${a.lastDone ? ` · last landed ${a.lastDone}` : ""}`) });
      break;
    }
    case "pool": {
      const p = d.file && existsSync(d.file) ? d.file : join(LIMP, "pool_model_v4.json");
      const pm = readJson(p);
      out.title = `pool model — ${p.split(/[\\/]/).pop()}`;
      if (!pm) { out.sections.push({ title: "not built yet", note: `${d.file} does not exist; it is written by the pool-model step` }); break; }
      const fq = pm.freq ?? {}; const n = pm.n ?? {};
      out.sections.push({ title: `measured frequencies (chart ${pm.chart})`, table: { cols: ["node", "rate", "n"], rows: Object.entries(fq).map(([k, v]) => [k, `${(100 * Number(v)).toFixed(1)}%`, n[k.replace(/_(open|limp|fold|flat|3bet|call|4bet).*$/, "_first")] ?? ""]) } });
      for (const [k, r] of Object.entries(pm.ranges ?? {})) out.sections.push({ title: `pool range "${k}"`, range: r as Record<string, number> });
      break;
    }
    case "exploit": {
      const p = d.file && existsSync(d.file) ? d.file : join(LIMP, "exploit_ranges.json");
      const ex = readJson(p); const isLive = !(d.file && existsSync(d.file));
      out.title = `exploit answers — ${p.split(/[\\/]/).pop()}`;
      if (!ex) { out.sections.push({ title: "not calculated yet" }); break; }
      const names: Record<string, string> = { btn_root: "BTN first to act", sb_vs_open: "SB facing the BTN open", sb_bvb: "SB first, BTN folded", bb_vs_open: "BB facing the BTN open", bb_vs_sb: "BB facing the SB open" };
      for (const [node, choices] of Object.entries(ex.choices ?? {})) {
        const cells: Record<string, Record<string, number>> = {}; const acts = new Set<string>();
        for (const [cls, a] of Object.entries(choices as Record<string, string>)) { cells[cls] = { [a]: 100 }; acts.add(a); }
        out.sections.push({ title: names[node] ?? node, note: `${isLive ? `the current export (fitted on ${ex.chart}) — the NL25 export replaces it` : `fitted on ${ex.chart}`} · one best action per class`, node: { actions: [...acts].sort(), cells } });
      }
      break;
    }
    case "mes": {
      const spec = readJson(join(MES_HANDOFF, `${d.family}${d.suffix ?? ""}.json`)) ?? readJson(join(MES_HANDOFF, `${d.family}.json`));
      out.title = `MES spot ${d.family}`;
      if (!spec) { out.sections.push({ title: "no spec" }); break; }
      out.sections.push({ title: `hero's arrival range (${spec.hero})`, note: `pot ${spec.pot / 100}bb · stack ${spec.eff_stack / 100}bb · rake ${spec.rake_rate * 100}% cap ${spec.rake_cap / 100}bb`, range: parseRangeStr(spec.villain === 1 ? spec.oop_range : spec.ip_range) });
      out.sections.push({ title: "the pool's calling range", range: parseRangeStr(spec.villain === 1 ? spec.ip_range : spec.oop_range) });
      const tag = d.tag ?? "";
      const rows = (spec.boards ?? []).map((b: string) => [b, existsSync(join(MES_HANDOFF, `runs_${tag}`, `${d.family}_${b}.locked.json`)) ? "solved (this run)" : existsSync(join(MES_HANDOFF, "runs", `${d.family}_${b}.locked.json`)) ? "served today (previous generation)" : "—"]);
      out.sections.push({ title: `${rows.length} flops`, table: { cols: ["flop", "status"], rows } });
      break;
    }
    default:
      out.title = "no data for this line"; out.sections.push({ title: "nothing to show", note: "this unit of work has no chart or range behind it" });
  }
  return out;
}
