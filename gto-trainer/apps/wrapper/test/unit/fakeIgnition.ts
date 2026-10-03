/**
 * A FAKE IGNITION TABLE behind the relay's real press code (cdp.io + seams), built from strips RECORDED on the live
 * client — so a test exercises the relay's own reads and clicks, not a stand-in for them. The old shove test faked
 * act() itself and answered the confirm with "RAISE TO 100 BB"; the client never does that once the size is the
 * whole stack, which is how every preset-sized Ignition shove was refused for weeks (hand 4920545590).
 *
 * What a press does here is only what was seen on the real client (session_20260925_135420):
 *  - the ALL-IN (or MAX) sizing preset puts hero's stack in the bet field and RELABELS the RAISE/BET control
 *    "ALL-IN <stack> BB" (frames 2038 → 2039) — `relabelAfterReads` holds that back for N strip reads (the client
 *    re-renders on its next frame), `presetTakes: false` never shows it;
 *  - typing into the bet field relabels the confirm "RAISE TO n BB" / "BET n BB", or "ALL-IN <stack> BB" at the stack;
 *    `clampTyped` caps a size above the stack at the stack, `fieldIgnoresTyping` keeps the default (hand 4920431586);
 *  - a turn control (fold / check / call / raise / bet) ends the turn: the strip goes;
 *  - "+45s" changes nothing on screen (every recorded press).
 */
import * as cdp from "../../src/cdp";
import { S, seams } from "../../src/state";
import * as TABLES from "../../src/tables";
import { findInputJs, mySel, tableJs } from "../../src/ignition/dom";
import { findControl } from "../../src/relay";

export type Btn = { text: string; x: number; y: number; w: number; h: number; qa?: string };

// ---- strips recorded on the live client ----------------------------------------------------------------------
/** Hand 4920545590 river, frame 2038: facing a 1 BB bet, 89.2 behind (the QJdd hand). */
export const RIVER_FACING_BET: { frame: any; buttons: Btn[]; field: { x: number; y: number; h: number } } = {
  frame: { x: 0, y: 68, w: 2560, h: 1532 },
  buttons: [
    { text: "Buy chips", x: 32, y: 1520, w: 328, h: 48, qa: "buyMoreChipsButton" },
    { text: "FOLD", x: 921, y: 1354, w: 264, h: 80, qa: "foldButton" },
    { text: "CALL 1 BB", x: 1201, y: 1354, w: 264, h: 80, qa: "callButton" },
    { text: "RAISE TO 2 BB", x: 1493, y: 1354, w: 264, h: 96, qa: "raiseButton" },
    { text: "1/3 Pot", x: 933, y: 1526, w: 146, h: 48, qa: "oneThirdPotSelector" },
    { text: "3/4 Pot", x: 1093, y: 1526, w: 146, h: 48, qa: "threeQuartersPotSelector" },
    { text: "Pot", x: 1253, y: 1526, w: 146, h: 48, qa: "potSelector" },
    { text: "ALL-IN", x: 1413, y: 1526, w: 146, h: 48, qa: "allInSelector" },
    { text: "+45s", x: 1573, y: 1526, w: 184, h: 48, qa: "timeBankButton" },
  ],
  field: { x: 1664, y: 1487, h: 48 },
};

/** Session 135420 frame 726: first to act, CHECK / BET 1 BB with the sizing row. */
export const BET_SPOT: typeof RIVER_FACING_BET = {
  frame: { x: 2, y: 70, w: 1276, h: 762 },
  buttons: [
    { text: "Buy chips", x: 18, y: 792, w: 164, h: 24, qa: "buyMoreChipsButton" },
    { text: "CHECK", x: 543, y: 709, w: 132, h: 40, qa: "checkButton" },
    { text: "BET 1 BB", x: 689, y: 709, w: 132, h: 48, qa: "betButton" },
    { text: "1/3 Pot", x: 409, y: 795, w: 98, h: 24, qa: "oneThirdPotSelector" },
    { text: "3/4 Pot", x: 514, y: 795, w: 98, h: 24, qa: "threeQuartersPotSelector" },
    { text: "Pot", x: 619, y: 795, w: 98, h: 24, qa: "potSelector" },
    { text: "ALL-IN", x: 723, y: 795, w: 98, h: 24, qa: "allInSelector" },
  ],
  field: { x: 760, y: 770, h: 24 },
};

