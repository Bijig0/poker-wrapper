/**
 * STALE CODE IN THE CLIENT'S PAGE (audit 2026-10-13). Two snippets leave code running inside the Ignition page and
 * installed it only when missing: the action watcher (launch.WATCH_JS_TMPL, `__ignWatch`, a 120 ms timer) and the
 * draw heartbeat (launch.TABLE_JS_TMPL, `__wrapperDraw`, a requestAnimationFrame loop). The Ignition window outlives
 * a wrapper relaunch, so the page went on running the OLD code until the table's frame reloaded. Now each carries a
 * version (src/js.ts: a hash of the snippet's own text) and a handle; a different version — or none, every snippet
 * before this date — is stopped and replaced exactly once.
 *
 * The snippets run here for real, against a page shim with fake timers and a fake animation-frame queue (callbacks
 * of one frame run in the order they were asked for; one asked for during a frame runs in the next). The OLD snippets
 * are the real old texts: today's file with the page-js revisions of the given date and later swapped back
 * (test/golden/page-js-revisions.json — what the goldens hold every recorded question to).
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { slotted, tableJs, watchJs } from "../../src/ignition/dom";
import { js, snippetVersion, versionOf, withVersion } from "../../src/js";
import { checker, J } from "./helpers";

const SRC = join(import.meta.dir, "..", "..", "src", "js");
const raw = (name: string) => readFileSync(join(SRC, `${name}.js`), "utf8").replace(/\r\n/g, "\n");
const REVISIONS: { date: string; old: string; new: string }[] =
  JSON.parse(readFileSync(join(import.meta.dir, "..", "golden", "page-js-revisions.json"), "utf8"));
/** The snippet as it was before `date`: every revision of that date or later swapped back, newest first. */
function before(name: string, date: string): string {
  let s = raw(name);
  for (const r of [...REVISIONS].reverse()) if (r.date >= date) s = s.split(r.new).join(r.old);
  if (s.includes("__VERSION__")) throw new Error(`${name} before ${date} still names a version`);
  return slotted(s, null);
}
/** Today's snippet with a different version: the same code, its text edited (a comment). */
function otherVersion(name: string): string {
  return slotted(withVersion(name, raw(name) + "\n// another build\n").code, null);
}

// ---- the page shim ---------------------------------------------------------------------------------------------
type Text = { s: string; x: number; y: number; w?: number; h?: number };

class Page {
  clock = 1000;                                   // the frame's performance.now() and the top page's Date.now()
  // the top page's timers (the snippets run in the top page: their setInterval is the top page's)
  private nextTimer = 100;
  intervals = new Map<number, () => void>();
  timeouts = new Map<number, () => void>();
  cleared: number[] = [];
  // the frame's animation-frame queue
  private nextRaf = 1;
  pending = new Map<number, (t: number) => void>();
  wrongReceiver = 0;
  errors: string[] = [];
  texts: Text[] = [];
  fw: Record<string, any>;
  tf: Record<string, any>;
  nativeRaf: (cb: (t: number) => void) => number;

