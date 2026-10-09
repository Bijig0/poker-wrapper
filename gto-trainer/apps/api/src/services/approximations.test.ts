/**
 * THE REGISTER IS COMPLETE (2026-10-05, Brady: no addition on top of base GTO merges without a register entry).
 *
 * Two halves:
 *   - every entry carries what the header says it must (kind, trigger, what replaces what, data for a pool overlay,
 *     off switch, badge, owner + date, review-by for an experiment, retired details for a retired one);
 *   - every chain-path code and every warning prefix the ANSWER PATH emits resolves to an entry or to NOT_DEPARTURES.
 *     The scan reads the source: a new `code: "preflop:…"` or a new note opening "SOMETHING NEW: …" fails here until
 *     it is registered.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { APPROXIMATIONS, NOT_DEPARTURES, departureForCode, departureForWarning, departuresOf } from "./approximations";

const SRC = join(import.meta.dir, "..");
/** Everything that can compose an answer: all of services/ and utils/ (a hand-picked list missed utils/foldPostIns'
 *  "POSTED IN (approximation)" the first time). Tests and the register itself are left out. */
const ROOTS = ["services", "utils"];

function sources(): { file: string; text: string }[] {
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const f of readdirSync(join(SRC, rel))) {
      const p = `${rel}/${f}`;
      if (statSync(join(SRC, p)).isDirectory()) walk(p);
      else if (f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("approximations")) files.push(p);
    }
  };
  for (const r of ROOTS) walk(r);
  return files.map((file) => ({ file, text: stripComments(readFileSync(join(SRC, file), "utf-8")) }));
}

/** Block comments and whole-line `//` comments out (prose in comments is full of "WORDS:" that are not warnings). */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
}

