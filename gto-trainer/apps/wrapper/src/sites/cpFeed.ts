/**
 * CoinPoker live table feed, read from the client's own log. Port of sites/cp_feed.py.
 *
 * CoinPoker tables are a separate Unity program (no CDP), but the Unity table relays every server command to the
 * Electron lobby over a named pipe and the lobby logs each one to %APPDATA%/CoinPoker/logs/main.log:
 *
 *     2026-09-22 04:31:35:697 [info]  [UNITY] Stdout: ... cmd - game.potInfo
 *     [Method] -> SendMessageToPipe - {"EventName":"extension_event",...
 *         "Data":{"cmd_bean":{"BeanData":"{...json...}","Cmd":"game.potInfo","RoomName":"..."},...}}
 *
 * This module tails that file and folds the commands into one hand per room. The file is opened, read and closed
 * on every poll — never held open — so the client's log rotation (a rename) is never blocked by us.
 *
 * NUMBERS: the log writes money as C# doubles ("25.0", "0.1"), which Python parses as floats and prints as "25.0".
 * Every money field that reaches a feed line or the archive's stakes text is printed with `money()` (Python's
 * str(float)); the golden corpus replays every CoinPoker log on the machine to hold that true.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { mktimeYmdHms, time } from "../clock";
import { fmtFixed, fmtG, pyFloat, pyFloatStr, pyInt, pyRound, pyStr, truthy } from "../py";

export const LOG = () => join(process.env.APPDATA || "", "CoinPoker", "logs", "main.log");

/** WHO HERO IS: CP_HERO pins it; otherwise it is LEARNED from the client's own log ("Login on SFS with <name>"). */
export const hero = {
  name: (process.env.CP_HERO || "").trim(),
  source: (process.env.CP_HERO || "").trim() ? "CP_HERO" : (null as string | null),
};
const LOGIN = /Login on SFS with (\S+) Address/;
const LOGIN_G = /Login on SFS with (\S+) Address/g;

export function learnHero(name: string): void {
  if ((process.env.CP_HERO || "").trim() || !name) return;
  hero.name = name;
  hero.source = "log";
}

/** The account the client last signed tables in with (whole-file scan). */
export function lastLogin(path: string): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8").decode(readFileSync(path));
  } catch {
    return null;
  }
  let last: string | null = null;
  for (const m of text.matchAll(LOGIN_G)) last = m[1]!;
  return last;
}

const RANK: Record<string, string> = {
  TWO: "2", THREE: "3", FOUR: "4", FIVE: "5", SIX: "6", SEVEN: "7", EIGHT: "8", NINE: "9", TEN: "T", JACK: "J",
  QUEEN: "Q", KING: "K", ACE: "A",
};
const SUIT: Record<string, string> = { SPADES: "s", HEARTS: "h", DIAMONDS: "d", CLUBS: "c" };
export const STREETS = ["FLOP", "TURN", "RIVER"];
export const ACTIONS = new Set(["SB", "BB", "Ante", "AutoBB", "Fold", "Check", "Call", "Raise", "AllIn"]);

/** str() of a money value the log wrote as a C# double (Python holds it as a float). */
export const money = (v: unknown): string => (v === null || v === undefined ? "None" : typeof v === "number" ? pyFloatStr(v) : pyStr(v));

export function card(c: any): string | null {
  if (!c || typeof c !== "object" || !Object.keys(c).length) return null;
  return (RANK[c.value ?? ""] ?? "?") + (SUIT[c.suit ?? ""] ?? "?");
}

export type Bean = Record<string, any>;

/** One log line -> [cmd, {room, bean}] for SendMessageToPipe command beans. */
export function parseLine(line: string): [string, { room: string | null; bean: Bean }] | null {
  const i = line.indexOf("SendMessageToPipe - {");
  if (i < 0) return null;
  let m: any;
  try {
    m = JSON.parse(line.slice(i + 20));
  } catch {
    return null;
  }
  const d = m && typeof m === "object" && !Array.isArray(m) ? m.Data : undefined;
  const cb = d && typeof d === "object" && !Array.isArray(d) ? d.cmd_bean : null;
  if (!cb || typeof cb !== "object" || Array.isArray(cb) || !truthy(cb.Cmd)) return null;
  let bean: any;
  try {
    bean = JSON.parse(cb.BeanData || "null");
  } catch {
    bean = null;
  }
  return [cb.Cmd, { room: cb.RoomName || d.room_name || null, bean: bean && typeof bean === "object" && !Array.isArray(bean) ? bean : {} }];
}

