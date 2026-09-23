/**
 * Press buttons on a CoinPoker table (the Unity window) — and prove it happened. Port of sites/cp_actions.py.
 *
 * Measured 2026-09-22 on practice tables (client 1.26.0, table build 1.2.191):
 *  - Messages POSTED to the window are ignored — Unity reads raw input. Only real input works: SendInput with the
 *    table in the foreground. So every press briefly takes focus + the cursor and gives both back.
 *  - There is no DOM: the buttons are found at fixed positions in the table's client area (measured at 1600x1170,
 *    scaled to the live size) and CHECKED BY OCR before any click — the target button must carry the expected word,
 *    and a bet box must read back the intended amount, or nothing is pressed.
 *  - The press is CONFIRMED from CoinPoker's own log: hero's action must appear in the hand within a few seconds.
 *
 * AUTO-EXECUTE IS PRACTICE-ONLY. `act(..., {auto: true})` refuses unless the server said the table is practice
 * chips (roomProperties.coinType == 2). A table whose type is unknown is treated as real money. A real-money press
 * needs a person to ask for it — the tool never plays a real-money table by itself.
 */
import { sleep, time } from "../clock";
import * as OCR from "../ocr";
import { fmtFixed, pyFloatStr, pyRepr, pyReprStr, pyRound, pyStr, PyTuple } from "../py";

const fstr = (v: number | null | undefined) => (v === null || v === undefined ? "None" : pyFloatStr(v));
import * as W from "../win32";
import type { Room } from "./cpFeed";

export const REF_W = 1600, REF_H = 1170;
export const POS: Record<string, [number, number]> = {
  fold: [1052, 1113], call: [1270, 1113], raise: [1490, 1113],
  p33: [997, 1021], p50: [1079, 1021], p75: [1160, 1021], max: [1241, 1021],
  amount: [1367, 1021],
  menu: [50, 1023], sitout_next: [388, 958], sitout_all: [388, 1012],
};
export const BOX: Record<string, [number, number, number, number]> = {
  fold: [952, 1068, 1152, 1160], call: [1172, 1068, 1370, 1160],
  raise: [1390, 1068, 1590, 1165], amount: [1300, 995, 1440, 1050],
  menu_items: [104, 870, 420, 1045],
};
export const LABEL: Record<string, string[]> = {
  fold: ["fold"], check: ["check"], call: ["call"],
  bet: ["bet", "raise", "all"], raise: ["bet", "raise", "all"],
  allin: ["all", "raise", "bet"],
};
export const BUTTON_OF: Record<string, string> = { fold: "fold", check: "call", call: "call", bet: "raise", raise: "raise", allin: "raise" };

let pressBusy = false;
const lastPress: Record<string, any> = {};

export class NotClickable extends Error {}

export const cloaked = (h: number) => W.cloaked(h);

export const OTHER_DESKTOP = "the table is on another virtual desktop — bring it to this one (Win+Tab, drag it across), "
  + "or right-click it in Task View → Show this window on all desktops";

/** The Unity window for this room: the CoinPoker.exe started with roomName=<room> (each table is its own process). */
export function tableWindow(room: string): number | null {
  let pid: number | null = null;
  for (const p of W.listProcesses()) {
    if (p.name.toLowerCase() !== "coinpoker.exe") continue;
    if ((W.processCmdline(p.pid) || []).some((a) => a === `roomName=${room}`)) {
      pid = p.pid;
      break;
    }
  }
  if (pid === null) return null;
  return W.enumWindows().find((h) => W.windowPid(h) === pid && W.isWindowVisible(h)) ?? null;
}

export const clientRect = (h: number) => W.clientRect(h);

function scale(h: number): [number, number] {
  const [, , w, hh] = clientRect(h);
  return [w / REF_W, hh / REF_H];
}

/** The table's client area (PrintWindow full-content: works while covered). */
export const capture = (h: number) => W.capture(h);

export async function ocr(img: W.Capture, key: string): Promise<string> {
  const sx = img.width / REF_W, sy = img.height / REF_H;
  const [x0, y0, x1, y1] = BOX[key]!;
  const c = OCR.cropGray(img, Math.trunc(x0 * sx), Math.trunc(y0 * sy), Math.trunc(x1 * sx), Math.trunc(y1 * sy));
  const g = OCR.autocontrast(c.gray);
  const big = OCR.resize2x(g, c.w, c.h);
  const lines = await OCR.recognizeGray(big.gray, big.w, big.h);
  return lines.join(" ").trim();
}