  constructor() {
    const self = this;
    this.nativeRaf = function (this: unknown, cb: (t: number) => void) {
      if (this !== self.fw) self.wrongReceiver++;
      const id = self.nextRaf++;
      self.pending.set(id, cb);
      return id;
    };
    this.fw = {
      performance: { now: () => this.clock },
      requestAnimationFrame: this.nativeRaf,              // an own property of the window, as in Chrome
      cancelAnimationFrame: (id: number) => { this.pending.delete(id); },
      getComputedStyle: () => ({ visibility: "visible", opacity: "1", zoom: "1" }),
    };
    this.tf = {
      src: "https://client/table?playMode=real", isConnected: true,
      getAttribute: (n: string) => (n === "src" ? this.tf.src : null),
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 900, height: 650, left: 0, top: 0, right: 900, bottom: 650 }),
      contentWindow: this.fw,
    };
    this.newDocument();
  }

  /** A same-origin load: the frame's document is replaced, its Window kept — and the old document's frame
   *  callbacks never run. */
  newDocument() {
    const page = this;
    const body = { parentElement: null };
    const doc: Record<string, any> = {
      body, defaultView: this.fw, documentElement: { clientHeight: 654 },
      querySelectorAll: () => [], querySelector: () => null,
      createTreeWalker: () => {
        const nodes = page.texts.map((t) => ({ nodeValue: t.s, parentElement: { parentElement: body }, box: t }));
        let i = 0;
        return { nextNode: () => nodes[i++] ?? null };
      },
      createRange: () => {
        let n: any = null;
        return { selectNodeContents: (x: any) => { n = x; },
                 getBoundingClientRect: () => ({ x: n.box.x, y: n.box.y, width: n.box.w ?? 10, height: n.box.h ?? 14 }) };
      },
    };
    this.fw.document = doc;
    this.tf.contentDocument = doc;
    this.pending.clear();
  }

  /** Evaluate a snippet in the top page, as cdp.evaluate does. */
  run(code: string): any {
    const document = {
      visibilityState: "visible",
      querySelectorAll: (sel: string) => (sel === "iframe" ? [this.tf] : []),
    };
    const T = this;
    const f = new Function("document", "window", "innerWidth", "innerHeight", "NodeFilter", "Date",
                           "setInterval", "clearInterval", "setTimeout", "return " + code);
    try {
      return f(document, {}, 1920, 1080, { SHOW_TEXT: 4 }, { now: () => this.clock },
               (fn: () => void) => { const id = T.nextTimer++; T.intervals.set(id, fn); return id; },
               (id: number) => { T.cleared.push(id); T.intervals.delete(id); },
               (fn: () => void) => { const id = T.nextTimer++; T.timeouts.set(id, fn); return id; });
    } catch (e: any) {
      this.errors.push(String(e?.message ?? e));
      return undefined;
    }
  }

  /** One tick of every live interval (the watcher's 120 ms). */
  tick(ms = 120) {
    this.clock += ms;
    for (const fn of [...this.intervals.values()]) {
      try { fn(); } catch (e: any) { this.errors.push(String(e?.message ?? e)); }
    }
  }

  /** One drawn frame: the callbacks asked for before it, in order. */
  frame(ms = 16) {
    this.clock += ms;
    const run = [...this.pending.entries()].sort((a, b) => a[0] - b[0]);
    this.pending.clear();
    for (const [, cb] of run) {
      try { cb(this.clock); } catch (e: any) { this.errors.push(String(e?.message ?? e)); }
    }
  }

  runTimeouts() {
    for (const [id, fn] of [...this.timeouts]) {
      this.timeouts.delete(id);
      fn();
    }
  }
}

// ---- the version ----------------------------------------------------------------------------------------------
test("a snippet's version is a hash of its own text, written in when the wrapper loads it", () => {
  const { fails, check } = checker();
  for (const name of ["launch.TABLE_JS_TMPL", "launch.WATCH_JS_TMPL"]) {
    const v = snippetVersion(name);
    check(`${name}: the version is <name>@<12 hex>`, v !== null && new RegExp(`^${name.replace(".", "\\.")}@[0-9a-f]{12}$`).test(v), String(v));
    check(`${name}: it is the hash of the file's text (LF)`, v === versionOf(name, raw(name)), `${v} vs ${versionOf(name, raw(name))}`);
    check(`${name}: written into the snippet as a JS string`, js(name).includes(JSON.stringify(v)) && !js(name).includes("__VERSION__"));
    check(`${name}: every table's copy carries the same version`,
          tableJs(null).includes(JSON.stringify(snippetVersion("launch.TABLE_JS_TMPL")))
          && watchJs({ ord: 1, me: 2 }).includes(JSON.stringify(snippetVersion("launch.WATCH_JS_TMPL"))));
    check(`${name}: a checkout's CRLF is the same version`, versionOf(name, raw(name).replace(/\n/g, "\r\n")) === v);
    check(`${name}: any edit is a new version`, withVersion(name, raw(name) + " ").version !== v);
  }
  check("a snippet that installs nothing has no version", snippetVersion("launch.FRAME_JS") === null && snippetVersion("launch.FIND_INPUT_JS_TMPL") === null);
  check("the frame pins (window.__pwFramePins) are data, not versioned: no token in the resolver", !js("launch.FRAME_JS").includes("@"));
  expect(fails).toEqual([]);
});

// ---- the action watcher ---------------------------------------------------------------------------------------
const SEAT3_CALL: Text[] = [{ s: "3", x: 100, y: 100 }, { s: "CALL", x: 130, y: 110, w: 40 }];

