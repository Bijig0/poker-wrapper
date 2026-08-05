/**
 * Inventory GTO Wizard's solution catalogue — which game formats exist, at
 * which stack depths, and specifically the CASH ANTE ones.
 *
 * Why this exists: SOLUTION_SETS was hand-inventoried once and covers only the
 * non-ante cash catalog (Cash6m/CashHu * General/Complex/Simple). CoinPoker
 * posts a 0.16bb/player ante, so the ranges feeding the postflop solve fleet
 * are from the wrong game. GTO Wizard's `gametype` values are opaque strings
 * and a wrong one navigates to an empty page, so the real identifiers have to
 * be read out of the client before anything can be crawled.
 *
 * DISCOVERY ONLY. No node is opened and no range is fetched.
 *
 * Three methods, most reliable first — none of them guess:
 *
 *   --url     You navigate to any ante spot in the client; this reads
 *             location.href and extracts gametype + depth. Five seconds, and
 *             it cannot be wrong. Start here.
 *
 *   --watch   Installs a fetch/XHR recorder in the page, then polls while you
 *             click through the ante section. Captures whatever endpoint the
 *             app itself uses to populate its format and depth pickers —
 *             including the full depth list per format.
 *
 *   --probe   Guesses catalogue routes. Kept only as a last resort; it is the
 *             one method here that can silently come up empty.
 *
 * `--watch` exists because gtowCdp's CDP client only dispatches messages with
 * an `id` — protocol EVENTS are dropped — so Network.enable/responseReceived
 * is unavailable. Patching fetch in-page needs nothing but Runtime.evaluate.
 *
 * Usage (GTO Wizard running with --remote-debugging-port=9222):
 *   bun run src/scripts/discoverGtowFormats.ts --url
 *   bun run src/scripts/discoverGtowFormats.ts --watch 90
 *   bun run src/scripts/discoverGtowFormats.ts --launch --probe
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
const WATCH_SECS = parseInt(args.get("watch") ?? "0", 10) || 0;

const CANDIDATES = [
  "/v4/solutions/gametypes/",
  "/v4/solutions/game-types/",
  "/v4/gametypes/",
  "/v4/gameformats/",
  "/v4/solutions/formats/",
  "/v4/meta/gametypes/",
  "/v4/solutions/catalog/",
];

/** Read the live URL and pull the solution coordinates out of it. */
const READ_URL = /* js */ `(() => {
  const u = new URL(location.href);
  const p = Object.fromEntries(u.searchParams.entries());
  return { href: location.href, gametype: p.gametype ?? null, depth: p.depth ?? null, params: p };
})()`;

/**
 * Install a recorder over fetch and XHR. Idempotent — re-running must not
 * double-wrap, or one navigation would be recorded several times.
 */
const INSTALL_RECORDER = /* js */ `(() => {
  if (window.__gtowCap) return { installed: false, already: true, count: window.__gtowCap.length };
  window.__gtowCap = [];
  const keep = (url, status, text) => {
    try {
      if (!/gtowizard\\.com/.test(url)) return;
      if (window.__gtowCap.length > 400) return;
      let body = null;
      try { body = JSON.parse(text); } catch { body = String(text).slice(0, 400); }
      window.__gtowCap.push({ url, status, size: (text || "").length, body });
    } catch {}
  };
  const of = window.fetch;
  window.fetch = async function (...a) {
    const r = await of.apply(this, a);
    try {
      const url = typeof a[0] === "string" ? a[0] : (a[0] && a[0].url) || "";
      r.clone().text().then((t) => keep(url, r.status, t)).catch(() => {});
    } catch {}
    return r;
  };
  const OX = window.XMLHttpRequest;
  function Wrapped() {
    const x = new OX();
    let u = "";
    const oo = x.open;
    x.open = function (m, url, ...rest) { u = url; return oo.call(this, m, url, ...rest); };
    x.addEventListener("load", () => keep(u, x.status, x.responseText));
    return x;
  }
  Wrapped.prototype = OX.prototype;
  window.XMLHttpRequest = Wrapped;
  return { installed: true, already: false, count: 0 };
})()`;

const DRAIN = /* js */ `(() => {
  const c = window.__gtowCap || [];
  return { count: c.length, entries: c };
})()`;

const PROBE = /* js */ `(async () => {
  const out = [];
  for (const path of ${JSON.stringify(CANDIDATES)}) {
    try {
      const r = await fetch("https://api.gtowizard.com" + path, { credentials: "include" });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
      out.push({ path, status: r.status, ok: r.ok, size: text.length, body });
    } catch (e) {
      out.push({ path, status: 0, ok: false, error: String(e).slice(0, 200) });
    }
  }
  return out;
})()`;