/** '2,000' / '0.25' / '1.18M' / 'Raise 4,000' -> number. */
export function parseAmount(text: string | null | undefined): number | null {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*([KkMm])?/.exec(text || "");
  if (!m) return null;
  const v = Number(m[1]!.replace(/,/g, ""));
  const mult = ({ k: 1e3, m: 1e6 } as Record<string, number>)[(m[2] || "").toLowerCase()] ?? 1;
  return v * mult;
}

// ---- real input ----
const LEFTDOWN = 0x0002, LEFTUP = 0x0004;

/** Take the foreground + cursor for the table, give both back at the end. */
class Focus {
  private old: [number, number] = [0, 0];
  private prev = 0;

  constructor(private h: number) {}

  async enter(): Promise<void> {
    this.old = W.cursorPos();
    this.prev = W.getForegroundWindow();
    if (W.isIconic(this.h)) W.showWindow(this.h, 9);
    W.setForegroundWindow(this.h);
    await sleep(0.15);
  }

  async click(key: string): Promise<void> {
    const [cx, cy] = clientRect(this.h);
    const [sx, sy] = scale(this.h);
    const [x, y] = POS[key]!;
    const px = cx + Math.trunc(x * sx), py = cy + Math.trunc(y * sy);
    if (cloaked(this.h)) throw new NotClickable(OTHER_DESKTOP);
    const top = W.ownerAt(px, py);
    if (top !== this.h) {
      if (!top) throw new NotClickable(`the table's ${key} button is off screen — move the table fully onto a monitor`);
      const title = W.windowTextN(top, 120);
      throw new NotClickable(`another window (${pyReprStr(title || "untitled")}) is on top of the table's ${key} button`);
    }
    W.setCursorPos(px, py);
    await sleep(0.06);
    for (const f of [LEFTDOWN, LEFTUP]) {
      W.sendMouseFlags(f);
      await sleep(0.05);
    }
  }

  key(vk: number, up = false): void {
    W.sendKey(vk, 0, up ? 0x0002 : 0);
  }

  async type(text: string): Promise<void> {
    for (const ch of text) {
      for (const up of [false, true]) W.sendKey(0, ch.charCodeAt(0), 0x0004 | (up ? 0x0002 : 0));
      await sleep(0.02);
    }
  }

  selectAll(): void {
    this.key(0x11);
    this.key(0x41);
    this.key(0x41, true);
    this.key(0x11, true);
  }

  async exit(): Promise<void> {
    await sleep(0.05);
    W.setCursorPos(this.old[0], this.old[1]);
    if (this.prev && this.prev !== this.h) W.setForegroundWindow(this.prev);
  }
}

export function fmtAmount(v: number): string {
  return v !== Math.trunc(v) ? fmtFixed(v, 2).replace(/0+$/, "").replace(/\.$/, "") : String(Math.trunc(v));
}

/** Press one action for hero at `room`. `getHand()` = the current ParsedHand for that room (read fresh);
 *  amount = the bet/raise TOTAL in table chips. {ok, ...} — ok only when the log shows hero's action. */
