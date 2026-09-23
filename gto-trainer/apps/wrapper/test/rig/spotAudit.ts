/**
 * Tier 2 — spot selection: does the study tool solve the RIGHT spot? (port of tests/spot_audit.py, 2026-09-24)
 *
 *   bun run test/rig/spotAudit.ts [name ...]          (WRAPPER_URL = the test rig, default :7701)
 *
 * For each fixture (ignition-study-wrapper/tests/fixtures): load the state onto the fake table, take the /hand
 * export the study pipeline would consume, and put it through gto-trainer's own audit endpoint (POST
 * /api/feed-spot), which compares the OBSERVED table against the solved configuration actually used and names every
 * divergence — solution set, effective depth, hero position, the preflop line after snapping to the solved tree,
 * players in the hand. This is where the study-note failures lived (limped pots, phantom-fold desyncs, the 200bb
 * depth gap). Deterministic, and needs NO GTO Wizard.
 *
 * A fixture may declare `expect.spot`: { "allow": ["depth"], "heroPos": "BTN", "maxSeverity": "minor",
 * "known": { field: why } }. With no `spot` block: nothing major, and the audit succeeded.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pyJsonDumps, pyRepr, pyStr } from "../../src/py";
import { API, Case, req, rigCheck, sleep, WRAPPER } from "./rig";

const FIXTURES = resolve(import.meta.dir, "../../../../../ignition-study-wrapper/tests/fixtures");
const SEVERITY: Record<string, number> = { info: 0, minor: 1, major: 2 };

async function run(path: string, stem: string): Promise<Case> {
  const fx = JSON.parse(readFileSync(path, "utf8"));
  const c = new Case(fx.name || stem);
  const want = (fx.expect || {}).spot || {};

  if (!("spec" in fx)) throw new Error("KeyError('spec')");   // a recording-only fixture: nothing to load
  const load = await req(`${WRAPPER}/faketable/load`, fx.spec);
  if (!load.ok) {
    c.check(false, "state loaded", pyJsonDumps(load));
    return c;
  }
  await sleep(1.4);

  const hand = ((await req(`${WRAPPER}/hand`)) || {}).hand;
  if (!hand) {
    c.check(false, "/hand exports the state", "no hand");
    return c;
  }

  const audit = await req(`${API}/api/feed-spot`, { hand });
  if (!audit.ok) {
    c.check(false, "feed-spot audited the spot", pyStr(audit.error ?? null).slice(0, 160));
    return c;
  }
  c.check(true, "feed-spot audited the spot");

  const discs: any[] = audit.discrepancies || [];
  const allow = new Set<string>(want.allow || []);
  const known: Record<string, string> = { ...(want.known || {}) };
  const cap = SEVERITY[want.maxSeverity ?? "minor"] ?? 1;

  const seenKnown = new Set<string>();
  for (const d of discs) {
    const field = d.field ?? null;
    const sev = SEVERITY[d.severity ?? "info"] ?? 0;
    const detail = `${pyStr(d.severity ?? null)}: actual=${pyRepr(d.actual ?? null)} shown=${pyRepr(d.shown ?? null)} ${d.note || ""}`.trim();
    if (allow.has(field)) continue;
    if (field in known) {
      // a documented limitation of the solved charts, not a defect: reported every run, fails only if it CHANGES
      seenKnown.add(field);
      c.known(`divergence '${field}'`, `${known[field]} | ${detail}`);
      continue;
    }
    c.check(sev <= cap, `divergence '${field}' within tolerance`, detail);
  }
  // a known limitation that stops happening is news too: fixed (update the fixture) or no longer exercised
  for (const field of Object.keys(known)) {
    if (!seenKnown.has(field)) c.check(false, `known divergence '${field}' still present`, "it is gone — fixed, or this fixture no longer reaches it");
  }

  // the audit reports the configuration it actually solved; a fixture can pin the parts that matter
  const shown = audit.shown || {}, actual = audit.actual || {};
  for (const key of ["heroPos", "setId", "depth", "street"]) {
    if (key in want) {
      const got = key in shown ? shown[key] : actual[key] ?? null;
      c.check(JSON.stringify(got) === JSON.stringify(want[key]), `solved ${key}`, `got ${pyRepr(got)}, want ${pyRepr(want[key])}`);
    }
  }
  if ("chart" in want) {
    const got = (shown.chart3max || {}).id ?? null;
    c.check(got === want.chart, "solved from chart", `got ${pyRepr(got)}, want ${pyRepr(want.chart)}`);
  }
  const warn: unknown[] = audit.warnings || [];
  c.check(!warn.some((w) => pyStr(w).toLowerCase().includes("no chart")), "charts available for this spot", warn.map(pyStr).join("; ").slice(0, 160));
  return c;
}

async function main(argv: string[]): Promise<number> {
  const bad0 = await rigCheck(WRAPPER);
  if (bad0) {
    console.log(bad0);
    return 2;
  }
  try {
    await req(`${API}/api`);           // /api, not / — the dashboard serves HTML at the root
  } catch (e: any) {
    console.log(`gto-trainer API not reachable on ${API} (${e?.message ?? e})`);
    return 2;
  }
  const wanted = new Set(argv);
  let files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
  if (wanted.size) {
    files = files.filter((f) => wanted.has(f.replace(/\.json$/, "")) || wanted.has(JSON.parse(readFileSync(join(FIXTURES, f), "utf8")).name));
  }
  if (!files.length) {
    console.log(`no fixtures in ${FIXTURES}`);
    return 2;
  }
  const cases: Case[] = [];
  for (const f of files) {
    const stem = f.replace(/\.json$/, "");
    console.log(`\n=== ${stem} ===`);
    let c: Case;
    try {
      c = await run(join(FIXTURES, f), stem);
    } catch (e: any) {
      c = new Case(stem);
      c.check(false, "fixture ran", pyStr(e?.message ?? e));
    }
    cases.push(c);
    for (const [label, detail] of c.notes) console.log(`  KNOWN ${label}` + (detail ? `   — ${detail}` : ""));
    for (const k of c.checks) console.log(`  ${k.ok ? "PASS" : "FAIL"}  ${k.label}` + (k.detail ? `   — ${k.detail}` : ""));
  }
  try { await req(`${WRAPPER}/faketable/stop`, {}); } catch {}
  const bad = cases.filter((c) => c.failed.length);
  const total = cases.reduce((s, c) => s + c.checks.length, 0);
  const failedN = cases.reduce((s, c) => s + c.failed.length, 0);
  console.log(`\n${cases.length - bad.length}/${cases.length} fixtures clean (${total - failedN}/${total} assertions)`);
  if (bad.length) {
    console.log("divergent fixtures: " + bad.map((c) => c.name).join(", "));
    const counts = new Map<string, number>();
    for (const c of bad) for (const k of c.failed) counts.set(k.label, (counts.get(k.label) || 0) + 1);
    for (const [lbl, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  x${String(n).padEnd(3)} ${lbl}`);
  }
  return bad.length ? 1 : 0;
}

process.exit(await main(process.argv.slice(2)));