/** A SendMessageToPipe line whose JSON does not parse (vs one that parses but carries no command bean). */
export function truncated(line: string): boolean {
  const i = line.indexOf("SendMessageToPipe - {");
  if (i < 0) return false;
  try {
    JSON.parse(line.slice(i + 20));
    return false;
  } catch {
    return true;
  }
}

export type Seat = { name: string; chips: unknown; playing: unknown };
export type Hand = Record<string, any> & {
  id: string; seats: Map<number, Seat>; streetBet: Map<string, number>; stacks?: Map<string, any>; startStacks?: Map<string, any>;
  shown: Map<string, (string | null)[]>; returned?: Map<number, number>;
};

export function newHand(hid: string): Hand {
  return {
    id: hid, sb: null, bb: null, ante: null, button: null, seats: new Map(), hero: null, heroCards: null, board: [],
    street: "PREFLOP", actions: [], toAct: null, pot: null, winners: null, shown: new Map(), done: false, t0: time(),
    streetBet: new Map(), dealt: [],
  };
}

const copySeats = (m: Map<number, Seat>) => new Map([...m].map(([k, v]) => [k, { ...v }]));
const sortN = (xs: number[]) => [...xs].sort((a, b) => a - b);

/** Hand state for one table (room). */
export class Room {
  name: string;
  seats = new Map<number, Seat>();
  hand: Hand | null = null;
  last: Hand | null = null;
  status = new Map<string, string>();
  finished: Hand[] = [];
  touched = 0.0;
  closed = false;
  private ts: unknown = null;
  props: Record<string, any> = {};
  sitout: Record<string, any> = {};

  constructor(name: string) {
    this.name = name;
  }

  get coinType() {
    return this.props.coinType ?? null;
  }

  /** True ONLY when the server said so (coinType 2). Unknown = not practice. */
  get practice(): boolean {
    return this.props.coinType === 2;
  }

  finish(): void {
    if (this.hand && !this.hand.done) {
      this.hand.done = true;
      this.hand.tEnd = time();
      this.last = this.hand;
      this.finished.push(this.hand);
    }
  }

  private handFor(hid: string | null): Hand {
    if (hid && (!this.hand || this.hand.id !== hid)) {
      this.finish();
      this.hand = newHand(hid);
      const ts = truthy(this.ts) ? String(this.ts) : "";
      this.hand.serverT0 = /^\d+$/.test(ts) ? pyInt(ts) : null;
    }
    if (!this.hand) this.hand = newHand(hid || "?");
    return this.hand;
  }