/** Hand 4920544353 turn, frame 1138: the BTN jammed 21.6 into hero's 87.4 — FOLD / CALL only, no sizing row. */
export const FACING_JAM: typeof RIVER_FACING_BET = {
  frame: { x: 2, y: 70, w: 1276, h: 762 },
  buttons: [
    { text: "Buy chips", x: 18, y: 792, w: 164, h: 24, qa: "buyMoreChipsButton" },
    { text: "FOLD", x: 409, y: 713, w: 132, h: 40, qa: "foldButton" },
    { text: "CALL 21.6 BB", x: 549, y: 713, w: 132, h: 40, qa: "callButton" },
    { text: "+45s", x: 729, y: 791, w: 92, h: 24, qa: "timeBankButton" },
  ],
  field: { x: 0, y: 0, h: 0 },
};

/** Hand 4922346841 flop, session_20261003_234358 frame 4318: the BB shoved 245.2 into hero's 88.4 — the call takes
 *  hero's last chip, and the client offers it as its own ALL-IN control. No callButton, no sizing row. */
export const FACING_COVERING_JAM: typeof RIVER_FACING_BET = {
  frame: { x: 2, y: 70, w: 1276, h: 1528 },
  buttons: [
    { text: "Buy chips", x: 18, y: 1558, w: 164, h: 24, qa: "buyMoreChipsButton" },
    { text: "FOLD", x: 409, y: 1479, w: 132, h: 40, qa: "foldButton" },
    { text: "ALL-IN 88.4 BB", x: 689, y: 1479, w: 132, h: 40, qa: "allInButton" },
    { text: "+45s", x: 729, y: 1557, w: 92, h: 24, qa: "timeBankButton" },
  ],
  field: { x: 0, y: 0, h: 0 },
};

const TURN_QA = /^(fold|check|call|raise|bet|allIn)Button$/;
const CONFIRM_QA = /^(raise|bet)Button$/;

export class FakeIgnition {
  buttons: Btn[];
  field: string;
  /** every control clicked, in order (its label at the moment of the click) */
  clicks: string[] = [];
  /** the turn control that ENDED the turn, if any */
  pressed: Btn | null = null;
  reads = 0;
  /** hero's hole cards on this table, as the client tags them ("card47" = 9♠); null = none drawn (the old default) */
  heroQa: string[] | null = null;
  private relabelAt: number | null = null;
  constructor(private spec: typeof RIVER_FACING_BET, private o: {
    stack: number; field?: string; relabelAfterReads?: number; presetTakes?: boolean; clampTyped?: boolean; fieldIgnoresTyping?: boolean;
  }) {
    this.buttons = spec.buttons.map((b) => ({ ...b }));
    this.field = o.field ?? "2.0";
  }

  private confirm(): Btn | undefined {
    return this.buttons.find((b) => CONFIRM_QA.test(b.qa || ""));
  }

  private strip(): Btn[] {
    this.reads++;
    if (this.relabelAt !== null && this.reads >= this.relabelAt) {
      const c = this.confirm();
      if (c) c.text = `ALL-IN ${this.o.stack} BB`;
      this.field = String(this.o.stack);
      this.relabelAt = null;
    }
    return this.buttons.map((b) => ({ ...b }));
  }

  private click(x: number, y: number): void {
    const b = this.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    if (!b) {
      this.clicks.push(`(nothing at ${x},${y})`);
      return;
    }
    this.clicks.push(b.text);
    if (b.qa === "allInSelector" || /^max$/i.test(b.text)) {
      if (this.o.presetTakes !== false) this.relabelAt = this.reads + 1 + (this.o.relabelAfterReads ?? 0);
    } else if (TURN_QA.test(b.qa || "")) {
      this.pressed = { ...b };
      this.buttons = this.buttons.filter((x) => !TURN_QA.test(x.qa || "") && !/Selector$/.test(x.qa || "") && x.qa !== "timeBankButton");
    }
  }

