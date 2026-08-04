/**
 * Capture GTO Wizard's own catalogue traffic to discover ANTE `gametype` ids.
 *
 * Why this and not discoverGtowFormats.ts's probe mode: fetching the API from
 * the page fails with a bare "TypeError: Failed to fetch" — the renderer's
 * CORS policy blocks a hand-rolled request even though the app's own calls to
 * the same host succeed. So guessing routes cannot work at all here; the only
 * reliable move is to record what the app itself asks for.
 *
 * Why its own CDP client: this needs Page.addScriptToEvaluateOnNewDocument,
 * which installs the recorder BEFORE any page script runs and survives
 * navigation. gtowCdp only exposes Runtime.evaluate (and drops protocol
 * events entirely — its socket handler ignores messages without an `id`), so
 * a recorder installed through it would be wiped by the very navigation that
 * triggers the catalogue fetch.
 *
 * DISCOVERY ONLY: navigates to the solutions browser and records responses.
 * No solution node is opened and no range is read.
 *
 * Usage (GTO Wizard running with --remote-debugging-port=9222):
 *   bun run src/scripts/captureGtowCatalog.ts
 *   bun run src/scripts/captureGtowCatalog.ts --wait 25 --out data/gtow-catalog.json
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) {
    const n = process.argv[i + 1];
    args.set(a.slice(2), n == null || n.startsWith("--") ? "1" : process.argv[++i]!);
  }
}
const PORT = parseInt(args.get("port") ?? "9222", 10);
const WAIT = parseInt(args.get("wait") ?? "20", 10);
const OUT = args.get("out") ?? "data/gtow-catalog.json";
const TARGET = args.get("url") ?? "https://app.gtowizard.com/solutions";

const RECORDER = `
(() => {
  if (window.__cap) return;
  window.__cap = [];
  const keep = (url, status, text) => {
    try {
      if (!/gtowizard\\.com/.test(url) || window.__cap.length > 600) return;
      let body = null;
      try { body = JSON.parse(text); } catch { body = String(text).slice(0, 200); }
      window.__cap.push({ url, status, size: (text || "").length, body });
    } catch {}
  };
  const of = window.fetch;
  window.fetch = async function (...a) {
    const r = await of.apply(this, a);
    try {
      const u = typeof a[0] === "string" ? a[0] : (a[0] && a[0].url) || "";
      r.clone().text().then((t) => keep(u, r.status, t)).catch(() => {});
    } catch {}
    return r;
  };
  const OX = window.XMLHttpRequest;
  function W() {
    const x = new OX(); let u = "";
    const oo = x.open;
    x.open = function (m, url, ...rest) { u = url; return oo.call(this, m, url, ...rest); };
    x.addEventListener("load", () => keep(u, x.status, x.responseText));
    return x;
  }
  W.prototype = OX.prototype;
  window.XMLHttpRequest = W;
})();
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  private ws!: WebSocket;
  private id = 1;
  private pending = new Map<number, (m: any) => void>();

  async connect(): Promise<string> {
    const list = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())) as any[];
    const page = list.find((t) => t.type === "page" && String(t.url).includes("gtowizard.com"));
    if (!page) throw new Error("no GTO Wizard page target on CDP — is the app running with --remote-debugging-port?");
    await new Promise<void>((res, rej) => {
      this.ws = new WebSocket(page.webSocketDebuggerUrl);
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", () => rej(new Error("CDP socket error")));
      this.ws.addEventListener("message", (e) => {
        const m = JSON.parse(e.data as string);
        if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); }
      });
      setTimeout(() => rej(new Error("CDP connect timeout")), 10_000);
    });
    return page.url;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.id++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${method} timed out`)), 30_000);
      this.pending.set(id, (m) => { clearTimeout(t); res(m); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const m = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text ?? "eval error");
    return m.result?.result?.value as T;
  }
  close() { try { this.ws.close(); } catch {} }
}

/** Pull gametype-shaped ids out of an arbitrary payload. */
function harvest(node: unknown, acc = new Set<string>()): Set<string> {
  if (node == null) return acc;
  if (typeof node === "string") {
    if (/^(Cash|Mtt|Spin|Hu)[A-Za-z0-9]{4,}$/.test(node)) acc.add(node);
    return acc;
  }
  if (Array.isArray(node)) { for (const v of node) harvest(v, acc); return acc; }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (/^(gametype|game_type|gameType|slug|id|value|name)$/.test(k) && typeof v === "string" && v.length > 4 && /[A-Z]/.test(v)) acc.add(v);
      harvest(v, acc);
    }
  }
  return acc;
}

async function main() {
  const cdp = new Cdp();
  const at = await cdp.connect();
  console.log(`connected — page is ${at}`);

  await cdp.send("Page.enable");
  // Installs before any page script on the NEXT document, so the catalogue
  // fetch that happens during boot is recorded rather than missed.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
  console.log("recorder armed; navigating to the solutions browser…");
  await cdp.send("Page.navigate", { url: TARGET });

  for (let i = 0; i < WAIT; i++) {
    await sleep(1000);
    try {
      const n = await cdp.eval<number>("(window.__cap||[]).length");
      process.stdout.write(`\r  ${i + 1}s — ${n} responses captured   `);
    } catch { /* mid-navigation, the context is briefly gone */ }
  }
  console.log();

  const entries = await cdp.eval<{ url: string; status: number; size: number; body: unknown }[]>("(window.__cap||[])");
  const href = await cdp.eval<string>("location.href");
  cdp.close();

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ href, entries }, null, 2));

  console.log(`\ncaptured ${entries.length} responses at ${href}`);
  const byUrl = entries
    .map((e) => ({ ...e, ante: /ante/i.test(JSON.stringify(e.body)) || /ante/i.test(e.url) }))
    .sort((a, b) => b.size - a.size);
  console.log("\nlargest responses:");
  for (const e of byUrl.slice(0, 12)) {
    console.log(`  ${String(e.status).padEnd(4)} ${String(e.size).padStart(8)}b ${e.ante ? "ANTE " : "     "} ${e.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 92)}`);
  }

  const all = harvest(entries);
  const ante = [...all].filter((g) => /ante/i.test(g)).sort();
  const other = [...all].filter((g) => !/ante/i.test(g)).sort();
  console.log(`\n══ gametypes seen (${all.size}) ══`);
  if (ante.length) { console.log("  ANTE:"); for (const g of ante) console.log(`    ${g}`); }
  else console.log("  ANTE: none in this capture");
  if (other.length) console.log(`  other (${other.length}): ${other.slice(0, 20).join(", ")}`);
  console.log(`\nfull capture → ${OUT}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