  /** Fold one command in; returns human-readable feed lines. `at` is the log line's own time. */
  apply(cmd: string, b: Bean, at: number | null = null): string[] {
    const out: string[] = [];
    this.touched = at || time();
    this.closed = false;
    this.ts = b.initTimeStamp ?? null;
    const hid: string | null = b.gameHandId || b.gameId || null;
    if (cmd === "game.game_alldata") {
      this.props = b.roomProperties || {};
      return out;
    }
    if (cmd === "game.sitout") {
      this.sitout = b.sitOutMap || {};
      const on = Object.entries(this.sitout).filter(([, v]) => truthy(v)).map(([k]) => k);
      out.push("hero sit-out: " + (on.length ? on.join(", ") : "off"));
      return out;
    }
    if (cmd === "game.seatInfo") {
      for (const s of b.seatResponseDataList || []) {
        if (truthy(s.userName)) this.seats.set(s.seatId, { name: s.userName, chips: s.userChips ?? null, playing: s.isPlaying ?? null });
        else this.seats.delete(s.seatId ?? null);
      }
      if (this.hand && !this.hand.done) this.hand.seats = copySeats(this.seats);
      return out;
    }
    if (cmd === "game.pre_hand_start_info") {
      const h = this.handFor(hid);
      Object.assign(h, { sb: b.sbAmount ?? null, bb: b.bbAmount ?? null, ante: b.anteAmount ?? null, button: b.dealerSeatId ?? null });
      h.seats = copySeats(this.seats);
      h.stacks = new Map([...h.seats.values()].filter((s) => s.chips !== null && s.chips !== undefined).map((s) => [s.name, s.chips]));
      h.startStacks = new Map(h.stacks);
      for (const [sid, s] of h.seats) if (s.name === hero.name) h.hero = sid;
      h.dealt = sortN([...h.seats].filter(([, s]) => truthy(s.playing)).map(([sid]) => sid));
      const btnSeat = h.seats.get(h.button);
      const btn = btnSeat ? btnSeat.name : h.button;
      out.push(`--- hand ${pyStr(h.id)}  ${money(h.sb)}/${money(h.bb)}`
        + (truthy(h.ante) ? ` ante ${money(h.ante)}` : "")
        + `  button ${pyStr(btn)}  | `
        + [...h.seats.values()].map((s) => `${s.name} ${money(s.chips)}`).join(", "));
      return out;
    }
    if (cmd === "game.game_start") {
      const h = this.handFor(hid);
      h.button = "dealerSeatId" in b ? b.dealerSeatId : h.button;
      return out;
    }
    if (cmd === "game.hole_cards") {
      const h = this.handFor(hid);
      h.heroCards = (b.holeCards || []).map(card);
      if (h.hero !== null && h.hero !== undefined && !h.dealt.includes(h.hero)) h.dealt = sortN([...h.dealt, h.hero]);
      out.push(`HERO dealt ${h.heroCards.map((c: string | null) => pyStr(c)).join("")}`);
      return out;
    }
    if (cmd === "game.seat") {
      const cap = b.caption ?? null;
      if (!ACTIONS.has(cap)) {
        if (truthy(b.userName)) this.status.set(b.userName, cap);
        return out;
      }
      if (!this.hand) return out;
      const h = this.handFor(hid);
      const name = b.userName ?? null;
      const to = pyFloat(truthy(b.betAmout) ? b.betAmout : 0);
      const prev = cap === "Ante" ? 0.0 : (h.streetBet.has(name) ? h.streetBet.get(name)! : 0.0);
      const label = b.newCaption || cap;
      const added = cap === "Fold" ? 0.0 : pyRound(Math.max(to - prev, 0), 4);
      const a: Record<string, any> = {
        street: h.street, seat: b.seatId ?? null, name, action: label, caption: cap, to, added, stack: b.userChips ?? null, t: b.initTimeStamp ?? null,
      };
      if (cap !== "Fold" && cap !== "Ante") h.streetBet.set(name, to);
      const st = h.stacks ??= new Map();
      if (st.has(name) && b.userChips !== null && b.userChips !== undefined && Math.abs(st.get(name) - added - b.userChips) > 0.005) {
        a.mismatch = pyRound(st.get(name) - added - b.userChips, 4);
        out.push(`  !! stack mismatch for ${pyStr(name)}: expected ${fmtFixed(st.get(name) - added, 2)}, server says ${money(b.userChips)}`);
      }
      if (b.userChips !== null && b.userChips !== undefined) st.set(name, b.userChips);
      h.actions.push(a);
      if (a.seat !== null && !h.dealt.includes(a.seat) && cap !== "Ante") h.dealt = sortN([...h.dealt, a.seat]);
      if (!["SB", "BB", "Ante", "AutoBB"].includes(cap)) this.status.set(name, "Inuse");
      if (h.toAct === name) h.toAct = null;
      if (h.seats.has(b.seatId)) h.seats.get(b.seatId)!.chips = b.userChips ?? null;
      const who = name === hero.name ? "HERO" : name;
      const amt = label === "Fold" || label === "Check" ? "" : ` ${fmtG(to)}`;
      out.push(`  ${String(h.street).slice(0, 4).toLowerCase()}  ${pyStr(who)} ${pyStr(label)}${amt}  (stack ${money(b.userChips ?? null)})`);
      return out;
    }
    if (cmd === "game.dealer_cards") {
      const h = this.handFor(hid);
      const dc = b.dealerCards || {};
      let board: (string | null)[] = [];
      for (const st of STREETS) board = [...board, ...(dc[st] || []).map(card)];
      if (board.length > h.board.length) {
        h.board = board;
        h.street = ({ 3: "FLOP", 4: "TURN", 5: "RIVER" } as Record<number, string>)[board.length] ?? h.street;
        h.streetBet = new Map();
        out.push(`  == ${h.street} ${board.map((c) => pyStr(c)).join(" ")}`);
      }
      return out;
    }
    if (cmd === "game.user_turn") {
      const h = this.handFor(hid);
      h.toAct = b.whoseTurn ?? null;
      h.turnAt = time();
      const opts = b.userTurnOptions ?? null;
      h.heroOptions = b.whoseTurn === hero.name
        ? { ...Object.fromEntries(["callAmount", "potRaiseValue", "potAmount", "roundMaxBet", "totalPot"].map((k) => [k, b[k] ?? null])), options: opts }
        : null;
      if (b.whoseTurn === hero.name) out.push(`  >>> HERO TO ACT  pot ${money(b.totalPot ?? null)}  call ${money(b.callAmount ?? null)}`);
      return out;
    }
    if (cmd === "game.potInfo") {
      if (this.hand) this.hand.pot = b.totalPotAmount ?? null;
      return out;
    }
    if (cmd === "game.show_hole_cards" || cmd === "game.reveal_cards") {
      if (this.hand) {
        for (const u of b.userCardListMap || []) {
          const nm = u.userName || u.playerName || this.hand.seats.get(u.seatId)?.name || this.seats.get(u.seatId)?.name || null;
          if (this.hand.shown.has(nm)) continue;
          const cs = u.cards || u.holeCards || [];
          if (truthy(nm) && truthy(cs)) {
            this.hand.shown.set(nm, cs.map(card));
            out.push(`  shows ${nm} ${this.hand.shown.get(nm)!.map((c) => pyStr(c)).join("")}`);
          }
        }
      }
      return out;
    }
    if (cmd === "game.winnerInfo") {
      if (this.hand) {
        const w: any[] = [];
        for (const pot of b.winnerDataList || []) {
          for (const x of ((pot.winnerDetails || {}).winnerList || [])) {
            w.push({ name: x.playerName ?? null, won: x.winAmountFromPot ?? null, pot: pot.potAmount ?? null, potAfterRake: pot.potAmountAfterRake ?? null });
          }
        }
        this.hand.winners = w;
        out.push("  wins: " + w.map((x) => `${pyStr(x.name)} ${money(x.won)} (pot ${money(x.pot)}, after rake ${money(x.potAfterRake)})`).join(", "));
      }
      return out;
    }
    if (cmd === "game.quit_table" || cmd === "game.leave_Seat") {
      this.finish();
      if (cmd === "game.quit_table") {
        this.closed = true;
        this.hand = null;
      }
      out.push(cmd === "game.quit_table" ? "hero left the table" : "hero left the seat");
      return out;
    }
    if (cmd === "game.return_chips") {
      if (this.hand && truthy(b.chipsToReturn)) {
        const sid = b.seatId ?? null;
        const ret = this.hand.returned ??= new Map();
        ret.set(sid, pyRound((ret.get(sid) || 0) + pyFloat(b.chipsToReturn), 4));
        const nm = this.hand.seats.get(sid)?.name ?? sid;
        out.push(`  returned ${money(b.chipsToReturn)} to ${pyStr(nm)} (uncalled)`);
      }
      return out;
    }
    if (cmd === "game.reset_data") {
      this.finish();
      return out;
    }
    return out;
  }
}