  private type(text: string): void {
    if (this.o.fieldIgnoresTyping) return;
    const v = Number(text);
    this.field = this.o.clampTyped && v > this.o.stack ? String(this.o.stack) : text;
    const c = this.confirm();
    if (!c) return;
    const shown = Number(this.field);
    c.text = shown >= this.o.stack ? `ALL-IN ${this.o.stack} BB` : c.qa === "betButton" ? `BET ${this.field} BB` : `RAISE TO ${this.field} BB`;
  }

  /** Put this table behind cdp.io + seams; returns the undo. */
  install(): () => void {
    const io0 = { ...cdp.io };
    const seams0 = { ignitionTarget: seams.ignitionTarget, cdpSeq: seams.cdpSeq };
    cdp.io.evaluate = async (_ws: string, expr: string) => {
      // built per question: OUR table's snippets carry the pinned tag once the reader has one (dom.ts mySel)
      const TABLE = tableJs(mySel());
      const INPUT = findInputJs(mySel());
      if (expr === "document.visibilityState") return "visible";
      if (expr === TABLE) {
        const hero = this.heroQa ?? [];
        return { seated: true, practice: false, frame: this.spec.frame, zoom: null, nodes: [], buttons: this.strip(),
                 cards: [], allCards: hero.map((qa, i) => ({ qa, x: 600 + 40 * i, y: 600, w: 36, seat: 0, tbl: false })),
                 heroMini: [], seatQa: hero.length ? [{ seat: 0, num: 1, me: true }] : [], canvases: 0 };
      }
      if (expr === INPUT) {
        const c = this.confirm();
        const f = this.spec.field;
        return { practice: false, frameW: this.spec.frame.w, buyPanel: false,
                 inputs: c && f.h ? [{ x: f.x, y: f.y, h: f.h, value: this.field, type: "text" }] : [],
                 anchor: c ? { x: Math.round(c.x + c.w / 2), y: Math.round(c.y + c.h / 2) } : null };
      }
      throw new Error(`the fake table was asked an unexpected question: ${expr.slice(0, 80)}`);
    };
    cdp.io.dispatchClick = async (_ws: string, x: number, y: number) => this.click(x, y);
    seams.ignitionTarget = async () => ({ webSocketDebuggerUrl: "ws://fake-ignition" });
    seams.cdpSeq = async (_ws: string, cmds: [string, Record<string, unknown>][]) => {
      for (const [m, p] of cmds) if (m === "Input.insertText") this.type(String(p.text));
    };
    S.topupPanel.open = false;
    return () => {
      Object.assign(cdp.io, io0);
      seams.ignitionTarget = seams0.ignitionTarget;
      seams.cdpSeq = seams0.cdpSeq;
    };
  }
}

/** A seam-level act() over a list of controls, matched by the relay's OWN findControl, honouring `expect` — for
 *  tests that script which controls exist without a page. A preset named in `relabels` rewrites the confirm the way
 *  the client does. */
export function scriptedStrip(actions: [string, string][], presets: string[], o: { stack?: number; presetTakes?: boolean } = {}) {
  const acts = actions.map(([qa, text]) => ({ qa, text }));
  const pres = presets.map((text) => ({ qa: /^max$/i.test(text) ? "maxSelector" : text === "ALL-IN" ? "allInSelector" : "potSelector", text }));
  const calls: [string, string][] = [];
  const pressed: string[] = [];
  const act = async (label: string, kind = "action", opts: { expect?: (hit: any) => string | null } = {}) => {
    calls.push([label, kind]);
    const pool = kind === "preset" ? pres : acts;
    const hit = findControl(pool, label, kind);
    const offer = pool.map((b) => b.text), offerQa = pool.map((b) => b.qa);
    if (!hit) return { ok: false, reason: `'${label}' not on offer (${kind})`, offer, offerQa, missing: true };
    const refusal = opts.expect ? opts.expect(hit) : null;
    if (refusal) return { ok: false, reason: refusal, offer, offerQa, seen: hit.text };
    if (kind === "preset" && (hit.qa === "allInSelector" || hit.qa === "maxSelector") && o.presetTakes !== false) {
      const c = acts.find((b) => CONFIRM_QA.test(b.qa));
      if (c) c.text = `ALL-IN ${o.stack ?? 100} BB`;
    }
    if (kind === "action") pressed.push(hit.text);
    return { ok: true, clicked: hit.text, kind };
  };
  return { act, calls, pressed };
}
