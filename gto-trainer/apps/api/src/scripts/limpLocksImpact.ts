/**
 * WHAT LIMP_LOCKS=v3 CHANGES ON REAL HANDS (2026-10-09; services/poolLimpFloor.ts, the v3 table). Offline, read-only:
 * no requests, no solves. The replay gate cannot show it — its postflop replays read the flop ranges the LIVE solve
 * used (the stored traces), and a new villain range is a new GTO Wizard body it may not send — so this reads the
 * archived hands themselves:
 *   1. every archived hand (since --since) with a villain who limped / completed before any raise at 85bb or less, never
 *      raised, and saw the flop: his pool limp key and range under v2 and under v3 (key, frequency, combos) — the range
 *      the flop floor (arrival:pool-limp-floor) or the pool-call overlay (a limp in a two-limper pot) gives him;
 *   2. which of those decisions actually carried a pool range in the answer log (the notes "POOL LIMP RANGE:" /
 *      "POOL CALL RANGE:" naming that seat) — the decisions whose solver input moves under v3;
 *   3. the preflop side: the GTO Wizard pool lock (preflop:pool-limp-lock) only ever takes a first-in or SB-folded-to
 *      key, unchanged in v3; hero's own self-lock (HERO_SELF_LOCK) reads poolLimpKey for HIS short over-limp / complete
 *      — logged ones listed.
 *
 *   bun src/scripts/limpLocksImpact.ts [--since 2026-09-19] [--data C:/Users/Brady/poker-data] [--list 40]
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { dealtByPos } from "../services/hrc6max";
import { limpLockRange, poolLimpersOf, poolLimpKey, type LimpLocksVersion } from "../services/poolLimpFloor";

const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const SINCE = arg("since") ?? "2026-09-19";
const DATA = (arg("data") ?? process.env.POKER_DATA_DIR ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/");
const LIST = Number(arg("list") ?? 40);
const db = new Database(join(DATA, "poker.sqlite"), { readonly: true });
{
  const live = db.query("select id from sessions where ended_at is null limit 1").get() as { id: string } | null;
  if (live) { console.error(`a poker session is LIVE (${live.id}) — not scanning; run again when it has ended`); process.exit(2); }
}
const cc = (c: string) => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12);
const combos = (w: Record<string, number>) => Math.round(Object.entries(w).reduce((s, [c, x]) => s + cc(c) * x, 0) * 10) / 10;
const desc = (key: string | null, v: LimpLocksVersion) => {
  if (!key) return "—";
  const r = limpLockRange(key, v)!;
  return `${key} ${(100 * r.freq).toFixed(1)}% (${combos(r.weights)} combos)`;
};

const sinceMs = Date.parse(`${SINCE}T00:00:00+07:00`);
const answers = db.query(`select id, ts, client_hand_id cid, street, warning, fail_reason fail from answers where ts >= ? and session_id is not null order by ts`).all(sinceMs) as
  { id: number; ts: number; cid: string; street: string; warning: string | null; fail: string | null }[];
const byHand = new Map<string, typeof answers>();
for (const a of answers) { const l = byHand.get(a.cid) ?? []; l.push(a); byHand.set(a.cid, l); }

type Row = { hand: string; pos: string; role: string; stack: number; k2: string; k3: string; changed: boolean; sawFlop: boolean; fired: { id: number; street: string; how: string }[] };
const rows: Row[] = [];
let hands = 0, unread = 0, limpedHands = 0;
for (const cid of byHand.keys()) {
  const row = db.query("select data from hands where client_hand_id = ? order by rowid desc limit 1").get(cid) as { data: string } | null;
  if (!row) continue;
  let raw: any, hand: any;
  try { raw = JSON.parse(row.data); hand = normalizeHand(raw).hand; } catch { unread++; continue; }
  hands++;
  const heroPos = hand.positions?.[hand.heroSeatId] ?? null;
  const byPos = dealtByPos(hand, heroPos, raw.startStacks ?? undefined);
  const posOf = (a: any) => String(a.seatId === hand.heroSeatId && heroPos ? heroPos : hand.positions?.[a.seatId] ?? "").toUpperCase();
  const folded = new Set((hand.actions ?? []).filter((a: any) => a.street === "preflop" && a.type === "fold").map(posOf));
  const sawFlop = (hand.actions ?? []).some((a: any) => a.street === "flop") || (hand.board?.length ?? 0) >= 3;
  let any = false;
  for (const l of poolLimpersOf(hand, heroPos)) {
    if (l.raisedLater) continue;
    const stack = Number(byPos[l.pos as keyof typeof byPos] ?? NaN);
    const k2 = poolLimpKey(l, stack, "v2"), k3 = poolLimpKey(l, stack, "v3");
    if (!k2 || !k3) continue;
    any = true;
    const r2 = limpLockRange(k2, "v2")!, r3 = limpLockRange(k3, "v3")!;
    const changed = k2 !== k3 || JSON.stringify(r2.weights) !== JSON.stringify(r3.weights);
    const fired = (byHand.get(cid) ?? []).filter((a) => a.street !== "preflop").flatMap((a) => {
      const w = a.warning ?? "";
      const out: { id: number; street: string; how: string }[] = [];
      if (new RegExp(`POOL LIMP RANGE: [^·]*the ${l.pos} \\(`).test(w)) out.push({ id: a.id, street: a.street, how: "floor" });
      else if (new RegExp(`POOL CALL RANGE: [^·]*the ${l.pos} \\(\\d+bb\\) [^—]*— [\\d.]+ combos on [^,]+, now the pool's (limp_first|overlimp|sbcomplete)`).test(w)) out.push({ id: a.id, street: a.street, how: "pool-call" });
      return out;
    });
    rows.push({ hand: cid, pos: l.pos, role: l.complete ? (l.limpsBefore ? `SB behind ${l.limpsBefore}` : "SB folded to") : (l.limpsBefore ? `over-limp behind ${l.limpsBefore}` : "first-in"),
      stack: Math.round(stack * 10) / 10, k2, k3, changed, sawFlop: sawFlop && !folded.has(l.pos), fired });
  }
  if (any) limpedHands++;
}

console.log(`LIMP_LOCKS v3 vs v2 on the archived hands of logged sessions since ${SINCE} (${DATA}/poker.sqlite, read-only)`);
console.log(`hands read ${hands} (unreadable ${unread}); hands with a short (<=85bb) villain limper / completer who never raised: ${limpedHands}; limpers ${rows.length}`);
const tally = (xs: Row[]) => { const m = new Map<string, number>(); for (const r of xs) m.set(`${r.k2} -> ${r.k3}`, (m.get(`${r.k2} -> ${r.k3}`) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
const changed = rows.filter((r) => r.changed);
console.log(`\n1. KEY / RANGE per limper: unchanged ${rows.length - changed.length} (first-in, SB folded to — the kept Ignition cells), changed ${changed.length}`);
for (const [k, n] of tally(rows)) console.log(`   ${String(n).padStart(4)}  ${k}${k.split(" -> ")[0] === k.split(" -> ")[1] && !rows.find((r) => `${r.k2} -> ${r.k3}` === k)!.changed ? "  (same range)" : ""}`);
const atFlop = changed.filter((r) => r.sawFlop);
console.log(`   of the changed: ${atFlop.length} reached the flop with the limper in`);

const fired = changed.filter((r) => r.fired.length);
const decisions = fired.reduce((s, r) => s + r.fired.length, 0);
console.log(`\n2. DECISIONS WHOSE SOLVER INPUT MOVES (a logged postflop answer gave that limper the pool range): ${decisions} decisions in ${new Set(fired.map((r) => r.hand)).size} hands`);
for (const r of fired.slice(0, LIST)) {
  console.log(`   hand ${r.hand} ${r.pos} ${r.stack}bb ${r.role}: ${desc(r.k2, "v2")}  ->  ${desc(r.k3, "v3")}`);
  console.log(`      ${r.fired.map((f) => `#${f.id} ${f.street} (${f.how})`).join(", ")}`);
}
const unfired = atFlop.filter((r) => !r.fired.length);
console.log(`   reached the flop, changed key, but no logged pool range (a pool tree covered him, the AI pin locked him, or no postflop answer): ${unfired.length}`);
for (const r of unfired.slice(0, 12)) console.log(`   hand ${r.hand} ${r.pos} ${r.stack}bb ${r.role}: ${r.k2} -> ${r.k3}`);

const self = answers.filter((a) => a.street === "preflop" && /the pool's (limp|complete) range (overlimp_short|sbcomplete_b\d_short|sbcomplete_b3|sbcomplete_b2_deep)/.test(a.warning ?? ""));
console.log(`\n3. PREFLOP: the pool lock takes first-in / SB-folded-to keys only (the same in v3). Hero self-locks on a changed key: ${self.length}`);
for (const a of self.slice(0, LIST)) console.log(`   #${a.id} hand ${a.cid}: ${/the pool's (?:limp|complete) range (\S+)/.exec(a.warning ?? "")?.[1]}`);
