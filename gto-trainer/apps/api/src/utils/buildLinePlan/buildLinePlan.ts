/**
 * Turn a captured GTO Wizard line (GtowCdp.lineState) into the plan a Tier-2
 * AI re-solve needs: which prefill scenario to pick, per-street sizes to fix
 * so the actual line is replayable in the new tree, and the ordered actions
 * to replay up to the off-tree villain node.
 */
import { parseBetLabel } from "../parseBetLabel/parseBetLabel";

export interface LineAction {
  tst: string;
  position: string;
  active: boolean;
  taken: string | null;
  options: string[];
}

export interface LineStreet {
  street: string; // preflop | flop | turn | river
  cards: string[];
  pot: number | null;
  actions: LineAction[];
}

export interface LineState {
  streets: LineStreet[];
  activeTst: string | null;
  activePosition: string | null;
  board: string | null;
}

export type PostflopStreet = "flop" | "turn" | "river";

export interface LinePlan {
  /** The two positions still in the hand, e.g. ["BB", "BTN"]. */
  seats: [string, string];
  /** Prefill shortcut scenario derived from the preflop raise count. */
  scenario: "SRP" | "3bet" | "4bet" | "5bet" | "limp";
  /** Street of the active (off-tree) decision. */
  offTreeStreet: PostflopStreet;
  /** True when the villain acts first postflop. */
  villainIsOOP: boolean;
  boards: { flop: string[]; turn?: string; river?: string };
  /** Bet/raise sizes (pct of pot) actually taken per street — fixed into the new tree so the line replays. */
  lineSizes: Partial<Record<PostflopStreet, number[]>>;
  /** Ordered taken-action labels per street, up to (not including) the active node. */
  replay: { street: PostflopStreet; labels: string[] }[];
  /** Pot (bb) at the active street, when GTO Wizard displays it. */
  potAtNode: number | null;
}

const isPostflop = (s: string): s is PostflopStreet =>
  s === "flop" || s === "turn" || s === "river";

export function buildLinePlan(line: LineState, villainPosition: string): LinePlan {
  const preflop = line.streets.find((s) => s.street === "preflop");
  if (!preflop) throw new Error("Line has no preflop street.");

  // participants: everyone whose preflop action wasn't a fold
  const seats = preflop.actions
    .filter((a) => a.taken && parseBetLabel(a.taken)?.kind !== "fold")
    .map((a) => a.position);
  const uniqueSeats = [...new Set(seats)];
  if (uniqueSeats.length !== 2) {
    throw new Error(
      `Tier-2 re-solve needs a heads-up pot, found ${uniqueSeats.length} players in (${uniqueSeats.join(", ") || "none"}).`
    );
  }
  if (!uniqueSeats.includes(villainPosition)) {
    throw new Error(`${villainPosition} isn't in the hand (players: ${uniqueSeats.join(", ")}).`);
  }

  const raises = preflop.actions.filter((a) => {
    const kind = a.taken ? parseBetLabel(a.taken)?.kind : undefined;
    return kind === "raise" || kind === "allin";
  }).length;
  const scenario =
    raises === 0 ? "limp" : (["SRP", "3bet", "4bet", "5bet"] as const)[Math.min(raises, 4) - 1];

  // boards from the dealt-card slots (exact cards incl. suits); the URL board
  // param is a fallback — it can lag behind line edits
  const isCard = (c: string) => /^[2-9TJQKA][hdcs]$/.test(c);
  let cards = line.streets
    .filter((s) => isPostflop(s.street))
    .flatMap((s) => s.cards)
    .filter(isCard);
  if (cards.length < 3) {
    cards =
      (line.board ?? "")
        .match(/[2-9TJQKA][hdcs]/gi)
        ?.map((c) => c[0].toUpperCase() + c[1].toLowerCase()) ?? [];
  }
  if (cards.length < 3) throw new Error("Tier-2 re-solve needs at least a flop on the board.");
  const boards: LinePlan["boards"] = { flop: cards.slice(0, 3) };
  if (cards[3]) boards.turn = cards[3];
  if (cards[4]) boards.river = cards[4];

  // walk postflop streets in order, collecting taken actions until the active node
  const lineSizes: LinePlan["lineSizes"] = {};
  const replay: LinePlan["replay"] = [];
  let offTreeStreet: PostflopStreet | null = null;
  let potAtNode: number | null = null;

  outer: for (const st of line.streets) {
    if (!isPostflop(st.street)) continue;
    const labels: string[] = [];
    const sizes: number[] = [];
    for (const a of st.actions) {
      if (a.active) {
        offTreeStreet = st.street;
        potAtNode = st.pot;
        replay.push({ street: st.street, labels });
        if (sizes.length) lineSizes[st.street] = [...new Set(sizes)];
        break outer;
      }
      if (!a.taken) continue;
      labels.push(a.taken);
      const parsed = parseBetLabel(a.taken);
      if (parsed?.pct != null && (parsed.kind === "bet" || parsed.kind === "raise")) {
        sizes.push(parsed.pct);
      }
    }
    if (offTreeStreet) break;
    replay.push({ street: st.street, labels });
    if (sizes.length) lineSizes[st.street] = [...new Set(sizes)];
  }
  if (!offTreeStreet) {
    throw new Error("Couldn't locate the active decision on a postflop street.");
  }

  if (offTreeStreet === "turn" && !boards.turn) {
    throw new Error("Villain is betting the turn but no turn card is dealt — deal it first.");
  }
  if (offTreeStreet === "river" && !boards.river) {
    throw new Error("Villain is betting the river but no river card is dealt — deal it first.");
  }

  // OOP = whoever acts first on the first postflop street
  const firstPostflop = line.streets.find((s) => isPostflop(s.street) && s.actions.length);
  const oopPosition = firstPostflop?.actions[0]?.position ?? null;

  return {
    seats: uniqueSeats as [string, string],
    scenario,
    offTreeStreet,
    villainIsOOP: oopPosition === villainPosition,
    boards,
    lineSizes,
    replay,
    potAtNode,
  };
}