export async function act(room: Room, getHand: () => Record<string, any> | null, action: string, amount: number | null = null,
                          opts: { auto?: boolean; confirmS?: number } = {}): Promise<Record<string, any>> {
  const auto = !!opts.auto;
  const confirmS = opts.confirmS ?? 4.0;
  action = action.toLowerCase();
  if (!(action in LABEL)) return { ok: false, why: `unknown action ${pyReprStr(action)}` };
  if (auto && !room.practice) {
    return { ok: false, why: "auto-execute is practice-only — this table is "
      + (room.coinType === 1 ? "REAL MONEY (coinType 1)" : `of unknown type (coinType ${room.coinType === null ? "None" : pyStr(room.coinType)})`) };
  }
  if (pressBusy) return { ok: false, why: "another press is in progress" };
  pressBusy = true;
  try {
    const h = getHand();
    if (!h || h.ended) return { ok: false, why: "no live hand" };
    const node = h.currentNode;
    if (!node.toActIsHero) return { ok: false, why: `not hero's turn (${pyStr(h.notToActWhy ?? null)})` };
    const key = JSON.stringify([h.clientHandId, h.street, h.actions.length]);
    if (lastPress.key === key) return { ok: false, why: "already pressed for this decision" };
    const toCall = node.toCall || 0;
    if (action === "check" && toCall > 0) return { ok: false, why: `cannot check: ${fstr(toCall)} bb to call` };
    if (action === "call" && toCall <= 0) return { ok: false, why: "nothing to call — use check" };
    if ((action === "bet" || action === "raise") && !amount) return { ok: false, why: "bet/raise needs an amount (the total, in table chips)" };
    if (action === "allin" && !amount) {
      return { ok: false, why: "all-in needs hero's total (stack + street bet) to verify the Max preset against" };
    }
    const hw = tableWindow(room.name);
    if (!hw) return { ok: false, why: "table window not found" };
    if (cloaked(hw)) return { ok: false, why: `${OTHER_DESKTOP} — not pressed` };
    const button = BUTTON_OF[action]!;
    const n0 = h.actions.length;
    const t0 = time();
    let label = "";
    let pressedAt = 0;
    const f = new Focus(hw);
    await f.enter();
    try {
      let img = capture(hw);
      if (action === "bet" || action === "raise") {
        await f.click("amount");
        await sleep(0.12);
        f.selectAll();
        await f.type(fmtAmount(amount!));
        await sleep(0.35);
        img = capture(hw);
        const box = parseAmount(await ocr(img, "amount"));
        if (box === null || Math.abs(box - amount!) > Math.max(0.011, amount! * 0.005)) {
          return { ok: false, why: `amount box reads ${fstr(box)}, wanted ${fstr(amount)} — not pressed`,
                   boxText: await ocr(img, "amount") };
        }
      } else if (action === "allin") {
        await f.click("max");
        await sleep(0.35);
        img = capture(hw);
        const box = parseAmount(await ocr(img, "amount"));
        if (box === null || Math.abs(box - amount!) > Math.max(0.011, amount! * 0.01)) {
          return { ok: false, why: `Max put ${fstr(box)} in the box, hero's all-in is ${fstr(amount)} — not pressed`,
                   boxText: await ocr(img, "amount") };
        }
      }
      label = await ocr(img, button);
      if (!LABEL[action]!.some((w) => label.toLowerCase().includes(w))) {
        return { ok: false, why: `button reads ${pyReprStr(label)}, expected ${pyRepr(new PyTuple(LABEL[action]!))} — not pressed` };
      }
      const h2 = getHand();
      if (!h2 || !h2.currentNode.toActIsHero || h2.actions.length !== n0) return { ok: false, why: "the spot changed before the press — not pressed" };
      await f.click(button);
      pressedAt = time();
    } finally {
      await f.exit();
    }
    Object.assign(lastPress, { key, at: pressedAt, action });
    while (time() - pressedAt < confirmS) {
      const h3 = getHand();
      const mine = h3 && h3.clientHandId === h.clientHandId ? (h3.actions || []).slice(n0).filter((a: any) => a.hero) : [];
      if (mine.length) {
        return { ok: true, action: mine[0], label, pressMs: pyRound((pressedAt - t0) * 1000), confirmMs: pyRound((time() - pressedAt) * 1000),
                 practice: room.practice };
      }
      await sleep(0.08);
    }
    return { ok: false, why: `pressed ${pyReprStr(label)} but the log shows no hero action within ${fstr(confirmS)}s`, pressed: true };
  } catch (e) {
    if (e instanceof NotClickable) return { ok: false, why: `${e.message} — not pressed` };
    throw e;
  } finally {
    pressBusy = false;
  }
}

/** Tick/untick 'Sit Out Next Hand' (or 'Sit Out All') and confirm from the server's sitOutMap echo. */
export async function setSitout(room: Room, want: boolean, which = "sitOutNextHand", confirmS = 4.0): Promise<Record<string, any>> {
  const key = ({ sitOutNextHand: "sitout_next", sitOutAll: "sitout_all" } as Record<string, string>)[which]!;
  if (!!room.sitout[which] === want) return { ok: true, already: true, [which]: want };
  const hw = tableWindow(room.name);
  if (!hw) return { ok: false, why: "table window not found" };
  const waitStart = time();
  while (pressBusy) {
    if (time() - waitStart > 5) return { ok: false, why: "another press is in progress" };
    await sleep(0.05);
  }
  pressBusy = true;
  try {
    const f = new Focus(hw);
    await f.enter();
    try {
      await f.click("menu");
      await sleep(0.6);
      const items = (await ocr(capture(hw), "menu_items")).toLowerCase();
      if (!items.includes("sit out")) {
        await f.click("menu");
        return { ok: false, why: `menu did not open as expected (${pyReprStr(items)}) — not pressed` };
      }
      if (!!room.sitout[which] === want) {
        await f.click("menu");
        return { ok: true, already: true, [which]: want };
      }
      await f.click(key);
      await sleep(0.3);
      await f.click("menu");
    } finally {
      await f.exit();
    }
    const t = time();
    while (time() - t < confirmS) {
      if (!!room.sitout[which] === want) return { ok: true, [which]: want, confirmMs: pyRound((time() - t) * 1000) };
      await sleep(0.08);
    }
    return { ok: false, why: "clicked, but the server never echoed the new sit-out state", pressed: true };
  } catch (e) {
    if (e instanceof NotClickable) return { ok: false, why: `${e.message} — not pressed` };
    throw e;
  } finally {
    pressBusy = false;
  }
}
