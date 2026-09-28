/**
 * The ClubGG screen reader (sites/cgg*.ts), offline: the card and bet-pill templates on real crops of recording
 * 20260928_194914 (test/fixtures/clubgg-crops-20260928.json.gz, cut by poker-data/clubgg/make_crops.py), and the
 * snapshot -> hand reducer on hand-built snapshots of the same 7-max table.
 */
import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBoard, readPills, REF_H, REF_W } from "../../src/sites/cggCards";
import { exportHand, Room } from "../../src/sites/cggFeed";
import { labelOf, money, stakesOf, type SeatSnap, type Snapshot } from "../../src/sites/cggFrame";
import { label, png } from "../../src/sites/clubgg";

// ---- the small parsers ----------------------------------------------------------------------------------------

test("stakes come off the table window's title", () => {
  expect(stakesOf("NLH 80-200 BP  - 1/2")).toEqual({ game: "NLH", sb: 1, bb: 2, ante: null });
  expect(stakesOf("NLH 20-50 (2 - 0.25/0.5(0.10)")).toMatchObject({ sb: 0.25, bb: 0.5, ante: 0.1 });
  expect(label("NLH 80-200 BP  - 1/2")).toBe("NLH 1/2 · NLH 80-200 BP");
});

test("money and action labels as the OCR writes them", () => {
  expect(money("1,234.50")).toBe(1234.5);
  expect(money("+31.54")).toBe(31.54);
  expect(money("2O5")).toBe(205);
  expect(money("Hesh a")).toBeNull();
  expect(labelOf("@WIN")).toBe("win");
  expect(labelOf("All-In")).toBe("all-in");
  expect(labelOf("Call")).toBe("call");
  expect(labelOf("Jimbigstacks")).toBeNull();
});

test("png() writes a PNG a decoder accepts (signature, IHDR size)", () => {
  const f = { width: 3, height: 2, bgra: new Uint8Array(3 * 2 * 4).fill(200) };
  const b = png(f);
  expect([...b.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(b.buffer, b.byteOffset);
  expect(dv.getUint32(16)).toBe(3);
  expect(dv.getUint32(20)).toBe(2);
});

// ---- cards and bet pills, on real pixels ---------------------------------------------------------------------

const crops: any[] = JSON.parse(gunzipSync(readFileSync(join(import.meta.dir, "..", "fixtures", "clubgg-crops-20260928.json.gz"))).toString()).crops;

/** A blank (black) 1698x1260 client with the crop's rectangles pasted back where they were cut. */
function frameOf(c: any) {
  const bgra = new Uint8Array(REF_W * REF_H * 4);
  for (const r of c.rects) {
    const src = Buffer.from(r.bgr, "base64");
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const i = (y * r.w + x) * 3, o = ((r.y + y) * REF_W + r.x + x) * 4;
        bgra[o] = src[i]!;
        bgra[o + 1] = src[i + 1]!;
        bgra[o + 2] = src[i + 2]!;
        bgra[o + 3] = 255;
      }
    }
  }
  return { width: REF_W, height: REF_H, bgra };
}

for (const c of crops.filter((x) => x.board)) {
  test(`board of frame ${c.frame} reads ${c.board.map((x: string | null) => x ?? "-").join(" ")}`, () => {
    const got = readBoard(frameOf(c)).map((b) => (b.present ? `${b.card}${b.raised ? "^" : ""}` : null));
    expect(got).toEqual(c.board);
  });
}

for (const c of crops.filter((x) => x.pills)) {
  test(`bet pills of frame ${c.frame} read ${Object.values(c.pills).join(", ")}`, () => {
    const got = readPills(frameOf(c));
    for (const [at, want] of Object.entries(c.pills)) {
      const [cx, cy] = at.split(",").map(Number);
      const p = got.find((x) => Math.abs(x.cx - cx!) < 12 && Math.abs(x.cy - cy!) < 12);
      expect(p?.text).toBe(want as string);
    }
  });
}

// ---- the reducer, on hand-built snapshots ---------------------------------------------------------------------
// Plates where the 7-max table draws them (seat ids clockwise from the bottom centre: kaikye 1 … KelBrancoLi 7).
const AT: Record<string, [number, number]> = {
  kaikye: [850, 1112], William_Law: [338, 1011], Jimbigstacks: [178, 522], Sfuller321: [626, 291],
  dserf420: [1070, 291], "Hesh a": [1521, 520], KelBrancoLi: [1360, 1009],
};
const ID: Record<string, number> = { kaikye: 1, William_Law: 2, Jimbigstacks: 3, Sfuller321: 4, dserf420: 5, "Hesh a": 6, KelBrancoLi: 7 };

