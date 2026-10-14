import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import type { PathReason } from "./chainPath";

/**
 * WHERE A SEAT'S STACK CAME FROM (2026-10-14, the answer-path audit's finding 1).
 *
 * A preflop answer is built from each seat's stack AS DEALT. The wrapper's `startStacks` is the table's own figure:
 * the seat's first frame this hand ("frame", exact) or, since 2026-10-14, the figure carried from the table's last
 * word on the seat before the deal ("result" / "buy" / "seat", exact in 10,976 of 10,976 seat-hands against
 * Ignition's records). A seat `startStacks` does NOT cover has only the screen's reading — which still shows the
 * previous hand's END stack while a top-up or a reload is landing (4923624883: the HJ read 77.4bb, dealt 149.2 → the
 * D75 chart instead of D150; 4923399415: the BTN read 50.4 after a reload to 166.8) — or nothing at all, and the
 * pieces then assume 100bb (4924193800: the BTN built at 100, dealt 105.2). Until this both went unsaid: the chart
 * picker noted only the 100bb case, the GTO Wizard AI piece neither.
 *
 * Both pieces now SAY SO on the answer: a 'STACK NOT CONFIRMED:' note naming each such seat that entered the pick and
 * the path reason preflop:stack-not-confirmed (verdict failed — the tree or the rung may be another table's). Nothing
 * else changes: the stack used is what it was. With the wrapper's full coverage this is now rare — the first hand on a
 * socket, a seat the table's result had at 0 that was dealt without posting — where before it was every seat behind
 * hero at an HJ / CO / BTN first-in.
 */

export type StackHow = "frame" | "carried" | "screen" | "default";

/** A seat whose stack the answer used but the table did not confirm for this hand. */
export interface UnconfirmedStack {
  /** the seat's position as the piece names it */
  pos: string;
  seat: number;
  /** the figure that was used (bb); null when nothing was readable and the default stood in */
  bb: number | null;
  how: "screen" | "default";
}

export const STACK_NOT_CONFIRMED_TAG = "STACK NOT CONFIRMED:";
export const STACK_NOT_CONFIRMED_CODE = "preflop:stack-not-confirmed";

/** How the hand knows `seat`'s stack as dealt. */
export function stackHow(hand: Pick<ParsedHand, "startStacks" | "startStacksSource" | "stacks">, seat: number): StackHow {
  if (hand.startStacks?.[seat] != null) return hand.startStacksSource?.[seat] === "frame" || hand.startStacksSource == null ? "frame" : "carried";
  return hand.stacks?.[seat] != null ? "screen" : "default";
}

/** The seats of `used` (position → seat) the table did not confirm, with the figure the piece used for each. */
export function unconfirmedStacks(hand: Pick<ParsedHand, "startStacks" | "startStacksSource" | "stacks">, used: { pos: string; seat: number; bb: number | null }[]): UnconfirmedStack[] {
  const out: UnconfirmedStack[] = [];
  for (const u of used) {
    const how = stackHow(hand, u.seat);
    if (how === "screen" || how === "default") out.push({ pos: u.pos, seat: u.seat, bb: u.bb, how });
  }
  return out;
}

const word = (u: UnconfirmedStack) =>
  u.how === "default" ? `${u.pos} unreadable, taken as ${u.bb ?? 100}bb` : `${u.pos} ${u.bb}bb off the screen`;

/** The answer's note: 'STACK NOT CONFIRMED: HJ 77.4bb off the screen, BTN unreadable, taken as 100bb — …'. */
export function stackNotConfirmedNote(list: UnconfirmedStack[]): string | null {
  if (!list.length) return null;
  return `STACK NOT CONFIRMED: ${list.map(word).join(", ")} — the table has not reported ${list.length === 1 ? "this seat's" : "these seats'"} stack this hand (no frame of its own, nothing carried from the hand before), so it may be the previous hand's end stack, before a top-up or a reload`;
}

/** The path reason beside the piece's own (chainPath.preflopAlso): a failed check, the rung or the tree may be off. */
export function stackNotConfirmedReason(list: UnconfirmedStack[]): PathReason | null {
  if (!list.length) return null;
  return { v: "failed", code: STACK_NOT_CONFIRMED_CODE, text: `${STACK_NOT_CONFIRMED_TAG} ${list.map(word).join(", ")} — not the table's own figure for this hand`.slice(0, 300) };
}