const isAnte = (s: string) => /ante/i.test(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull anything that looks like a gametype id out of an arbitrary payload. */
function harvestGametypes(node: unknown, acc = new Set<string>()): Set<string> {
  if (node == null) return acc;
  if (typeof node === "string") {
    if (/^(Cash|Mtt|MTT|Spin|Hu)[A-Za-z0-9]{4,}$/.test(node)) acc.add(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const v of node) harvestGametypes(v, acc);
    return acc;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (/^(gametype|game_type|gameType|id|slug|value)$/.test(k) && typeof v === "string") {
        if (v.length > 4 && /[A-Z]/.test(v)) acc.add(v);
      }
      harvestGametypes(v, acc);
    }
  }
  return acc;
}

async function main() {
  if (args.has("launch")) {
    process.stdout.write("launching GTO Wizard (--remote-debugging-port=9222)…\n");
    const r = await gtowCdp.launchApp();
    if (!r.ok) { console.error(`could not launch: ${r.error ?? "unknown"}`); process.exit(1); }
  }
  if (!(await gtowCdp.isConnected())) {
    console.error(
      "GTO Wizard is not reachable on CDP 9222.\n" +
        '  macOS:   open -a "GTO Wizard" --args --remote-debugging-port=9222\n' +
        "  or re-run with --launch"
    );
    process.exit(1);
  }

  const report: Record<string, unknown> = {};

  // ---- 1. current URL (never wrong) ----
  const url = await gtowCdp.evalInPage<{ href: string; gametype: string | null; depth: string | null }>(READ_URL, false);
  report.url = url;
  console.log("\n── current page ──");
  console.log(`  ${url.href}`);
  if (url.gametype) {
    console.log(`  gametype = ${url.gametype}${isAnte(url.gametype) ? "   ← ANTE" : ""}`);
    console.log(`  depth    = ${url.depth ?? "(unset)"}`);
  } else {
    console.log("  (no gametype in URL — open a solution in the client first)");
  }

  // ---- 2. watch ----
  if (WATCH_SECS) {
    const ins = await gtowCdp.evalInPage<{ installed: boolean; already: boolean }>(INSTALL_RECORDER, false);
    console.log(`\n── watching ${WATCH_SECS}s ${ins.already ? "(recorder already installed)" : "(recorder installed)"} ──`);
    console.log("  Now, in GTO Wizard: open the ANTE section and click through");
    console.log("  4-max and 6-max, and the stack-depth selector (150 → 20).");
    for (let i = 0; i < WATCH_SECS; i += 5) {
      await sleep(5000);
      const d = await gtowCdp.evalInPage<{ count: number }>(DRAIN, false);
      process.stdout.write(`\r  captured ${d.count} API responses…   `);
    }
    console.log();
    const drained = await gtowCdp.evalInPage<{ count: number; entries: { url: string; status: number; body: unknown }[] }>(DRAIN, false);
    report.captured = drained.entries;
    const anteHits = drained.entries.filter((e) => isAnte(JSON.stringify(e.body)) || isAnte(e.url));
    console.log(`\n  ${drained.count} responses captured, ${anteHits.length} mentioning "ante"`);
    for (const h of anteHits.slice(0, 8)) console.log(`    ${h.status}  ${h.url.slice(0, 110)}`);
  }

  // ---- 3. probe (last resort) ----
  if (args.has("probe")) {
    const probes = await gtowCdp.evalInPage<{ path: string; ok: boolean; status: number; size?: number; body?: unknown }[]>(PROBE);
    report.probes = probes;
    console.log("\n── endpoint probes ──");
    for (const p of probes) {
      console.log(`  ${p.ok ? "OK " : "   "} ${p.path.padEnd(30)} ${p.ok ? `${p.size} bytes` : p.status || "err"}`);
    }
  }

  // ---- roll up every gametype seen anywhere ----
  const all = harvestGametypes(report);
  const ante = [...all].filter(isAnte).sort();
  const other = [...all].filter((g) => !isAnte(g)).sort();

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log("\n══ gametypes seen ══");
  if (ante.length) {
    console.log("  ANTE:");
    for (const g of ante) console.log(`    ${g}`);
  } else {
    console.log("  ANTE: none seen yet");
  }
  if (other.length) console.log(`  other: ${other.slice(0, 14).join(", ")}${other.length > 14 ? ` (+${other.length - 14})` : ""}`);

  console.log(`\nfull report → ${OUT}`);
  if (!ante.length) {
    console.log(
      "\nNothing ante-flavoured surfaced. Fastest fix: open an ante spot in the\n" +
        "client yourself, then re-run with --url — that reads the gametype straight\n" +
        "off the address bar and cannot miss. Or --watch 90 and click through the\n" +
        "ante section while it records."
    );
  } else {
    console.log(
      "\nNext: add these to SOLUTION_SETS in services/gtowCdp.ts (with their depth\n" +
        "lists), then extend the PLAN in crawlPreflopTree.ts. No ranges were fetched."
    );
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
