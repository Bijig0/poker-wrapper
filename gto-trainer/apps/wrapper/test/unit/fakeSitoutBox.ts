/**
 * A FAKE TABLE FRAME FOR THE SIT-OUT READS — "Sit out next big blind" (stackReset.ts, 2026-10-09) and "Sit out next
 * hand" (netguard.ts, the connection guard, ported the same day) — just enough DOM for the REAL page snippet
 * (src/js/sitout.READ_JS_TMPL.js, aimed at either label, with launch.FRAME_JS's __frame) to run over: elements
 * with text, children, attributes, computed style (display / visibility / opacity), boxes, a Range over an element's
 * contents, `.click()`, and CDP's pointer click hit-testing the boxes. The snippet is evaluated as the page would
 * (new Function over this document), so the test exercises the code that runs live, not a stand-in for it.
 *
 * What a click does is the browser's own behaviour, modelled: a checkbox input toggles; a <label> ticks the checkbox
 * inside it (or the one it names); otherwise the click bubbles to the first element with a handler (the client's
 * row / box components). `undrawn` = every box measures 0 x 0 (the case the brief suspected: a frame Chrome has
 * stopped drawing) — the snippet must still find the label by its text and the press go through the DOM.
 */
import * as cdp from "../../src/cdp";
import { seams } from "../../src/state";

type Rect = { x: number; y: number; width: number; height: number };
const ZERO: Rect = { x: 0, y: 0, width: 0, height: 0 };

export class FEl {
  tagName: string;
  children: FEl[] = [];
  parentElement: FEl | null = null;
  text = "";
  attrs: Record<string, string> = {};
  style: { display?: string; visibility?: string; opacity?: string } = {};
  hidden = false;
  checked = false;
  type = "";
  rect: Rect = ZERO;
  /** what a Range over the contents measures (an element with display: contents measures 0 x 0 itself) */
  contentRect: Rect | null = null;
  control: FEl | undefined = undefined;
  onClick: (() => void) | null = null;
  clicks = 0;
  doc: FDoc | null = null;
  constructor(tag: string, o: Partial<FEl> = {}, kids: FEl[] = []) {
    this.tagName = tag.toUpperCase();
    Object.assign(this, o);
    for (const k of kids) this.append(k);
  }
  append(k: FEl): FEl {
    k.parentElement = this;
    this.children.push(k);
    return k;
  }
  get textContent(): string {
    return this.children.map((c) => c.textContent).join("") + this.text;
  }
  hasAttribute(k: string): boolean { return k in this.attrs; }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k] : null; }
  private matches(sel: string): boolean {
    if (sel === "*") return true;
    if (sel === "input[type=checkbox]") return this.tagName === "INPUT" && this.type === "checkbox";
    if (sel === "[aria-checked]") return "aria-checked" in this.attrs;
    const m = /^\[([\w-]+)='([^']*)'\]$/.exec(sel);
    if (m) return this.attrs[m[1]] === m[2];
    throw new Error(`fakeSitoutBox: selector not modelled: ${sel}`);
  }
  querySelectorAll(sel: string): FEl[] {
    const out: FEl[] = [];
    const walk = (e: FEl) => { for (const c of e.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel: string): FEl | null { return this.querySelectorAll(sel)[0] ?? null; }
  getBoundingClientRect(): Rect { return this.doc?.undrawn ? ZERO : this.rect; }
  get outerHTML(): string {
    const a = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
    return `<${this.tagName.toLowerCase()}${a}${this.type ? ` type="${this.type}"` : ""}${this.checked ? " checked" : ""}>`
      + this.children.map((c) => c.outerHTML).join("") + this.text + `</${this.tagName.toLowerCase()}>`;
  }
  click(): void {
    this.clicks++;
    for (let e: FEl | null = this; e; e = e.parentElement) {
      if (e.tagName === "INPUT" && e.type === "checkbox") { e.checked = !e.checked; return; }
      if (e.tagName === "LABEL") {
        const box = e.control ?? e.querySelector("input[type=checkbox]");
        if (box) { box.checked = !box.checked; return; }
      }
      if (e.onClick) { e.onClick(); return; }
    }
  }
}

export class FDoc {
  undrawn = false;
  documentElement: FEl;
  body: FEl;
  constructor(kids: FEl[]) {
    this.body = new FEl("body", {}, kids);
    this.documentElement = new FEl("html", {}, [this.body]);
    const own = (e: FEl) => { e.doc = this; e.children.forEach(own); };
    own(this.documentElement);
  }
  querySelector(sel: string): FEl | null { return this.documentElement.querySelector(sel); }
  get defaultView() {
    return {
      getComputedStyle: (el: FEl) => {
        let vis = "visible";
        for (let e: FEl | null = el; e; e = e.parentElement) if (e.style.visibility) { vis = e.style.visibility; break; }
        return { display: el.style.display ?? "block", opacity: el.style.opacity ?? "1", visibility: vis };
      },
    };
  }
  createRange() {
    let el: FEl | null = null;
    return {
      selectNodeContents: (e: FEl) => { el = e; },
      getBoundingClientRect: (): Rect => (this.undrawn || !el ? ZERO : el.contentRect ?? el.rect),
    };
  }
  /** what a pointer press at (x, y) inside the frame hits: the deepest shown element whose box holds it */
  hit(x: number, y: number): FEl | null {
    let best: FEl | null = null;
    const shown = (e: FEl) => { for (let a: FEl | null = e; a; a = a.parentElement) if (a.style.display === "none" || a.hidden) return false; return true; };
    const walk = (e: FEl) => {
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height && shown(e)) best = e;
      e.children.forEach(walk);
    };
    walk(this.body);
    return best;
  }
}

