/**
 * Repro for hand 4921657513 (session_20260930_150739, table 2, 16:15 local): HJ opens 2.6, the CO shoves his 12.2bb
 * stack, hero (BTN, KcJd) gets no answer — GTO Wizard answered 400 VALIDATION_ERROR on 'R2.6-R12.2'.
 * Hypothesis: shapeOf rounds every stack to the nearest 0.5bb (round5), so the tree gave the CO 12bb and the line
 * says he raised to 12.2 — more than his tree stack, an illegal sequence. Probes the same tree with the same line,
 * the line at the tree's own all-in size, and a tree built with the exact 12.2 stack.
 *
 *   POKER_DATA_DIR=C:\Users\Brady\poker-data bun run src/scripts/_probeAllinStackRound.ts
 */
import { Database } from "bun:sqlite";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt, roundContributions } from "../utils/archivedHand/archivedHand";
import { debugTree, debugPreflopNode } from "../services/gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const db = new Database("C:\\Users\\Brady\\poker-data\\poker.sqlite", { readonly: true });
const row = db.query("select data from hands where rowid = 1973").get() as any;
const raw = JSON.parse(row.data);
const hand = normalizeHand(raw).hand;
const upto = hand.actions.findIndex((a) => a.hero && a.street === "preflop" && a.type === "fold");
const cut = truncateAt(hand, upto);
const t: ParsedHand = {
  ...cut, street: "preflop", board: [],
  committed: Object.fromEntries(roundContributions(hand, upto).get("preflop") ?? []),
  currentNode: { ...cut.currentNode, street: "preflop", pot: 0, toActIsHero: true, toActSeatId: hand.heroSeatId },
};
// what the live wrapper exported at 16:15:16 (recording log.jsonl): seat 6 read "0 BB" with 12.2 in front
const live: ParsedHand = { ...t, stacks: { 1: 30, 2: 153.8, 3: 87.4, 4: 98.4, 5: 223.4, 6: 0 }, committed: { 3: 0.4, 4: 1, 5: 2.6, 6: 12.2 } };

const dt = debugTree(live, null);
if ("error" in dt) throw new Error(dt.error);
console.log("shape.stacks", dt.shape.stacks, "line", dt.line, "apiOf", dt.shape.apiOf);
console.log("tree players", dt.body.players.map((p: any) => `${p.position}:${p.stack}`).join(" "));

const show = (label: string, r: any) => console.log(`\n== ${label}\n`, JSON.stringify(r, null, 1).slice(0, 1500));

show("A. same tree (CO 12), line R2.6-R12.2 (what the live API asked)", await debugPreflopNode(live, null, "R2.6-R12.2"));
show("B. same tree, line R2.6 (what the CO is offered)", await debugPreflopNode(live, null, "R2.6"));
show("C. same tree, line R2.6-R12 (the tree's own all-in)", await debugPreflopNode(live, null, "R2.6-R12"));
const exact = { players: dt.body.players.map((p: any) => (p.position === "CO" ? { ...p, stack: 12.2 } : p)) };
show("D. tree with CO 12.2 exactly, line R2.6-R12.2", await debugPreflopNode(live, null, "R2.6-R12.2", exact));
process.exit(0);
