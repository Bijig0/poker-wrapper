/**
 * THE CROSS-TABLE FIXES IN A REAL BROWSER (opt-in, like the rig test: WRAPPER_RIG_TEST=1 bun test). A headless
 * browser of its own (CDP :9393, a temp profile — never :9333 / :9392 or a window on screen) loads four of the fake
 * table's pages in ONE page, as the Ignition client seats four tables: same-origin iframes tagged
 * data-multitableslot 0..3 in a CSS grid, each dealt a different hand. Four wrappers are simulated in this process —
 * each with its own pin, all sharing the one page (and its registry of who holds which tag) — reading through the
 * wrapper's real snippets over the real CDP layer. Then the client does what it did at 18:13:18 on 2026-09-25: a
 * table closes and the grid re-tiles the other three.
 */
import { spawn, type Subprocess } from "bun";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { CdpSocket } from "../../src/cdp";
import { C } from "../../src/config";
import * as FAKE from "../../src/faketable";
import { S, resetState, seams } from "../../src/state";
import { heroCards, mySel, pinFrame, tableJs } from "../../src/ignition/dom";
import { act, pointIsMyTable } from "../../src/relay";
import { checker, J, scratchDirs } from "./helpers";

const ENABLED = process.env.WRAPPER_RIG_TEST === "1";
const HTTP = 7793, CDP = 9393;
// one hand per table, as the client deals them (the fake's card codes: rank + suit letter)
const HANDS = [["9s", "9c"], ["Qh", "8h"], ["8h", "Ac"], ["Ks", "5h"]];
const shown = (i: number) => HANDS[i]!.map(FAKE.displayCard);

