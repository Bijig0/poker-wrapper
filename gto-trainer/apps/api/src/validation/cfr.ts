/**
 * Vanilla CFR trainer + exact best-response / exploitability.
 *
 * - `CFRSolver.train(n)` runs n iterations of counterfactual regret minimization
 *   over the full game tree and yields the average strategy (which converges to a
 *   Nash equilibrium in two-player zero-sum games).
 * - `exploitability(game, strategy)` computes the NashConv / 2: how much a perfect
 *   best-responder beats the strategy, averaged over both seats. THIS is the core
 *   validation primitive — the "opponent" is the best response you derive from the
 *   strategy itself, so no external bot is needed. Zero = unexploitable = optimal.
 */

import type { Game, Player, AveragedStrategy } from "./gameTree";

export class CFRSolver<S> {
  private regretSum = new Map<string, number[]>();
  private strategySum = new Map<string, number[]>();
  private actionsByInfoset = new Map<string, string[]>();

  constructor(private game: Game<S>) {}

  private getRegret(infoset: string, n: number): number[] {
    let r = this.regretSum.get(infoset);
    if (!r) {
      r = new Array(n).fill(0);
      this.regretSum.set(infoset, r);
    }
    return r;
  }

  private getStratSum(infoset: string, n: number): number[] {
    let s = this.strategySum.get(infoset);
    if (!s) {
      s = new Array(n).fill(0);
      this.strategySum.set(infoset, s);
    }
    return s;
  }

  /** Regret-matching: current strategy proportional to positive regret. */
  private regretMatch(infoset: string, actions: string[]): number[] {
    const n = actions.length;
    this.actionsByInfoset.set(infoset, actions);
    const r = this.getRegret(infoset, n);
    const pos = r.map((x) => (x > 0 ? x : 0));
    const sum = pos.reduce((a, b) => a + b, 0);
    if (sum > 0) return pos.map((x) => x / sum);
    return new Array(n).fill(1 / n);
  }

  train(iterations: number): void {
    for (let t = 0; t < iterations; t++) {
      this.cfr(this.game.root(), 1, 1, 1);
    }
  }

  /** Returns the value of the subtree to player 0. p0/p1 = player reaches, pc = chance reach. */
  private cfr(s: S, p0: number, p1: number, pc: number): number {
    const g = this.game;
    if (g.isTerminal(s)) return g.utility(s);
    if (g.isChance(s)) {
      let v = 0;
      for (const { prob, next } of g.chanceOutcomes(s)) {
        v += prob * this.cfr(next, p0, p1, pc * prob);
      }
      return v;
    }

    const i = g.currentPlayer(s);
    const infoset = g.infoSet(s);
    const actions = g.actions(s);
    const n = actions.length;
    const strat = this.regretMatch(infoset, actions);

    const utilA = new Array(n).fill(0);
    let nodeUtil = 0;
    for (let k = 0; k < n; k++) {
      const next = g.play(s, actions[k]);
      utilA[k] =
        i === 0
          ? this.cfr(next, p0 * strat[k], p1, pc)
          : this.cfr(next, p0, p1 * strat[k], pc);
      nodeUtil += strat[k] * utilA[k];
    }

    const cfReach = (i === 0 ? p1 : p0) * pc;
    const myReach = i === 0 ? p0 : p1;
    const sign = i === 0 ? 1 : -1; // utilities are in player-0 units
    const regret = this.getRegret(infoset, n);
    const stratSum = this.getStratSum(infoset, n);
    for (let k = 0; k < n; k++) {
      regret[k] += cfReach * sign * (utilA[k] - nodeUtil);
      stratSum[k] += myReach * strat[k];
    }
    return nodeUtil;
  }

  averageStrategy(): AveragedStrategy {
    const out: AveragedStrategy = new Map();
    for (const [infoset, sums] of this.strategySum) {
      const total = sums.reduce((a, b) => a + b, 0);
      const actions = this.actionsByInfoset.get(infoset)!;
      const probs =
        total > 0 ? sums.map((x) => x / total) : sums.map(() => 1 / sums.length);
      out.set(infoset, { actions, probs });
    }
    return out;
  }
}

/** Probability of `action` at `infoset` under a strategy (0 if unseen). */
export function actionProb(
  strategy: AveragedStrategy,
  infoset: string,
  action: string
): number {
  const s = strategy.get(infoset);
  if (!s) return 0;
  const i = s.actions.indexOf(action);
  return i >= 0 ? s.probs[i] : 0;
}

