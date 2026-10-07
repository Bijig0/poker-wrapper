/**
 * A plain hand-history text for a (normalized) hand — the "full hand history" the stress-500 replayer shows beside the
 * table. Amounts in big blinds, as the archive holds them: a call's amount is its increment, a bet/raise/all-in's the
 * round total.
 */
import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";

const ORDER_CW = ["BTN", "SB", "BB", "UTG", "HJ", "CO"];
const bb = (x: number | undefined): string => (x == null ? "" : `${Math.round(x * 100) / 100}bb`);

export function handHistoryText(hand: ParsedHand, meta: { id?: string; family?: string; title?: string } = {}): string {
  const lines: string[] = [];
  const pos = (seat: number): string => String(hand.positions?.[seat] ?? `seat ${seat}`);
  const heroPos = pos(hand.heroSeatId);
  const dealt = (hand as any).startStacks ?? hand.stacks ?? {};
  const seats = Object.keys(hand.positions ?? {}).map(Number).sort((a, b) => ORDER_CW.indexOf(pos(a)) - ORDER_CW.indexOf(pos(b)));
  lines.push(`Hand ${meta.id ?? hand.clientHandId ?? ""} · NL200 6-max · $1/$2 · ${seats.length} players${meta.title ? ` · ${meta.title}` : ""}`);
  for (const s of seats) lines.push(`Seat ${s}: ${pos(s).padEnd(3)} ${bb(Number(dealt[s] ?? 0)).padStart(8)}${s === hand.heroSeatId ? "  (hero)" : ""}`);
  lines.push(`Hero (${heroPos}) is dealt ${hand.heroCards.join(" ")}`);
  let street = "";
  const board = hand.board ?? [];
  const invested: Record<number, number> = {};
  let pot = 0;
  for (const a of hand.actions) {
    if (a.street !== street) {
      if (street) { pot += Object.values(invested).reduce((x, y) => x + y, 0); for (const k of Object.keys(invested)) delete invested[Number(k)]; }
      street = a.street;
      const cards = street === "flop" ? board.slice(0, 3) : street === "turn" ? board.slice(0, 4) : street === "river" ? board.slice(0, 5) : [];
      lines.push(`*** ${street.toUpperCase()} ***${cards.length ? ` [${cards.join(" ")}]` : ""}${street !== "preflop" ? ` pot ${bb(pot)}` : ""}`);
    }
    const who = `${pos(a.seatId)}${a.hero ? " (hero)" : ""}`;
    const have = invested[a.seatId] ?? 0;
    let text: string;
    switch (a.type) {
      case "post-sb": text = `posts the small blind ${bb(a.amount)}`; invested[a.seatId] = have + (a.amount ?? 0); break;
      case "post-bb": text = `posts the big blind ${bb(a.amount)}`; invested[a.seatId] = have + (a.amount ?? 0); break;
      case "post": text = `posts ${bb(a.amount)} to come in`; invested[a.seatId] = have + (a.amount ?? 0); break;
      case "fold": text = "folds"; break;
      case "check": text = "checks"; break;
      case "call": text = `calls ${bb(a.amount)}`; invested[a.seatId] = have + (a.amount ?? 0); break;
      case "bet": text = `bets ${bb(a.amount)}`; invested[a.seatId] = a.amount ?? have; break;
      case "raise": text = `raises to ${bb(a.amount)}`; invested[a.seatId] = a.amount ?? have; break;
      case "all-in": {
        const high = Math.max(0, ...Object.values(invested));
        text = (a.amount ?? 0) > high + 0.001 ? `goes all-in, raising to ${bb(a.amount)}` : `calls all-in (${bb(a.amount)} in this round)`;
        invested[a.seatId] = a.amount ?? have;
        break;
      }
      default: text = `${a.type} ${bb(a.amount)}`;
    }
    lines.push(`${who}: ${text}`);
  }
  pot += Object.values(invested).reduce((x, y) => x + y, 0);
  lines.push(`*** END *** total pot ${bb(pot)}${board.length ? ` · board [${board.join(" ")}]` : ""}`);
  return lines.join("\n");
}