// ---- ParsedHand export (ignition CONTRACT.md §1a) ----
const SUIT_GLYPH: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
const TYPE: Record<string, string> = {
  SB: "post-sb", BB: "post-bb", AutoBB: "post-bb", Fold: "fold", Check: "check", Call: "call", Bet: "bet", Raise: "raise",
  AllIn: "all-in",
};

/**
 * The contract type of one logged action. newCaption names the BUTTON that was pressed, and a sizing preset is a
 * button of its own: a bet made with the Pot button logs caption "Raise", newCaption "Pot" (2026-09-24, hand
 * 140706500001 — the villain's flop and turn bets were dropped from the line, hero was answered as if first to act,
 * and got "Check" facing a 21bb bet). An unknown label falls back to the caption; a preset raise with nothing to
 * raise on this street is a bet (the log's own "Bet" label does the same).
 */
export function actionType(a: { action: string; caption?: string | null; street: string }, streetTop: number): string | null {
  const t = TYPE[a.action];
  if (t) return t;
  const c = TYPE[a.caption ?? ""] ?? null;
  if (c === "raise" && a.street !== "PREFLOP" && streetTop <= 0) return "bet";
  return c;
}

/** 'Ts' -> 'T♠' — the contract's card form (ranks use T, never 10). */
export function glyph(c: string | null | undefined): string | null {
  return c && c.length === 2 ? c[0]! + (SUIT_GLYPH[c[1]!] ?? c[1]!) : null;
}