class Table {
  room = new Room("t1", "NLH 80-200 BP  - 1/2");
  t = 1000;
  stacks: Record<string, number> = {};
  bets: Record<string, number | null> = {};
  cards: Record<string, SeatSnap["cards"]> = {};
  board: string[] = [];
  center: number | null = null;
  dealerAt = "Jimbigstacks";
  lines: string[] = [];
  constructor() {
    this.room.stakes = { sb: 1, bb: 2, ante: null };
    for (const n of Object.keys(AT)) {
      this.stacks[n] = 200;
      this.bets[n] = null;
      this.cards[n] = "none";
    }
  }
  /** One frame: the standing table plus this frame's labels / timer / win; time moves 0.3 s. */
  frame(o: { label?: Record<string, string>; active?: string; win?: Record<string, number>; totalPot?: number } = {}): string[] {
    const [dx, dy] = AT[this.dealerAt]!;
    const seats: SeatSnap[] = Object.entries(AT).map(([name, [cx, cy]]) => ({
      cx, cy, name, stack: this.stacks[name]!, bet: this.bets[name]!, label: o.label?.[name] ?? null, win: o.win?.[name] ?? null,
      cards: this.cards[name]!, active: o.active === name, badge: null,
    }));
    const snap: Snapshot = {
      t: this.t, width: REF_W, height: REF_H, seats, board: [...this.board], boardRaised: false, totalPot: o.totalPot ?? null,
      centerPot: this.center, dealer: { x: dx * 0.75 + 849 * 0.25, y: dy * 0.75 + 660 * 0.25 }, bombPot: false, texts: [],
    };
    this.t += 0.3;
    const out = this.room.apply(snap);
    this.lines.push(...out);
    return out;
  }
  bet(name: string, to: number): void {
    this.stacks[name] = +(this.stacks[name]! - (to - (this.bets[name] ?? 0))).toFixed(2);
    this.bets[name] = to;
  }
  /** The street is over: bets swept to the middle, the board grows. */
  deal(cards: string[]): void {
    this.center = (this.center ?? 0) + Object.values(this.bets).reduce<number>((a, b) => a + (b ?? 0), 0);
    for (const n of Object.keys(this.bets)) this.bets[n] = null;
    this.board = cards;
  }
  actions(): string[] {
    const h = this.room.hand ?? this.room.last!;
    return h.actions.map((a) => `${a.street.slice(0, 4).toLowerCase()} ${a.name} ${a.action}${a.action === "Fold" || a.action === "Check" ? "" : " " + a.to}${a.inferred ? "*" : ""}`);
  }
}

test("a whole hand: blinds, a raise, labelled folds and calls, a check the timer shows, a river bet that wins", () => {
  const T = new Table();
  T.dealerAt = "Jimbigstacks";                       // button seat 3: SB Sfuller321 (4), BB dserf420 (5)
  T.bet("Sfuller321", 1);
  T.bet("dserf420", 2);
  T.frame();                                         // blinds out, no cards yet
  for (const n of Object.keys(AT)) T.cards[n] = "backs";
  T.frame();
  T.bet("Hesh a", 6);
  T.frame({ label: { "Hesh a": "raise" } });
  T.frame({ label: { "Hesh a": "raise" } });         // the label stays up: still one raise
  T.cards.KelBrancoLi = "dark";
  T.frame({ label: { KelBrancoLi: "fold" } });
  T.cards.KelBrancoLi = "none";
  T.bet("kaikye", 6);
  T.frame({ label: { kaikye: "call" } });
  T.cards.William_Law = "none";                      // folds without a label caught: cards gone two frames
  T.frame();
  T.frame();
  T.cards.Jimbigstacks = "none";
  T.frame({ label: { Jimbigstacks: "fold" } });
  T.cards.Sfuller321 = "none";
  T.frame({ label: { Sfuller321: "fold" } });
  T.bet("dserf420", 6);
  T.frame({ label: { dserf420: "call" } });
  T.frame();
  T.deal(["Ks", "Th", "8s"]);
  T.frame({ label: { dserf420: "call" } });          // the preflop call's label is still up on the flop: not a flop action
  T.frame({ label: { dserf420: "check" } });
  T.frame({ label: { dserf420: "check" } });
  T.bet("Hesh a", 10);
  T.frame({ label: { "Hesh a": "bet" } });
  T.cards.kaikye = "none";
  T.frame({ label: { kaikye: "fold" } });
  T.bet("dserf420", 10);
  T.frame({ label: { dserf420: "call" } });
  T.deal(["Ks", "Th", "8s", "7s"]);
  T.frame({ active: "dserf420" });
  T.frame({ active: "Hesh a" });                     // dserf420's turn passed with nothing in: a check, once 1.2 s hold
  T.frame({ active: "Hesh a" });
  T.frame({ active: "Hesh a" });
  T.frame({ active: "Hesh a" });
  T.frame({ active: "Hesh a" });
  T.frame({ label: { "Hesh a": "check" } });
  T.deal(["Ks", "Th", "8s", "7s", "6h"]);
  T.frame();
  T.bet("dserf420", 30);
  T.frame({ label: { dserf420: "bet" } });
  T.cards["Hesh a"] = "none";
  T.frame({ label: { "Hesh a": "fold" } });
  T.frame({ win: { dserf420: 62 }, label: { dserf420: "win" } });

  expect(T.actions()).toEqual([
    "pref Sfuller321 SB 1", "pref dserf420 BB 2",
    "pref Hesh a Raise 6", "pref KelBrancoLi Fold", "pref kaikye Call 6", "pref William_Law Fold*", "pref Jimbigstacks Fold",
    "pref Sfuller321 Fold", "pref dserf420 Call 6",
    "flop dserf420 Check", "flop Hesh a Bet 10", "flop kaikye Fold", "flop dserf420 Call 10",
    "turn dserf420 Check*", "turn Hesh a Check",
    "rive dserf420 Bet 30", "rive Hesh a Fold",
  ]);
  const h = T.room.hand!;
  expect(h.ended).toBe(true);
  expect(h.winners).toEqual([{ seat: ID.dserf420!, name: "dserf420", won: 62 }]);
  expect(h.uncertain).toEqual([]);
  const ph = exportHand(T.room)!;
  expect(ph.site).toBe("clubgg");
  expect(ph.positions.get(ID.Jimbigstacks!)).toBe("BTN");
  expect(ph.positions.get(ID.Sfuller321!)).toBe("SB");
  expect(ph.positions.get(ID.dserf420!)).toBe("BB");
  expect(ph.currentNode.pot).toBe(34.5);              // 1+2+6+6+4 preflop, 10+10 flop, dserf420's 30 (uncalled, still out)
  expect(ph.actions.filter((a: any) => a.type === "raise")[0]).toMatchObject({ seatId: ID["Hesh a"], amount: 3 });
});

