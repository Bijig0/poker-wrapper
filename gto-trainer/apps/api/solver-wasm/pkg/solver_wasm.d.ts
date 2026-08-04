/* tslint:disable */
/* eslint-disable */

/**
 * Solve the FULL flop (turn/river undealt) from real preflop ranges, then walk
 * a fixed line — flop check→bet→CALL, turn check→check, river — reading hero's
 * range out of the solver at the start of each street. Proves the turn/river
 * ranges are DERIVED by the solve, not supplied as input.
 */
export function derive_ranges(flop: string, turn: string, river: string, oop_range: string, ip_range: string, pot: number, stack: number, bet_sizes: string, raise_sizes: string, max_iter: number, target_pct: number): string;

export function solve_river(board: string, oop_range: string, ip_range: string, pot: number, stack: number, bet_pct: number): string;

/**
 * Solve a heads-up postflop spot from the start of `initial_street` and return
 * the GTO strategy at hero's first decision node on that street.
 *
 * `hero_pos`: "oop" (acts first -> root strategy) or "ip" (after OOP checks).
 * `bet_sizes`/`raise_sizes`: postflop-solver size strings, applied to every
 * street for both players (e.g. "33%, 75%, a" and "60%").
 */
export function solve_spot(initial_street: string, board: string, oop_range: string, ip_range: string, pot: number, stack: number, bet_sizes: string, raise_sizes: string, hero_pos: string, max_iter: number, target_pct: number): string;