test("watcher: installed when absent, left alone at the same version", () => {
  const { fails, check } = checker();
  const p = new Page();
  const V = snippetVersion("launch.WATCH_JS_TMPL");
  check("first drain: nothing yet", J(p.run(watchJs(null))) === "[]");
  const h = p.fw.__ignWatch;
  check("one timer", p.intervals.size === 1, `${p.intervals.size}`);
  check("its handle: version, document, stop()", h && h.version === V && h.doc === p.tf.contentDocument && typeof h.stop === "function", J(h && Object.keys(h)));
  p.texts = SEAT3_CALL;
  p.tick();
  const got = p.run(watchJs(null));
  check("seat 3's CALL drained once", got?.length === 1 && got[0].seat === 3 && got[0].badge === "CALL", J(got));
  for (let i = 0; i < 5; i++) { p.tick(); p.run(watchJs(null)); }
  check("the same version: the same watcher, still one timer, nothing cleared",
        p.fw.__ignWatch === h && p.intervals.size === 1 && p.cleared.length === 0, `${p.intervals.size} timers, cleared ${J(p.cleared)}`);
  check("no error in the page", p.errors.length === 0, J(p.errors));
  expect(fails).toEqual([]);
});

test("watcher: the OLD one (no version: the global was the bare timer id) is stopped, its events kept, the new one installed once", () => {
  const { fails, check } = checker();
  const p = new Page();
  p.run(before("launch.WATCH_JS_TMPL", "2026-10-13"));
  const oldId = p.fw.__ignWatch;
  check("the old watcher: a bare setInterval id", typeof oldId === "number" && p.intervals.has(oldId), J(oldId));
  p.texts = SEAT3_CALL;
  p.tick();                                            // the old one sees seat 3 call; nobody has drained it yet
  const got = p.run(watchJs(null));
  check("the old timer is cleared", p.cleared.includes(oldId) && !p.intervals.has(oldId), J(p.cleared));
  check("exactly one timer runs: the new one", p.intervals.size === 1 && p.fw.__ignWatch.timer === [...p.intervals.keys()][0], `${p.intervals.size}`);
  check("the new handle carries this version", p.fw.__ignWatch.version === snippetVersion("launch.WATCH_JS_TMPL"));
  check("the event the old one caught comes out of the first drain", got?.length === 1 && got[0].badge === "CALL", J(got));
  p.texts = [...SEAT3_CALL, { s: "5", x: 400, y: 100 }, { s: "FOLD", x: 430, y: 110, w: 40 }];
  p.tick();
  const next = p.run(watchJs(null));
  // the old one's document is unknown (it may have watched the blank one a load replaced): the new one starts as a
  // first install does, reporting what the seats show
  check("the new one reads the table: seat 5 folds", next?.some((e: any) => e.seat === 5 && e.badge === "FOLD"), J(next));
  check("no error in the page", p.errors.length === 0, J(p.errors));
  expect(fails).toEqual([]);
});

test("watcher: another version is stopped by its own stop(); on the same document a badge already reported is not reported again", () => {
  const { fails, check } = checker();
  const p = new Page();
  p.run(otherVersion("launch.WATCH_JS_TMPL"));
  const old = p.fw.__ignWatch;
  check("the other version is installed", old.version !== snippetVersion("launch.WATCH_JS_TMPL") && p.intervals.size === 1);
  p.texts = SEAT3_CALL;
  p.tick();
  const first = p.run(otherVersion("launch.WATCH_JS_TMPL"));
  check("it reported seat 3's CALL", first?.length === 1, J(first));
  p.run(watchJs(null));
  check("the old one is stopped", old.stopped === true && !p.intervals.has(old.timer));
  check("exactly one timer: the new one", p.intervals.size === 1 && p.fw.__ignWatch !== old && p.fw.__ignWatch.timer === [...p.intervals.keys()][0]);
  p.tick(); p.tick();
  check("the CALL already on seat 3 is not a new action", J(p.run(watchJs(null))) === "[]");
  // the old wrapper (still running) reads again: the two never both run
  p.run(otherVersion("launch.WATCH_JS_TMPL"));
  check("a read by the other version swaps back — still exactly one timer", p.intervals.size === 1, `${p.intervals.size}`);
  check("no error in the page", p.errors.length === 0, J(p.errors));
  expect(fails).toEqual([]);
});