async function until<T>(f: () => Promise<T | null | undefined | false>, s: number): Promise<T | null> {
  const end = Date.now() + s * 1000;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

test.skipIf(!ENABLED)("four tables in one real page: pins, a closed table, the press point, the hole-card guard", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  scratchDirs("cross-table-browser-");
  const profile = mkdtempSync(join(tmpdir(), "cross-table-browser-profile-"));
  const s0 = process.env.TABLE_SLOT, c0 = process.env.TABLE_COUNT;
  const server = Bun.serve({
    port: HTTP, hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      const html = (b: string) => new Response(b, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (u.pathname === "/") return html(FAKE.renderOuter("/frame?playMode=fun", 4));
      if (u.pathname === "/frame") {
        const i = Number(u.searchParams.get("slot") || 0);
        const spec = { ...FAKE.EXAMPLE_SPEC, title: `$1/$2 No Limit Hold'em — table ${i}`, heroCards: HANDS[i] };
        return html(FAKE.renderInner(spec).replace(/<link[^>]*fonts\.g[^>]*>/g, ""));
      }
      if (u.pathname.startsWith("/faketable/assets/")) {
        const got = FAKE.asset(decodeURIComponent(u.pathname.slice("/faketable/assets/".length)));
        return got ? new Response(got[0] as BodyInit, { headers: { "Content-Type": got[1] } }) : new Response("", { status: 404 });
      }
      return new Response("", { status: 404 });
    },
  });
  let browser: Subprocess | null = null;
  const log0 = console.log;
  const target0 = seams.ignitionTarget;
  try {
    browser = spawn({
      cmd: [C.CHROME, "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "--no-first-run",
            "--no-default-browser-check", "--window-size=1600,1000", `http://127.0.0.1:${HTTP}/`],
      stdout: "ignore", stderr: "ignore",
    });
    const page = await until(async () => (await cdp.pageTargets(CDP)).find((t: any) => String(t.url).includes(`127.0.0.1:${HTTP}`)), 30);
    check("the headless browser came up with the page", !!page);
    if (!page) return;
    const ws = page.webSocketDebuggerUrl!;
    const ready = await until(async () => (await cdp.evaluate(ws, `document.querySelectorAll('iframe').length === 4 && [...document.querySelectorAll('iframe')].every(f => f.contentDocument && f.contentDocument.readyState === 'complete' && f.contentDocument.querySelector('[data-qa]'))`, 4)) === true, 30);
    check("the four tables rendered", !!ready);
    seams.ignitionTarget = async () => page;
    console.log = () => {};

    // four wrappers, one page: each keeps its own pin (S.frame), the page keeps who holds which tag
    const pins = new Map<number, any>();
    const as = async <T>(slot: number, f: () => Promise<T>): Promise<T> => {
      process.env.TABLE_SLOT = String(slot);
      process.env.TABLE_COUNT = "4";
      resetState();
      if (pins.has(slot)) Object.assign(S.frame, pins.get(slot));
      try {
        return await f();
      } finally {
        pins.set(slot, { ...S.frame });
      }
    };
    const read = (slot: number) => as(slot, async () => {
      const d = (await cdp.evaluate(ws, tableJs(mySel()), 6)) || {};
      const what = pinFrame(d.frameTag ?? null, !!d.seated);
      return { seated: !!d.seated, tag: d.frameTag ?? null, cards: d.seated ? heroCards(d) : [], pin: S.frame.tag, what };
    });

    const first = [];
    for (let s = 1; s <= 4; s++) first.push(await read(s));
    eq("each wrapper's first read pins its own table's tag", first.map((r) => r.pin), ["0", "1", "2", "3"]);
    eq("  ... and reads that table's hand", first.map((r) => r.cards), [0, 1, 2, 3].map(shown));
    const rect = async (tag: string) => cdp.evaluate(ws, `(() => { const b = document.querySelector('iframe[data-multitableslot="${tag}"]').getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; })()`, 4);
    const before = await rect("2");

    // 18:13:18.5 — the top-right table closes; the client re-tiles the other three
    await cdp.evaluate(ws, `document.querySelector('iframe[data-multitableslot="1"]').remove(); true`, 4);
    const after = await rect("2");
    check("the client re-tiled: table 2 (the A8o table) moved on the page", J(before) !== J(after), J([before, after]));
    const old = await cdp.evaluate(ws, tableJs(2), 6);
    eq("BEFORE the fix, the 3rd table in order was now the neighbour's (A8o's reader moved onto K♠5♥)", heroCards(old || {}), shown(3));
    const now = [];
    for (let s = 1; s <= 4; s++) now.push(await read(s));
    eq("NOW every wrapper still reads its own table, wherever it moved", now.map((r) => r.cards), [shown(0), [], shown(2), shown(3)]);
    eq("  ... table 2, whose table is gone, reads nothing — and says so once", [now[1]!.seated, now[1]!.what], [false, "lost"]);

    // the press point, against the client's own hit-testing of the re-tiled page
    const inMine = await as(3, () => pointIsMyTable(ws, (after as any).x, (after as any).y));
    eq("a point inside table 2's frame is table 3's to press", inMine, null);
    const r3 = await rect("3");
    const inNext = await as(3, () => pointIsMyTable(ws, (r3 as any).x, (r3 as any).y));
    check("  ... one inside the neighbour's is refused", !!inNext && String(inNext).includes("table 3"), String(inNext));

    // the hole-card guard on a real press: table 3 asked to CALL for the neighbour's hand, then for its own
    const clicks = () => cdp.evaluate(ws, `(() => { const f = document.querySelector('iframe[data-multitableslot="2"]'); return JSON.stringify(f.contentWindow.__lastClick || null); })()`, 4);
    const wrong = await as(3, () => act("call", "action", { cards: HANDS[3], strict: true }));
    check("a CALL for K♠5♥ on the table showing 8♥A♣ is refused", !wrong.ok && wrong.wrongHand, J(wrong));
    eq("  ... nothing reached the table", await clicks(), "null");
    // in this 3-table tiling the frame (424 px) is shorter than the fake table: the CALL button sits below the frame,
    // on the page's own grid — found here, and the press is now refused rather than let through as "unknown"
    const clipped = await as(3, () => act("call", "action", { cards: HANDS[2], strict: true }));
    check("a CALL whose button lies outside our frame (clipped by the tiling) is refused", !clipped.ok && String(clipped.reason).includes("outside every table"), J(clipped));
    eq("  ... nothing reached the table", await clicks(), "null");
    // a viewport the tables fit in, as the live client's: the same press now lands on table 2's CALL
    const sock = await CdpSocket.open((await cdp.browserWs(CDP))!, 5);
    try {
      const win = (await sock.call(1, "Browser.getWindowForTarget", { targetId: page.id }, 5))?.result?.windowId;
      await sock.call(2, "Browser.setWindowBounds", { windowId: win, bounds: { width: 2560, height: 1700 } }, 5);
    } finally {
      sock.close();
    }
    await new Promise((r) => setTimeout(r, 500));
    const right = await as(3, () => act("call", "action", { cards: HANDS[2], strict: true }));
    check("the CALL for 8♥A♣ goes, on table 3's own table", right.ok, J(right));
    check("  ... and the table recorded it", String(await clicks()).toLowerCase().includes("call"), String(await clicks()));
  } finally {
    console.log = log0;
    seams.ignitionTarget = target0;
    try { browser?.kill(); } catch {}
    server.stop(true);
    if (s0 === undefined) delete process.env.TABLE_SLOT;
    else process.env.TABLE_SLOT = s0;
    if (c0 === undefined) delete process.env.TABLE_COUNT;
    else process.env.TABLE_COUNT = c0;
    resetState();
    await new Promise((r) => setTimeout(r, 1000));
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  expect(fails).toEqual([]);
}, 120_000);
