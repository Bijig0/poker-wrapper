/**
 * Kuhn poker — the smallest non-trivial poker game with a PUBLISHED equilibrium.
 *
 * 3 cards (J<Q<K), each player antes 1 and is dealt one card. Player 0 acts first:
 * pass ("p") or bet 1 ("b"). Actions use "p" (pass/check/fold) and "b" (bet/call).
 * Known results (external ground truth):
 *   - game value to player 0 = -1/18
 *   - player 0 never bets Q first
 *   - player 1 bluffs J after a check with freq 1/3, calls Q vs a bet with freq 1/3
 *   - player 0 bets K three times as often as J (the "alpha" family relationship)
 */

import type { Game, Player } from "../gameTree";

interface KuhnState {
  deal: [number, number] | null; // [player0 card, player1 card], 0=J 1=Q 2=K
  history: string;
}

const CARDS = ["J", "Q", "K"];
const TERMINALS = new Set(["pp", "bp", "pbp", "pbb", "bb"]);

export const kuhn: Game<KuhnState> = {
  root: () => ({ deal: null, history: "" }),

  isChance: (s) => s.deal === null,

  chanceOutcomes: () => {
    const outs: { prob: number; next: KuhnState }[] = [];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        if (a !== b) outs.push({ prob: 1 / 6, next: { deal: [a, b], history: "" } });
      }
    }
    return outs;
  },

  isTerminal: (s) => s.deal !== null && TERMINALS.has(s.history),

  utility: (s) => {
    const [c0, c1] = s.deal!;
    const p0win = c0 > c1;
    switch (s.history) {
      case "pp":
        return p0win ? 1 : -1;
      case "bp":
        return 1; // player 1 folded to a bet
      case "pbp":
        return -1; // player 0 folded to a bet
      case "bb":
      case "pbb":
        return p0win ? 2 : -2; // showdown for the doubled pot
      default:
        return 0;
    }
  },

  currentPlayer: (s) => (s.history.length % 2) as Player,

  infoSet: (s) => {
    const p = s.history.length % 2;
    return CARDS[s.deal![p]] + "|" + s.history;
  },

  actions: () => ["p", "b"],

  play: (s, a) => ({ deal: s.deal, history: s.history + a }),
};