test("watcher: replaced, its document replaced, or its frame gone, it stops itself; the next drain watches the new document", () => {
  const { fails, check } = checker();
  const p = new Page();
  p.run(watchJs(null));
  const a = p.fw.__ignWatch;
  p.fw.__ignWatch = { version: "someone-else" };
  p.tick();
  check("superseded: stopped at its next tick", a.stopped === true && p.intervals.size === 0);
  p.fw.__ignWatch = undefined;
  p.run(watchJs(null));
  const b = p.fw.__ignWatch;
  p.newDocument();
  p.tick();
  check("its document replaced (the Window kept): stopped", b.stopped === true && p.intervals.size === 0);
  p.texts = SEAT3_CALL;
  p.run(watchJs(null));
  const c = p.fw.__ignWatch;
  check("the next drain watches the new document", c !== b && c.doc === p.tf.contentDocument && p.intervals.size === 1);
  p.tick();
  check("... and reads it", p.run(watchJs(null))?.length === 1);
  p.tf.isConnected = false;
  p.tick();
  check("its frame gone: stopped", c.stopped === true && p.intervals.size === 0);
  check("no error in the page", p.errors.length === 0, J(p.errors));
  expect(fails).toEqual([]);
});

// ---- the draw heartbeat ---------------------------------------------------------------------------------------
test("heartbeat: installed when absent, left alone at the same version and document", () => {
  const { fails, check } = checker();
  const p = new Page();
  const d = p.run(tableJs(null));
  const hb = p.fw.__wrapperDraw;
  check("the read works", d?.seated === true && d.draw && d.draw.beats === 0 && !("replaced" in d.draw), J(d?.draw));
  check("its handle: version, document, stop()", hb.version === snippetVersion("launch.TABLE_JS_TMPL") && hb.doc === p.fw.document && typeof hb.stop === "function");
  check("one frame callback asked for", p.pending.size === 1);
  p.frame(); p.frame(); p.frame();
  for (let i = 0; i < 4; i++) p.run(tableJs(null));
  p.frame();
  check("the same heartbeat, one beat a frame", p.fw.__wrapperDraw === hb && hb.n === 4 && p.pending.size === 1, `n ${hb.n}, pending ${p.pending.size}`);
  check("the client's requestAnimationFrame is untouched", p.fw.requestAnimationFrame === p.nativeRaf && p.wrongReceiver === 0);
  check("no error in the page", p.errors.length === 0, J(p.errors));
  expect(fails).toEqual([]);
});

test("heartbeat: the one before 2026-10-12 (no handle, its loop checks nothing) is stopped — no error in the page, the client's rAF restored", () => {
  const { fails, check } = checker();
  const p = new Page();
  p.run(before("launch.TABLE_JS_TMPL", "2026-10-12"));
  const old = p.fw.__wrapperDraw;
  p.frame(); p.frame();
  check("the old heartbeat beats", old.n === 2 && !("version" in old) && !("doc" in old), J(old));
  // the client asks for frames of its own all along
  let client = 0;
  const clientLoop = () => { client++; p.fw.requestAnimationFrame(clientLoop); };
  p.fw.requestAnimationFrame(clientLoop);
  const d = p.run(tableJs(null));
  const hb = p.fw.__wrapperDraw;
  check("replaced, and the read says so once", d?.draw?.replaced === "unversioned" && hb !== old && hb.version === snippetVersion("launch.TABLE_JS_TMPL"), J(d?.draw));
  check("its document unknown: a fresh reading", d.draw.beats === 0 && d.draw.ageMs === 0, J(d.draw));
  check("until the next frame the trap stands in for requestAnimationFrame", p.fw.requestAnimationFrame !== p.nativeRaf);
  p.frame();
  check("after one frame the client's own requestAnimationFrame is back", p.fw.requestAnimationFrame === p.nativeRaf);
  for (let i = 0; i < 5; i++) p.frame();
  check("the old loop ended: its count stands", old.n === 3, `old n ${old.n}`);
  check("ours beats once a frame", hb.n === 6, `n ${hb.n}`);
  check("the client's own loop never missed a frame", client === 6, `${client}`);
  check("two callbacks pending: the client's and ours — never the old one's", p.pending.size === 2, `${p.pending.size}`);
  check("every request reached the window as its own", p.wrongReceiver === 0);
  check("the 5 s fallback has nothing left to do", (p.runTimeouts(), p.fw.requestAnimationFrame === p.nativeRaf));
  check("a second read leaves it alone", (p.run(tableJs(null))?.draw?.replaced === undefined) && p.fw.__wrapperDraw === hb);
  check("no error in the page", p.errors.length === 0, J(p.errors));
  expect(fails).toEqual([]);
});