test("joining after the deal: the blinds and a returning player's post are posts, the raise before them a raise", () => {
  // hand 2 of 20260928_194914 (frame 213): button dserf420, SB Hesh a 1, BB KelBrancoLi 2, Sfuller321 posts 2 coming
  // back, 1 dead in the middle, Jimbigstacks has made it 9 — all already out on the first frame the reader sees
  const T = new Table();
  T.dealerAt = "dserf420";
  for (const n of ["dserf420", "Hesh a", "KelBrancoLi", "kaikye", "William_Law", "Jimbigstacks"]) T.cards[n] = "backs";
  T.bet("Hesh a", 1);
  T.bet("KelBrancoLi", 2);
  T.bet("Sfuller321", 2);
  T.bet("Jimbigstacks", 9);
  T.center = 1;
  T.frame({ totalPot: 15 });
  T.frame({ totalPot: 15 });
  expect(T.actions().slice(0, 4)).toEqual(["pref Hesh a SB 1", "pref KelBrancoLi BB 2", "pref Jimbigstacks Raise 9", "pref Sfuller321 Post 2"]);
  expect(T.room.hand!.dead).toBe(1);
  expect(T.room.hand!.joinedLate).toBe(true);
});

test("a bomb pot: equal posts before the cards are antes, the flop comes straight after", () => {
  const T = new Table();
  T.dealerAt = "William_Law";
  const inIt = ["kaikye", "William_Law", "Jimbigstacks", "Sfuller321", "Hesh a", "KelBrancoLi"];
  for (const n of inIt) T.bet(n, 6);
  T.frame();
  for (const n of inIt) T.cards[n] = "backs";
  T.frame();
  T.deal(["6c", "8s", "9h"]);
  T.frame();
  T.frame({ label: { Jimbigstacks: "check" } });
  const h = T.room.hand!;
  expect(h.bomb).toBe(true);
  expect(h.actions.filter((a) => a.action === "Ante").length).toBe(6);
  expect(T.actions().filter((a) => a.startsWith("pref") && !a.includes("Ante"))).toEqual([]);
  const ph = exportHand(T.room)!;
  expect(ph.bombPot).toBe(true);
  expect(ph.anteBb).toBe(3);
  expect(ph.currentNode.pot).toBe(18);
  expect(ph.street).toBe("flop");
});

test("a bet read once and gone the next frame is not an action (one misread digit)", () => {
  const T = new Table();
  T.dealerAt = "Jimbigstacks";
  T.bet("Sfuller321", 1);
  T.bet("dserf420", 2);
  for (const n of Object.keys(AT)) T.cards[n] = "backs";
  T.frame();
  T.frame();
  T.bets["Hesh a"] = 8;                              // misread for one frame, no label
  T.frame();
  T.bets["Hesh a"] = null;
  T.frame();
  T.frame();
  expect(T.actions()).toEqual(["pref Sfuller321 SB 1", "pref dserf420 BB 2"]);
});

