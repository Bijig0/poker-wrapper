/**
 * THE DEEP-STACK RESET ON THE PANEL (2026-10-09, Brady: when the reset triggers, that table's panel says so,
 * prominently, and keeps saying which step it is in until a fresh table is seated — the feed line alone scrolled away).
 * Here: the panel's own banner renderer and the leader's table-grid card, read straight out of panel.html and run
 * against a stub DOM (as machine-load.test.ts does for the load chip), and GET /tables carrying each table's step.
 * The wording itself is stackResetBanner's (stack-reset.test.ts walks it through a whole reset).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reloadConfig } from "../../src/config";
import { tablesOverview } from "../../src/session";
import { S, resetState, seams } from "../../src/state";

const PAGES = join(import.meta.dir, "..", "..", "..", "..", "..", "ignition-study-wrapper");
const html = readFileSync(join(PAGES, "panel.html"), "utf-8").replace(/\r\n/g, "\n");
const fnSrc = (head: string, close = "\n  }\n") => {
  const start = html.indexOf(head);
  expect(start).toBeGreaterThan(0);
  return html.slice(start, html.indexOf(close, start) + close.length);
};
const line = (head: string) => fnSrc(head, ";\n");

const BANNER = {
  armed: { phase: "armed", level: "reset", text: "Max deep stack (150 bb) reached at 180 bb — reseating: sitting out at the next big blind",
           detail: "\"Sit out next big blind\" pressed (1/3) — waiting for the big blind to pass", short: "max deep stack — sitting out at the next BB" },
  waiting: { phase: "waiting", level: "reset", text: "Max deep stack reached — left the table, a fresh seat in 42 s",
             detail: "then a fresh table of this session's format at the normal buy-in, in this slot", short: "max deep stack — new seat in 42 s" },
  reseating: { phase: "reseating", level: "reset", text: "Max deep stack reached — waiting for the new table to seat",
               detail: "3 s since the wait ended (given up after 600 s)", short: "max deep stack — reseating" },
  done: { phase: "done", level: "ok", text: "Reseated at a fresh table (105 s)", detail: null, short: "reseated at a fresh table (105 s)" },
  aborted: { phase: "aborted", level: "bad", text: "Deep stack reset given up — pressed I AM BACK",
             detail: "the leave failed (while leaving) — not tried again for 10 hands", short: "deep-stack reset given up" },
};

describe("the panel's banner", () => {
  const make = () => {
    let writes = 0;
    const part = () => ({ _t: "", get textContent() { return this._t; }, set textContent(v: string) { writes++; this._t = v; } });
    const t = part(), d = part();
    const el: any = { dataset: {}, style: { display: "none" }, className: "",
                      querySelector: (q: string) => (q === ".rb-t" ? t : q === ".rb-d" ? d : null) };
    const document = { getElementById: (id: string) => (id === "reset-banner" ? el : null) };
    const src = `${line("const RESET_ICON = {")}${fnSrc("function renderStackReset(sr) {")}`;
    const render = new Function("document", `${src}; return renderStackReset;`)(document) as (sr: any) => void;
    return { el, t, d, render, writes: () => writes };
  };

  test("every step in the wrapper's words: blue while under way, green when reseated, amber when given up; gone with nothing to say", () => {
    const { el, t, d, render } = make();
    render({ state: "armed", banner: BANNER.armed });
    expect([el.style.display, el.className, t.textContent, d.textContent]).toEqual(["block", "", `↻ ${BANNER.armed.text}`, BANNER.armed.detail]);
    render({ state: "waiting", banner: BANNER.waiting });
    expect([el.className, t.textContent]).toEqual(["", "↻ Max deep stack reached — left the table, a fresh seat in 42 s"]);
    render({ state: "reseating", banner: BANNER.reseating });
    expect(t.textContent).toBe("↻ Max deep stack reached — waiting for the new table to seat");
    render({ state: "idle", banner: BANNER.done });
    expect([el.style.display, el.className, t.textContent, d.textContent]).toEqual(["block", "ok", "✓ Reseated at a fresh table (105 s)", ""]);
    render({ state: "idle", banner: BANNER.aborted });
    expect([el.className, t.textContent, d.textContent]).toEqual(["bad", `⚠ ${BANNER.aborted.text}`, BANNER.aborted.detail]);
    render({ state: "idle", banner: null });
    expect(el.style.display).toBe("none");
    render({ state: "armed", banner: BANNER.armed });
    render(undefined);                                                    // the reset off for the session: no stackReset key
    expect(el.style.display).toBe("none");
  });

  test("the same banner again touches nothing (the 1 Hz poll never re-writes it); the countdown does", () => {
    const { render, writes } = make();
    render({ banner: BANNER.waiting });
    render({ banner: BANNER.waiting });
    expect(writes()).toBe(2);                                             // the line and the detail, once
    render({ banner: { ...BANNER.waiting, text: BANNER.waiting.text.replace("42", "41") } });
    expect(writes()).toBe(4);
  });

  test("where it sits: in the page's flow under the health banner, above the header — never over the answer or the buttons", () => {
    const at = (s: string) => html.indexOf(s);
    expect(at('<div id="reset-banner"')).toBeGreaterThan(at('<div id="health-banner"'));
    expect(at('<div id="reset-banner"')).toBeLessThan(at('<div class="top">'));
    expect(at('<div id="reset-banner"')).toBeLessThan(at('<div class="card" id="sa-card">'));
    expect(html).toMatch(/#reset-banner \{ display: none;[^}]*\}/);
    expect(html).not.toMatch(/#reset-banner \{[^}]*position: (fixed|absolute|sticky)/);
    expect(html).toContain("renderStackReset(s.stackReset);");
  });

  test("while a reset is under way, the controls card does not tell you to press I AM BACK", () => {
    const src = `${line("const RESET_UNDER_WAY = new Set(")}${line("const resetUnderWay = () =>")}`;
    const under = (st: any) => new Function("LAST_STATE", `${src}; return resetUnderWay();`)(st) as boolean;
    expect(under({ stackReset: { banner: BANNER.armed } })).toBe(true);
    expect(under({ stackReset: { banner: { ...BANNER.armed, phase: "sat-out" } } })).toBe(true);
    expect(under({ stackReset: { banner: BANNER.done } })).toBe(false);
    expect(under({ stackReset: { banner: BANNER.aborted } })).toBe(false);
    expect(under({})).toBe(false);
    expect(under(null)).toBe(false);
    expect(html).toContain("Sitting out for the deep-stack reset — do not press I AM BACK");
  });
});

describe("the leader's table grid", () => {
  const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const src = `${line("const RESET_UNDER_WAY = new Set(")}${fnSrc("const cards = (t) => {", "\n  };\n")}`;
  const cards = new Function("esc", `${src}; return cards;`)(esc) as (t: any) => string;
  const T = { slot: 2, panelPort: 7702, me: false, reachable: true, closed: false, answersOn: true, heroCards: [], street: null, ended: false };

  test("a table resetting shows its step, in blue; reseated in green, given up in amber; none without one", () => {
    const rs = cards({ ...T, stackReset: "reseating", stackResetText: "max deep stack — reseating" });
    expect(rs).toContain('<div class="tcard reset">');
    expect(rs).toContain('<div class="tr ">max deep stack — reseating</div>');
    expect(cards({ ...T, stackReset: "done", stackResetText: "reseated at a fresh table (105 s)" }))
      .toContain('<div class="tr ok">reseated at a fresh table (105 s)</div>');
    const ab = cards({ ...T, stackReset: "aborted", stackResetText: "deep-stack reset given up" });
    expect(ab).toContain('<div class="tr bad">deep-stack reset given up</div>');
    expect(ab).not.toContain("tcard reset");
    const none = cards({ ...T, stackReset: null, stackResetText: null });
    expect(none).not.toContain('class="tr');
    expect(none).toContain('<div class="tcard ">');
  });
});

describe("GET /tables carries each table's step", () => {
  let peer: ReturnType<typeof Bun.serve>;
  let peerState: any = {};
  const reg0 = seams.registry;
  const env0 = { slot: process.env.TABLE_SLOT, count: process.env.TABLE_COUNT };
  beforeAll(() => {
    peer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(peerState) });
    process.env.TABLE_SLOT = "1";
    process.env.TABLE_COUNT = "2";
    reloadConfig();
    resetState();
    seams.registry = () => [{ slot: 1, panelPort: 7701, live: true, me: true }, { slot: 2, panelPort: peer.port, live: true }] as any;
  });
  afterAll(() => {
    peer.stop(true);
    seams.registry = reg0;
    if (env0.slot === undefined) delete process.env.TABLE_SLOT; else process.env.TABLE_SLOT = env0.slot;
    if (env0.count === undefined) delete process.env.TABLE_COUNT; else process.env.TABLE_COUNT = env0.count;
    reloadConfig();
    resetState();
  });

  test("the phase and its few words per table; null for a table with nothing to say or the reset off", async () => {
    peerState = { ok: true, studyAnswers: true, connected: false, hand: null, stackReset: { state: "reseating", banner: BANNER.reseating } };
    const mine = { ok: true, studyAnswers: true, connected: true, hand: {}, stackReset: { state: "idle", banner: null } };
    let view = Object.fromEntries((await tablesOverview(async () => mine)).tables.map((c: any) => [c.slot, c]));
    expect([view[2]?.stackReset, view[2]?.stackResetText]).toEqual(["reseating", "max deep stack — reseating"]);
    expect([view[1]?.stackReset, view[1]?.stackResetText]).toEqual([null, null]);
    peerState = { ok: true, studyAnswers: true, connected: true, hand: {} };                // the reset off: no stackReset key
    view = Object.fromEntries((await tablesOverview(async () => ({ ...mine, stackReset: { state: "waiting", banner: BANNER.waiting } })))
      .tables.map((c: any) => [c.slot, c]));
    expect([view[1]?.stackReset, view[1]?.stackResetText]).toEqual(["waiting", "max deep stack — new seat in 42 s"]);
    expect([view[2]?.stackReset, view[2]?.stackResetText]).toEqual([null, null]);
    expect(S.session.id).toBeNull();
  });
});
