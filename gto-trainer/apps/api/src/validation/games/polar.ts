/**
 * Polar clairvoyance game — the canonical closed-form bet/bluff spot.
 *
 * Dead pot = 1 (each seat contributed 0.5). Player 0 (the bettor) is dealt the
 * NUTS or AIR 50/50; player 1 (the caller) always holds a pure bluff-catcher that
 * beats air and loses to the nuts. Player 0 may check (→ showdown) or bet `bet`
 * chips; player 1 then folds or calls. Utilities are net stack change to player 0.
 *
 * Closed-form equilibrium (with bet as a fraction of the pot, pot = 1):
 *   - nuts always bet
 *   - air bluffs with frequency   bet / (1 + bet)
 *   - caller calls with frequency  1 / (1 + bet)   (folds the MDF: bet/(1+bet))
 */

import type { Game, Player } from "../gameTree";

interface PolarState {
  hand: "N" | "A" | null;
  history: string; // "" -> bettor; "b" -> caller; "x"/"bf"/"bc" terminal
}

export function polarGame(bet: number): Game<PolarState> {
  return {
    root: () => ({ hand: null, history: "" }),

    isChance: (s) => s.hand === null,

    chanceOutcomes: () => [
      { prob: 0.5, next: { hand: "N", history: "" } },
      { prob: 0.5, next: { hand: "A", history: "" } },
    ],

    isTerminal: (s) =>
      s.history === "x" || s.history === "bf" || s.history === "bc",

    utility: (s) => {
      switch (s.history) {
        case "x": // check, showdown
          return s.hand === "N" ? 0.5 : -0.5;
        case "bf": // bet, caller folds
          return 0.5;
        case "bc": // bet, caller calls
          return s.hand === "N" ? 0.5 + bet : -(0.5 + bet);
        default:
          return 0;
      }
    },

    currentPlayer: (s) => (s.history === "" ? 0 : 1) as Player,

    // The caller has ONE infoset facing a bet — it cannot tell nuts from bluff.
    infoSet: (s) => (s.history === "" ? s.hand + "|" : "caller|b"),

    actions: (s) => (s.history === "" ? ["check", "bet"] : ["fold", "call"]),

    play: (s, a) => {
      if (s.history === "")
        return { hand: s.hand, history: a === "check" ? "x" : "b" };
      return { hand: s.hand, history: a === "fold" ? "bf" : "bc" };
    },
  };
}