/** One table frame in the client page, holding `doc`; installed behind cdp.io + seams.ignitionTarget. */
export class FakeSitoutTable {
  frame = { x: 2, y: 70, w: 1276, h: 1528 };
  visibility = "visible";
  /** every pointer press, frame-relative, and what it hit */
  presses: { x: number; y: number; hit: string | null }[] = [];
  evals: string[] = [];
  /** throw on the next N table reads (a read that did not come back) */
  failReads = 0;
  constructor(public doc: FDoc, public tag: string | null = null) {}

  run(expr: string): any {
    const fr = this.frame, doc = this.doc;
    const iframe = {
      getAttribute: (k: string) => (k === "src" ? "https://client/table?playMode=real" : k === "data-multitableslot" ? this.tag : null),
      getBoundingClientRect: () => ({ x: fr.x, y: fr.y, width: fr.w, height: fr.h, left: fr.x, top: fr.y, right: fr.x + fr.w, bottom: fr.y + fr.h }),
      contentDocument: doc,
      contentWindow: { __wrapperDraw: { n: 117, t0: 0, t: 0 }, performance: { now: () => (doc.undrawn ? 2_593_593 : 10) } },
    };
    const top = { querySelectorAll: (sel: string) => (sel.startsWith("iframe") ? [iframe] : []) };
    return new Function("document", "window", "innerWidth", "innerHeight", `return ${expr}`)(top, {}, 2560, 1600);
  }