const CODE_RE = /["'`]((?:preflop|arrival|postflop|street|tree|node|check|fault):[a-z0-9${}._-]+)["'`]/g;
/** a note opening with an upper-case tag: "TAG:" or "TAG (qualifier):", right after the quote or a single space */
const TAG_RE = /["'`] ?([A-Z][A-Z0-9'/+-]*(?: [A-Z0-9'/+-]+)*)(?: \([^)]*\))?: /g;
/** tags that are never answer warnings (labels in logs and prompts) */
const NOT_WARNINGS = new Set(["YOUR TURN"]);

describe("register entries carry the header's fields", () => {
  test("ids are unique", () => {
    const ids = APPROXIMATIONS.map((a) => a.id);
    expect(ids.filter((x, i) => ids.indexOf(x) !== i)).toEqual([]);
  });
  test.each(APPROXIMATIONS.map((a) => [a.id, a] as const))("%s", (_id, a) => {
    expect(["approximation", "pool-overlay", "policy-experiment"]).toContain(a.kind);
    expect(["experiment", "live", "retired"]).toContain(a.lifecycle);
    expect(a.trigger.length).toBeGreaterThan(10);
    expect(a.replaces.gto.length).toBeGreaterThan(3);
    expect(a.replaces.with.length).toBeGreaterThan(3);
    expect(a.badge.length).toBeGreaterThan(2);
    expect(a.owner.length).toBeGreaterThan(0);
    expect(a.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(a.offSwitch === null || (a.offSwitch.env.length > 0 && a.offSwitch.values.length > 0)).toBe(true);
    if (a.kind === "pool-overlay") {
      expect(a.data?.source.length ?? 0).toBeGreaterThan(10);
      expect(a.data?.sample.length ?? 0).toBeGreaterThan(10);
    }
    if (a.lifecycle === "experiment") expect(a.reviewBy ?? "").toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (a.lifecycle === "retired") expect(a.retired?.on ?? "").toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test("a code or a warning belongs to one entry", () => {
    const codes = APPROXIMATIONS.flatMap((a) => a.pathCodes ?? []);
    expect(codes.filter((x, i) => codes.indexOf(x) !== i)).toEqual([]);
    for (const c of codes) expect(NOT_DEPARTURES.codes[c]).toBeUndefined();
  });
});

describe("the answer path emits nothing the register does not account for", () => {
  const src = sources();

  test("every chain-path code", () => {
    const found = new Map<string, string>();
    for (const { file, text } of src) for (const m of text.matchAll(CODE_RE)) if (!found.has(m[1]!)) found.set(m[1]!, file);
    expect(found.size).toBeGreaterThan(20);
    const unknown: string[] = [];
    for (const [code, file] of found) {
      if (code.includes("${")) {
        // a templated code: its fixed head must be a NOT_DEPARTURES prefix, or every expansion registered (below)
        const head = code.slice(0, code.indexOf("${"));
        if (Object.keys(NOT_DEPARTURES.codePrefixes).some((p) => head.startsWith(p))) continue;
        if (code === "preflop:${tag}-ai-failed") continue;   // tag = gap-gate | fit-empties, registered below
        if (head === "arrival:" || head === "preflop:") continue; // `arrival:${producer}` / `preflop:${piece}`: chainPath's default when no code is set
        unknown.push(`${code} (${file})`);
        continue;
      }
      if (departureForCode(code) || NOT_DEPARTURES.codes[code]) continue;
      if (Object.keys(NOT_DEPARTURES.codePrefixes).some((p) => code.startsWith(p))) continue;
      unknown.push(`${code} (${file})`);
    }
    expect(unknown).toEqual([]);
    // the expansions of the templated AI-failed code
    for (const c of ["preflop:gap-gate-ai-failed", "preflop:fit-empties-ai-failed"]) expect(departureForCode(c)).not.toBeNull();
  });

  test("every warning prefix", () => {
    const found = new Map<string, string>();
    for (const { file, text } of src) for (const m of text.matchAll(TAG_RE)) {
      const tag = m[1]!;
      if (tag.length < 5 || !/[A-Z]{3}/.test(tag) || NOT_WARNINGS.has(tag)) continue;
      if (!found.has(tag)) found.set(tag, file);
    }
    expect(found.size).toBeGreaterThan(20);
    const unknown = [...found].filter(([tag]) => !departureForWarning(tag) && !Object.keys(NOT_DEPARTURES.warnings).some((w) => tag.startsWith(w)))
      .map(([tag, file]) => `${tag} (${file})`);
    expect(unknown).toEqual([]);
  });

  test("the pool overlays resolve from what their answers carry", () => {
    expect(departureForCode("preflop:pool-coldcall-lock")?.id).toBe("pool-coldcall-lock");
    expect(departureForCode("arrival:pool-coldcall-floor")?.id).toBe("pool-coldcall-floor");
    expect(departureForCode("preflop:pool-limp-lock")?.id).toBe("pool-limp-lock");
    expect(departureForCode("arrival:pool-limp-floor")?.id).toBe("pool-limp-floor");
    expect(departureForCode("preflop:gap-gate")?.id).toBe("gap-gate");
    expect(departureForCode("postflop:offtree-soft")?.id).toBe("offtree-soft-range");
    expect(departureForCode("postflop:offtree-lock")?.id).toBe("offtree-node-lock");
    expect(departureForWarning("OFF-TREE RANGE")?.id).toBe("offtree-soft-range");
    // the SB-flat table v2 (SB_FLAT_TABLE=v2): its own code; its note clause rides inside the flat floor's
    expect(departureForCode("arrival:pool-flat-floor-sbv2")?.id).toBe("pool-sbflat-v2");
    expect(departureForCode("arrival:pool-flat-floor-sbv2")?.offSwitch?.env).toBe("SB_FLAT_TABLE");
    expect(departuresOf(["arrival:pool-flat-floor-sbv2"], "POOL FLAT RANGE: the SB (35bb) flat-called the BTN's open — 0.3 combos on x, now the pool's poolcall_flat_SB_vsBTN_oM_25_65 (sbflat v2: 36.54% of chances")
      .map((x) => x.id).sort()).toEqual(["pool-flat-floor", "pool-sbflat-v2"]);
    expect(departuresOf([], "POOL FLAT RANGE: the BB (40bb) defended … now the pool's poolcall_flat_BB_vsCO_40_80 (45.00% of chances").map((x) => x.id)).toEqual(["pool-flat-floor"]);
    expect(departureForCode("street:new-plan")).toBeNull();
    const d = departuresOf(["preflop:charts-cannot-hold"], "LINE FITTED TO THE TREE: … · POOL-LOCKED COLD-CALL: the BB (48bb) cold-called");
    expect(d.map((x) => x.id)).toEqual(["pool-coldcall-lock", "line-fit-borrow"]);
  });
});