/** gto-trainer vocabulary, button-backwards (ignition's _positions_all). */
export function positions(dealt: number[], button: number | null): Map<number, string> {
  if (!dealt.length || button === null || button === undefined) return new Map();
  const seats = sortN([...new Set([...dealt, button])]);
  const i = seats.indexOf(button);
  const order = [...seats.slice(i + 1), ...seats.slice(0, i + 1)];
  const n = order.length;
  if (n === 2) {
    const other = order.find((s) => s !== button)!;
    return new Map([[button, "SB"], [other, "BB"]]);
  }
  let names: string[];
  if (n === 3) names = ["SB", "BB", "BTN"];
  else {
    const pool = n > 6 ? ["UTG", "UTG1", "UTG2", "LJ", "HJ", "CO"] : ["UTG", "HJ", "CO"];
    names = ["SB", "BB", ...pool.slice(-(n - 3)), "BTN"];
  }
  const out = new Map<number, string>();
  order.forEach((s, k) => { if (k < names.length) out.set(s, names[k]!); });
  return out;
}

/** The room's current hand as a ParsedHand (amounts in BB), or null between hands. */
export function exportHand(room: Room): Record<string, any> | null {
  const h = room.hand;
  if (!h || h.done || !truthy(h.bb)) return null;
  const bb = pyFloat(h.bb);
  const r2 = (v: number | null | undefined) => (v !== null && v !== undefined ? pyRound(v / bb, 2) : null);
  const nameSeat = new Map<string, number>();
  for (const [sid, s] of h.seats) nameSeat.set(s.name, sid);
  const heroSeat = h.hero ?? null;
  const dealt: number[] = [...h.dealt];
  const pos = positions(dealt, h.button ?? null);
  const street = String(h.street).toLowerCase();
  const actions: any[] = [];
  const committed = new Map<number, number | null>();
  let pot = 0.0, ante = 0.0;
  const top = new Map<string, number>();   // the highest street total so far, per street (bet vs raise for a preset)
  const untyped: string[] = [];            // actions that moved chips but have no type: the line cannot be trusted
  for (const a of h.actions) {
    pot += a.added;
    const sid = a.seat !== null && a.seat !== undefined ? a.seat : nameSeat.get(a.name) ?? null;
    if (a.action === "Ante") {
      ante += a.added;
      continue;
    }
    const t = actionType(a, top.get(a.street) ?? 0.0);
    if (a.action !== "Fold") top.set(a.street, Math.max(top.get(a.street) ?? 0.0, a.to || 0.0));
    if (!t) {
      if (a.added > 0) untyped.push(`${a.name} ${a.action} ${fmtG(a.to)} on the ${String(a.street).toLowerCase()}`);
      continue;
    }
    const rec: Record<string, any> = { seatId: sid, hero: sid === heroSeat && heroSeat !== null, type: t, street: String(a.street).toLowerCase() };
    if (t !== "check" && t !== "fold") rec.amount = r2(t === "call" ? a.added : a.to);
    actions.push(rec);
  }
  for (const [name, v] of h.streetBet) if (nameSeat.has(name)) committed.set(nameSeat.get(name)!, r2(v));
  let maxBet = 0.0;
  let first = true;
  for (const v of h.streetBet.values()) { if (first || v > maxBet) { maxBet = v; first = false; } }
  const heroName = heroSeat !== null ? (h.seats.get(heroSeat)?.name ?? null) : null;
  const heroOwed = heroName ? Math.max(0.0, maxBet - (h.streetBet.has(heroName) ? h.streetBet.get(heroName)! : 0.0)) : 0.0;
  const folded = new Set(actions.filter((a) => a.type === "fold").map((a) => a.seatId));
  const heroFolded = heroSeat !== null && folded.has(heroSeat);
  const villains = dealt.filter((s) => s !== heroSeat);
  const heroWon = heroSeat !== null && !heroFolded && villains.length > 0 && villains.every((s) => folded.has(s));
  const toActName = h.toAct ?? null;
  const toActSeat = truthy(toActName) ? nameSeat.get(toActName) ?? null : null;
  const toActHero = toActSeat !== null && toActSeat === heroSeat && !heroFolded && !truthy(h.winners);
  const st = room.status.get(heroName || "") ?? "";
  const status = heroSeat === null || !dealt.includes(heroSeat) ? "not-in-hand"
    : heroFolded ? "folded" : truthy(h.heroCards) ? "in-hand" : st === "Sitout" ? "sitting-out" : "unknown";
  const why = toActHero ? null : heroSeat === null ? "no hero seat" : heroFolded ? "hero folded"
    : heroWon || truthy(h.winners) ? "hand won" : toActSeat !== null ? `action on seat ${toActSeat}` : "action-on unknown";
  const stacks = new Map<number, number | null>();
  for (const [n, v] of h.stacks || new Map()) if (nameSeat.has(n)) stacks.set(nameSeat.get(n)!, r2(v));
  return {
    handId: /^\d+$/.test(String(h.id)) ? pyInt(String(h.id)) : h.id,
    clientHandId: h.id,
    site: "coinpoker",
    room: room.name,
    coinType: room.coinType,
    practice: room.practice,
    sitOut: { ...room.sitout },
    bb, sb: h.sb ?? null, ante: truthy(h.ante) ? h.ante : 0,
    bbCents: pyRound(bb * 100),
    anteBb: r2(ante) || 0,
    heroSeatId: heroSeat,
    heroName,
    heroCards: (h.heroCards || []).map(glyph),
    board: h.board.map(glyph),
    street,
    actions,
    liveSeats: dealt,
    committed,
    potByStreet: {},
    positions: pos,
    names: new Map([...h.seats].map(([sid, s]) => [sid, s.name])),
    stacks: stacks.size ? stacks : null,
    currentNode: {
      street, toActSeatId: toActSeat, toActIsHero: toActHero, pot: r2(pot) || 0, toCall: r2(heroOwed) || 0,
      legalActions: [], complete: false,
    },
    heroFolded,
    heroWon,
    ended: heroFolded || heroWon || truthy(h.winners),
    buttonsUp: null,
    toActSources: { buttons: null, ws: toActHero, actionOn: toActSeat, wsAt: h.turnAt ?? null, timeBank: null },
    heroStatus: status,
    notToActWhy: why,
    lineSource: "log",
    lineUncertain: untyped.length ? `the log has an action the reader cannot type, so the line is missing it: ${untyped.join("; ")}` : null,
    lineNote: null,
  };
}

