/**
 * Inventory GTO Wizard's solution catalogue — which game formats exist, at
 * which stack depths, and which of them are ANTE formats.
 *
 * Why this exists: SOLUTION_SETS was hand-inventoried once and covers only the
 * non-ante cash catalog (Cash6m/CashHu * General/Complex/Simple). CoinPoker
 * posts a 0.16bb/player ante, so the ranges feeding the postflop solve fleet
 * are from the wrong game. Before crawling ante trees we need GTO Wizard's
 * exact `gametype` identifiers — they are opaque strings and guessing them
 * just produces empty pages.
 *
 * This script is DISCOVERY ONLY. It reads the catalogue and writes a JSON
 * report; it never opens a node or pulls a range. Run crawlPreflopTree.ts for
 * that, once the identifiers below have been added to SOLUTION_SETS.
 *
 * Method: evaluate in the PAGE context so requests carry the app's own
 * session — no bearer-token handling here. Several endpoint shapes are probed
 * because the catalogue route isn't documented; whichever answers wins, and
 * the raw payload is saved so the shape can be inspected by hand.
 *
 * Usage (GTO Wizard must be running with --remote-debugging-port=9222):
 *   bun run src/scripts/discoverGtowFormats.ts            # probe + report
 *   bun run src/scripts/discoverGtowFormats.ts --launch   # launch it first
 *   bun run src/scripts/discoverGtowFormats.ts --out /tmp/formats.json
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gtowCdp } from "../services/gtowCdp";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) {
    const next = process.argv[i + 1];
    args.set(a.slice(2), next == null || next.startsWith("--") ? "1" : process.argv[++i]!);
  }
}
const OUT = args.get("out") ?? "data/gtow-formats.json";

/** Candidate catalogue routes. The app requests one of these on boot; we don't
 *  know which, so ask for all and keep whatever returns a usable body. */
const CANDIDATES = [
  "/v4/solutions/gametypes/",
  "/v4/solutions/game-types/",
  "/v4/gametypes/",
  "/v4/gameformats/",
  "/v4/solutions/formats/",
  "/v4/meta/gametypes/",
  "/v4/solutions/catalog/",
];

/** Runs inside the page. Probes each route and, separately, sweeps `window`
 *  for anything that looks like a format catalogue the SPA already loaded —
 *  that store is how the original inventory was taken. */
const PROBE = /* js */ `(async () => {
  const out = { probes: [], stores: [], location: location.href };
  const BASE = "https://api.gtowizard.com";
  for (const path of ${JSON.stringify(CANDIDATES)}) {
    try {
      const r = await fetch(BASE + path, { credentials: "include" });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
      out.probes.push({
        path,
        status: r.status,
        ok: r.ok,
        size: text.length,
        body: r.ok ? body : (typeof body === "string" ? body : JSON.stringify(body).slice(0, 300)),
      });
    } catch (e) {
      out.probes.push({ path, status: 0, ok: false, error: String(e).slice(0, 200) });
    }
  }
  // Sweep global state for a preloaded catalogue: any array of objects whose
  // entries carry a gametype-ish key. Depth-limited so this can't run away.
  const seen = new Set();
  const looksLikeFormat = (o) =>
    o && typeof o === "object" && !Array.isArray(o) &&
    ["gametype","game_type","gameType","format","id"].some((k) => k in o) &&
    JSON.stringify(o).length < 4000;
  const visit = (node, path, depth) => {
    if (depth > 4 || node == null || seen.has(node)) return;
    if (typeof node === "object") {
      if (seen.size > 4000) return;
      seen.add(node);
      if (Array.isArray(node)) {
        if (node.length && node.length < 500 && node.every(looksLikeFormat)) {
          const s = JSON.stringify(node);
          if (/ante/i.test(s) || /cash|mtt|spin/i.test(s)) {
            out.stores.push({ path, count: node.length, sample: node.slice(0, 3), hasAnte: /ante/i.test(s) });
          }
          return;
        }
        for (let i = 0; i < Math.min(node.length, 40); i++) visit(node[i], path + "[" + i + "]", depth + 1);
      } else {
        for (const k of Object.keys(node).slice(0, 80)) {
          try { visit(node[k], path + "." + k, depth + 1); } catch {}
        }
      }
    }
  };
  for (const k of Object.keys(window).slice(0, 400)) {
    if (/^(webkit|chrome|on[a-z]+)/.test(k)) continue;
    try { visit(window[k], "window." + k, 0); } catch {}
  }
  return out;
})()`;

function anteish(s: string): boolean {
  return /ante/i.test(s);
}

async function main() {
  if (args.has("launch")) {
    process.stdout.write("launching GTO Wizard (--remote-debugging-port=9222)…\n");
    const r = await gtowCdp.launchApp();
    if (!r.ok) {
      console.error(`could not launch: ${r.error ?? "unknown"}`);
      process.exit(1);
    }
  }

  if (!(await gtowCdp.isConnected())) {
    console.error(
      "GTO Wizard is not reachable on CDP 9222.\n" +
        '  macOS:   open -a "GTO Wizard" --args --remote-debugging-port=9222\n' +
        "  or re-run this script with --launch"
    );
    process.exit(1);
  }

  process.stdout.write("probing catalogue…\n");
  const res = await gtowCdp.evalInPage<{
    probes: { path: string; status: number; ok: boolean; size?: number; body?: unknown; error?: string }[];
    stores: { path: string; count: number; sample: unknown[]; hasAnte: boolean }[];
    location: string;
  }>(PROBE);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(res, null, 2));

  console.log(`\npage: ${res.location}`);
  console.log("\n── endpoint probes ──");
  for (const p of res.probes) {
    const mark = p.ok ? "OK " : "   ";
    const note = p.ok ? `${p.size} bytes${anteish(JSON.stringify(p.body)) ? "  ← mentions ANTE" : ""}` : `${p.status || "err"}`;
    console.log(`  ${mark} ${p.path.padEnd(30)} ${note}`);
  }

  console.log("\n── in-page catalogue stores ──");
  if (!res.stores.length) console.log("  (none found — inspect the JSON report by hand)");
  for (const s of res.stores) {
    console.log(`  ${s.path}  (${s.count} entries)${s.hasAnte ? "  ← mentions ANTE" : ""}`);
  }

  const anyAnte =
    res.probes.some((p) => p.ok && anteish(JSON.stringify(p.body))) || res.stores.some((s) => s.hasAnte);

  console.log(`\nfull report → ${OUT}`);
  console.log(
    anyAnte
      ? "\nANTE formats present. Next: pull their exact `gametype` strings and depth lists\n" +
          "from the report, add them to SOLUTION_SETS in services/gtowCdp.ts, then extend\n" +
          "the PLAN in crawlPreflopTree.ts. No ranges were fetched by this script."
      : "\nNo ante formats surfaced. Either the catalogue lives behind a route not probed\n" +
          "here, or this account's plan doesn't expose them — check the report, and check\n" +
          "the format picker in the UI by hand before assuming they don't exist."
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