  install(): () => void {
    const io0 = { ...cdp.io };
    const t0 = seams.ignitionTarget, q0 = seams.cdpSeq;
    // ensureVisible's Page.bringToFront: a hidden page stays hidden here (a minimised window it cannot raise)
    seams.cdpSeq = async () => {};
    cdp.io.evaluate = async (_ws: string, expr: string) => {
      if (expr === "document.visibilityState") return this.visibility;
      this.evals.push(expr.includes("const CLICK = true") ? "click" : "read");
      if (this.failReads > 0) {
        this.failReads--;
        throw new Error("the page's reply never came");
      }
      return this.run(expr);
    };
    cdp.io.dispatchClick = async (_ws: string, x: number, y: number) => {
      const fx = x - this.frame.x, fy = y - this.frame.y;
      const e = this.doc.hit(fx, fy);
      this.presses.push({ x: fx, y: fy, hit: e ? e.tagName.toLowerCase() + (e.text ? `:${e.text}` : "") : null });
      e?.click();
    };
    seams.ignitionTarget = async () => ({ webSocketDebuggerUrl: "ws://fake-sitout" }) as any;
    return () => {
      Object.assign(cdp.io, io0);
      seams.ignitionTarget = t0;
      seams.cdpSeq = q0;
    };
  }
}

// ---- the layouts --------------------------------------------------------------------------------------------
const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

/** <label><input type=checkbox>Sit out next big blind</label> — the label is NOT a leaf (the box is its child): the
 *  shape the old read could never match. "Sit out next hand" the same, 20 px above (the live client's positions). */
export function labelRows(o: { bbTicked?: boolean } = {}) {
  const handBox = new FEl("input", { type: "checkbox", rect: r(18, 1440, 13, 13) });
  const bbBox = new FEl("input", { type: "checkbox", checked: !!o.bbTicked, rect: r(18, 1460, 13, 13) });
  const hand = new FEl("label", { text: "Sit out next hand", rect: r(18, 1440, 93, 13) }, [handBox]);
  const bb = new FEl("label", { text: "Sit out next big blind", rect: r(18, 1460, 108, 13) }, [bbBox]);
  const me = new FEl("div", { attrs: { "data-qa": "myPlayerTag" }, text: "Hero", rect: r(500, 600, 60, 20) });
  const doc = new FDoc([me, new FEl("div", { rect: r(0, 1430, 300, 60) }, [hand, bb])]);
  return { doc, bbBox, handBox, bb, hand };
}

/** The client's component shape: a row div whose handler flips an aria-checked box div; the text in a span with
 *  display: contents (0 x 0 itself, its text measures). */
export function ariaRows() {
  const mkRow = (label: string, y: number) => {
    const box = new FEl("div", { attrs: { "aria-checked": "false", role: "checkbox" }, rect: r(18, y, 13, 13) });
    const span = new FEl("span", { text: label, style: { display: "contents" }, rect: ZERO, contentRect: r(36, y, 90, 13) });
    const row = new FEl("div", { rect: r(18, y, 120, 13) }, [box, span]);
    row.onClick = () => { box.attrs["aria-checked"] = box.attrs["aria-checked"] === "true" ? "false" : "true"; };
    return { row, box, span };
  };
  const hand = mkRow("Sit out next hand", 1440);
  const bb = mkRow("Sit out next big blind", 1460);
  const me = new FEl("div", { attrs: { "data-qa": "myPlayerTag" }, text: "Hero", rect: r(500, 600, 60, 20) });
  const doc = new FDoc([me, new FEl("div", { rect: r(0, 1430, 300, 60) }, [hand.row, bb.row])]);
  return { doc, hand, bb };
}

/** ONE container holding both labels and ONE box — the "Sit out next hand" box (ticked): it must never answer for
 *  ours, nor be pressed for ours. */
export function sharedRow() {
  const handBox = new FEl("input", { type: "checkbox", checked: true, rect: r(18, 1440, 13, 13) });
  const handLab = new FEl("span", { text: "Sit out next hand", rect: r(36, 1440, 75, 13) });
  const bbLab = new FEl("span", { text: "Sit out next big blind", rect: r(36, 1460, 90, 13) });
  const row = new FEl("div", { rect: r(0, 1430, 300, 60) }, [handBox, handLab, bbLab]);
  const me = new FEl("div", { attrs: { "data-qa": "myPlayerTag" }, text: "Hero", rect: r(500, 600, 60, 20) });
  return { doc: new FDoc([me, row]), handBox, bbLab };
}