// ---- the tail ----
export const QUIT = /TransformToBean - RoomName - (.+?) cmd - game\.quit_table\s*$/;
export const PREFIX = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d:\d{3} \[\w+\]\s+\[UNITY\] Stdout: /;
export const QUIET = new Set(["game.dealer_chat", "game.dealer_chat_action", "game.wait_list_data", "game.wait_list_status",
  "game.game_ready", "game.return_chips", "game.cumulativeWinnerInfo", "game.seatInfo", "game.potInfo", "game.game_start",
  "game.user_turn", "game.reset_data"]);

/** '2026-09-22 04:47:27:083 [info] ...' -> epoch seconds (local clock), or null. */
export function lineTime(prefix: string): number | null {
  const base = mktimeYmdHms(prefix.slice(0, 19));
  if (base === null) return null;
  try {
    return base + pyInt(prefix.slice(20, 23)) / 1000;
  } catch {
    return null;
  }
}

/** Tails main.log; rooms keyed by RoomName. */
export class Feed {
  path: string;
  rooms = new Map<string, Room>();
  pos: number;
  private skipPartial: boolean;
  lineAt: number | null = null;
  private buf = "";
  pending: string | null = null;
  private tries = 0;
  unknown = new Map<string, number>();
  broken = 0;

  /** fromStart reads the whole file; otherwise the last `backfill` bytes are replayed first. */
  constructor(path: string = LOG(), fromStart = false, backfill = 3_000_000) {
    this.path = path;
    const size = existsSync(path) ? statSync(path).size : 0;
    this.pos = fromStart ? 0 : Math.max(0, size - backfill);
    this.skipPartial = this.pos > 0;
    if (!hero.name && existsSync(path)) learnHero(lastLogin(path) || "");
  }