test("the fold label from the last hand, still up as the next is dealt, folds nobody", () => {
  const T = new Table();
  T.dealerAt = "Jimbigstacks";
  T.bet("Sfuller321", 1);
  T.bet("dserf420", 2);
  for (const n of Object.keys(AT)) T.cards[n] = "backs";
  T.frame({ label: { kaikye: "fold" } });
  T.frame({ label: { kaikye: "fold" } });
  expect(T.actions()).toEqual(["pref Sfuller321 SB 1", "pref dserf420 BB 2"]);
});

// ---- real play: recording 20260928_194914 replayed through the reducer ----------------------------------------
// test/fixtures/clubgg-snapshots-20260928.jsonl.gz = every frame of the recording the replay reads (the parser's
// Snapshot per frame; frames with another window over the table left out), as tools/cggReplay.ts cached them. The
// hands below were checked against the frames by eye; covered stretches make the others partial (joined late).
test("recording 20260928_194914: the hands read whole off the screen come out as played", () => {
  const rows = gunzipSync(readFileSync(join(import.meta.dir, "..", "fixtures", "clubgg-snapshots-20260928.jsonl.gz"))).toString()
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const room = new Room("6489998", "NLH 80-200 BP  - 1/2");
  room.stakes = { sb: 1, bb: 2, ante: null };
  for (const r of rows) room.apply({ width: REF_W, height: REF_H, texts: [], ...r.snap, seats: r.snap.seats.map((x: any) => ({ badge: null, ...x })) });
  room.finish();
  const line = (h: any) => h.actions.map((a: any) => `${a.street.slice(0, 4).toLowerCase()} ${a.name} ${a.action}${a.action === "Fold" || a.action === "Check" ? "" : " " + a.to}${a.inferred ? "*" : ""}`);
  const byBoard = (b: string) => room.finished.find((h) => h.board.join(" ") === b)!;
  expect(room.finished.length).toBe(14);
  expect(line(byBoard("Ks Th 8s 7s 6h"))).toEqual([
    "pref dserf420 SB 1", "pref Hesh a BB 2", "pref KelBrancoLi Fold", "pref kaikye Fold", "pref William_Law Fold",
    "pref Jimbigstacks Raise 7", "pref dserf420 Fold", "pref Hesh a Call 7",
    "flop Hesh a Check", "flop Jimbigstacks Bet 15", "flop Hesh a Call 15",
    "turn Hesh a Check", "turn Jimbigstacks Bet 45", "turn Hesh a Call 45",
  ]);
  // Sfuller321 posts coming back in, behind Jimbigstacks' raise, and never holds cards; 1 dead in the middle
  const h2 = room.finished.find((h) => h.winners.some((w) => w.name === "Jimbigstacks" && w.won === 8))!;
  expect(line(h2)).toEqual([
    "pref Hesh a SB 1", "pref KelBrancoLi BB 2", "pref Jimbigstacks Raise 9", "pref Sfuller321 Post 2", "pref Sfuller321 Fold*",
    "pref Hesh a Fold", "pref KelBrancoLi Fold",
  ]);
  expect(h2.dead).toBe(1);
  // the showdown hand: decimals in the bets; the turn's Check label still up as the river lands is not a river action
  const sd = byBoard("Ts Js Ks Qs 5s");
  expect(line(sd)).toEqual([
    "pref William_Law SB 1", "pref Jimbigstacks BB 2", "pref Sfuller321 Fold", "pref Hesh a Raise 6", "pref KelBrancoLi Fold",
    "pref kaikye Call 6", "pref William_Law Fold", "pref Jimbigstacks Call 6",
    "flop Jimbigstacks Check", "flop Hesh a Bet 6.27", "flop kaikye Fold", "flop Jimbigstacks Call 6.27",
    "turn Jimbigstacks Check", "turn Hesh a Check",
    "rive Jimbigstacks Check", "rive Hesh a Bet 10.41", "rive Jimbigstacks Fold",
  ]);
  expect(sd.winners.map((w) => [w.name, w.won])).toEqual([["Hesh a", 31.54]]);
  expect(sd.uncertain).toEqual([]);
  expect(line(byBoard("Kd 6h Jh 5h"))).toEqual([
    "pref Lako-matic SB 1", "pref Hesh a BB 2", "pref KelBrancoLi Fold", "pref kaikye Fold", "pref William_Law Fold",
    "pref Jimbigstacks Raise 7", "pref Sfuller321 Call 7", "pref Lako-matic Fold", "pref Hesh a Call 7",
    "flop Hesh a Check", "flop Jimbigstacks Bet 7.26", "flop Sfuller321 Call 7.26", "flop Hesh a Fold",
    "turn Jimbigstacks Bet 18.26",
  ]);
});