function stratProbs<S>(
  game: Game<S>,
  strategy: AveragedStrategy,
  infoset: string,
  actions: string[]
): number[] {
  const s = strategy.get(infoset);
  if (!s) return actions.map(() => 1 / actions.length);
  return actions.map((a) => {
    const idx = s.actions.indexOf(a);
    return idx >= 0 ? s.probs[idx] : 0;
  });
}

/**
 * Exact best-response value for `brPlayer` against a fixed strategy.
 * Respects information sets (the responder cannot see hidden cards): best actions
 * are chosen per infoset by aggregating counterfactual value across every history
 * in that infoset, resolving deeper infosets first.
 */
function bestResponseValue<S>(
  game: Game<S>,
  strategy: AveragedStrategy,
  brPlayer: Player
): number {
  interface Rec {
    s: S;
    cfReach: number;
  }
  const groups = new Map<string, Rec[]>();
  const depth = new Map<string, number>();

  // Gather brPlayer's decision nodes by infoset, with counterfactual reach
  // (chance * opponent probs — excludes brPlayer's own actions).
  const collect = (s: S, cfReach: number, d: number): void => {
    if (game.isTerminal(s)) return;
    if (game.isChance(s)) {
      for (const { prob, next } of game.chanceOutcomes(s)) {
        collect(next, cfReach * prob, d + 1);
      }
      return;
    }
    const i = game.currentPlayer(s);
    const actions = game.actions(s);
    const infoset = game.infoSet(s);
    if (i === brPlayer) {
      if (!groups.has(infoset)) {
        groups.set(infoset, []);
        depth.set(infoset, d);
      }
      groups.get(infoset)!.push({ s, cfReach });
      for (const a of actions) collect(game.play(s, a), cfReach, d + 1);
    } else {
      const probs = stratProbs(game, strategy, infoset, actions);
      actions.forEach((a, k) =>
        collect(game.play(s, a), cfReach * probs[k], d + 1)
      );
    }
  };
  collect(game.root(), 1, 0);

  const chosen = new Map<string, string>();
  const sign = brPlayer === 0 ? 1 : -1;

  // Value to player 0 of a node, using chosen BR actions where applicable.
  const evalNode = (s: S): number => {
    if (game.isTerminal(s)) return game.utility(s);
    if (game.isChance(s)) {
      let v = 0;
      for (const { prob, next } of game.chanceOutcomes(s)) v += prob * evalNode(next);
      return v;
    }
    const i = game.currentPlayer(s);
    const actions = game.actions(s);
    const infoset = game.infoSet(s);
    if (i === brPlayer) {
      const a = chosen.get(infoset) ?? actions[0];
      return evalNode(game.play(s, a));
    }
    const probs = stratProbs(game, strategy, infoset, actions);
    let v = 0;
    actions.forEach((a, k) => {
      v += probs[k] * evalNode(game.play(s, a));
    });
    return v;
  };

  // Decide infosets deepest-first so nested BR nodes are already fixed.
  const infosets = [...groups.keys()].sort(
    (a, b) => depth.get(b)! - depth.get(a)!
  );
  for (const infoset of infosets) {
    const recs = groups.get(infoset)!;
    const actions = game.actions(recs[0].s);
    let bestA = actions[0];
    let bestVal = -Infinity;
    for (const a of actions) {
      let val = 0;
      for (const { s, cfReach } of recs) {
        val += cfReach * sign * evalNode(game.play(s, a));
      }
      if (val > bestVal) {
        bestVal = val;
        bestA = a;
      }
    }
    chosen.set(infoset, bestA);
  }

  return sign * evalNode(game.root());
}

/** Value to player 0 when both players follow `strategy`. */
export function gameValue<S>(game: Game<S>, strategy: AveragedStrategy): number {
  const ev = (s: S): number => {
    if (game.isTerminal(s)) return game.utility(s);
    if (game.isChance(s)) {
      let v = 0;
      for (const { prob, next } of game.chanceOutcomes(s)) v += prob * ev(next);
      return v;
    }
    const actions = game.actions(s);
    const probs = stratProbs(game, strategy, game.infoSet(s), actions);
    let v = 0;
    actions.forEach((a, k) => {
      v += probs[k] * ev(game.play(s, a));
    });
    return v;
  };
  return ev(game.root());
}

/**
 * Exploitability (NashConv / 2): the average amount a perfect best-responder
 * beats `strategy` across both seats. 0 = unexploitable = an exact equilibrium.
 * Units match the game's utility (here, chips).
 */
export function exploitability<S>(
  game: Game<S>,
  strategy: AveragedStrategy
): number {
  const br0 = bestResponseValue(game, strategy, 0);
  const br1 = bestResponseValue(game, strategy, 1);
  return (br0 + br1) / 2;
}