  /** Rejoin a SendMessageToPipe line the logger split into chunks. */
  join(rawLine: string): [string, { room: string | null; bean: Bean }] | null {
    const line = rawLine.replace(/\r+$/, "");
    const m = PREFIX.exec(line);
    if (m) this.lineAt = lineTime(m[0]) || this.lineAt;
    const content = m ? line.slice(m[0].length) : line;
    if (this.pending !== null) {
      const joined = this.pending + content;
      const p = parseLine(joined);
      if (p) {
        this.pending = null;
        return p;
      }
      this.tries += 1;
      if (content.startsWith("[") || this.tries > 6) {
        if (this.pending.includes("cmd_bean")) this.broken += 1;
        this.pending = null;
      } else {
        this.pending = joined;
        return null;
      }
    }
    const p = parseLine(content);
    if (p === null && truncated(content)) {
      this.pending = content;
      this.tries = 0;
    }
    return p;
  }

  /** Feed.poll's per-line body: sign-in scan, rejoin, the quit fallback, Room.apply. */
  processLine(line: string): [string, string][] {
    const out: [string, string][] = [];
    if (line.includes("Login on SFS")) {
      const lm = LOGIN.exec(line);
      if (lm) learnHero(lm[1]!);
    }
    const p = this.join(line);
    if (!p) {
      const q = QUIT.exec(line);
      if (q && this.rooms.has(q[1]!)) {
        for (const s of this.rooms.get(q[1]!)!.apply("game.quit_table", {}, this.lineAt)) out.push([q[1]!, s]);
      }
      return out;
    }
    const [cmd, d] = p;
    const room = d.room || "?";
    let r = this.rooms.get(room);
    if (!r) {
      r = new Room(room);
      this.rooms.set(room, r);
    }
    const lines = r.apply(cmd, d.bean, this.lineAt);
    for (const s of lines) out.push([room, s]);
    if (!lines.length && cmd.startsWith("game.") && !QUIET.has(cmd)) this.unknown.set(cmd, (this.unknown.get(cmd) || 0) + 1);
    return out;
  }

  /** Read whatever is new; returns [room, line] pairs. */
  poll(): [string, string][] {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.pos) {
      this.pos = 0;
      this.buf = "";
    }
    if (size === this.pos) return [];
    const fd = openSync(this.path, "r");
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(size - this.pos);
      readSync(fd, chunk, 0, chunk.length, this.pos);
    } finally {
      closeSync(fd);
    }
    this.pos = size;
    const text = this.buf + new TextDecoder("utf-8").decode(chunk);
    const lines = text.split("\n");
    this.buf = lines.pop()!;
    if (this.skipPartial && lines.length) {
      lines.shift();
      this.skipPartial = false;
    }
    const out: [string, string][] = [];
    for (const line of lines) out.push(...this.processLine(line));
    return out;
  }

  /** The table hero plays: the most recently active room where hero is seated; else the most recent at all. */
  active(): Room | null {
    const rooms = [...this.rooms.values()].sort((a, b) => b.touched - a.touched).filter((r) => !r.closed);
    const seated = rooms.filter((r) => [...r.seats.values()].some((s) => s.name === hero.name));
    return (seated.length ? seated : rooms)[0] ?? null;
  }

  drainFinished(): [Room, Hand][] {
    const out: [Room, Hand][] = [];
    for (const r of this.rooms.values()) {
      for (const h of r.finished) out.push([r, h]);
      r.finished = [];
    }
    return out;
  }
}