test("heartbeat: an old one already dead (its document replaced) — the trap comes off at our first beat; a frame never drawn — after 5 s", () => {
  const { fails, check } = checker();
  const p = new Page();
  p.run(before("launch.TABLE_JS_TMPL", "2026-10-12"));
  p.newDocument();                                     // the load replaced the document: the old beat's callback is gone
  p.run(tableJs(null));
  check("the trap is up", p.fw.requestAnimationFrame !== p.nativeRaf);
  p.frame();
  check("our first beat takes it off", p.fw.requestAnimationFrame === p.nativeRaf && p.pending.size === 1);

  const q = new Page();
  q.run(before("launch.TABLE_JS_TMPL", "2026-10-12"));
  q.run(tableJs(null));                                // a hidden frame: no frame is drawn
  check("hidden: the trap waits for a frame", q.fw.requestAnimationFrame !== q.nativeRaf);
  q.runTimeouts();
  check("5 s on, it comes off anyway", q.fw.requestAnimationFrame === q.nativeRaf);
  check("no error in either page", p.errors.length === 0 && q.errors.length === 0, J([p.errors, q.errors]));
  expect(fails).toEqual([]);
});

test("heartbeat: the 2026-10-12 one ({doc}, stops itself once replaced) — no trap, its reading carried over", () => {
  const { fails, check } = checker();
  const p = new Page();
  p.run(before("launch.TABLE_JS_TMPL", "2026-10-13"));
  const old = p.fw.__wrapperDraw;
  p.frame(); p.frame(); p.frame();
  check("the old heartbeat beats", old.n === 3 && old.doc === p.fw.document && !("version" in old), J(Object.keys(old)));
  p.clock += 400;                                      // 400 ms since its last beat
  const d = p.run(tableJs(null));
  const hb = p.fw.__wrapperDraw;
  check("replaced", d?.draw?.replaced === "unversioned" && hb !== old);
  check("no trap: it stops by itself", p.fw.requestAnimationFrame === p.nativeRaf);
  check("its reading carried over: 3 beats, idle 400 ms", d.draw.beats === 3 && d.draw.idleMs === 400 && d.draw.ageMs === 448, J(d.draw));
  p.frame(); p.frame();
  check("the old loop ended", old.n === 3 && p.pending.size === 1, `old n ${old.n}, pending ${p.pending.size}`);
  check("ours goes on from there", hb.n === 5, `${hb.n}`);
  check("no error in the page", p.errors.length === 0, J(p.errors));
  expect(fails).toEqual([]);
});

test("heartbeat: another version is stopped by its own stop() and its frame request cancelled; a new document is a fresh heartbeat", () => {
  const { fails, check } = checker();
  const p = new Page();
  p.run(otherVersion("launch.TABLE_JS_TMPL"));
  const old = p.fw.__wrapperDraw;
  p.frame(); p.frame();
  const d = p.run(tableJs(null));
  const hb = p.fw.__wrapperDraw;
  check("replaced, named by its version", d?.draw?.replaced === old.version && old.version !== hb.version, J(d?.draw));
  check("exactly one frame callback: ours (the old one's cancelled)", p.pending.size === 1);
  check("its reading carried over", d.draw.beats === 2);
  p.frame();
  check("one beat a frame, on ours only", hb.n === 3 && old.n === 2);
  // the other version's wrapper reads again: they swap, never both run
  p.run(otherVersion("launch.TABLE_JS_TMPL"));
  p.frame();
  check("swapped back: still one callback a frame", p.pending.size === 1 && p.fw.__wrapperDraw.n === 4, `${p.pending.size}`);
  p.run(tableJs(null));
  const mine = p.fw.__wrapperDraw;
  p.newDocument();
  const e = p.run(tableJs(null));
  check("a new document: a fresh heartbeat on it, not a version change", p.fw.__wrapperDraw !== mine
        && p.fw.__wrapperDraw.doc === p.fw.document && e.draw.beats === 0 && !("replaced" in e.draw), J(e?.draw));
  p.frame();
  check("... and it beats", p.fw.__wrapperDraw.n === 1 && p.pending.size === 1);
  check("the client's requestAnimationFrame untouched throughout", p.fw.requestAnimationFrame === p.nativeRaf && p.wrongReceiver === 0);
  check("no error in the page", p.errors.length === 0, J(p.errors));
  expect(fails).toEqual([]);
});
