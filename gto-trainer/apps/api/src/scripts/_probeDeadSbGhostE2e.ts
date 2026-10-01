/**
 * After the fold-only ghost (gtowAiPreflop.ts, 2026-10-01): hand 4921843568 through the code the live API runs —
 * hero's preflop answer on the new tree, then the flop-entering ranges after the BTN's cold-call.
 *
 *   POKER_DATA_DIR=C:\Users\Brady\poker-data bun run src/scripts/_probeDeadSbGhostE2e.ts
 */
import { Database } from "bun:sqlite";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt, roundContributions } from "../utils/archivedHand/archivedHand";
import { arrivalRangesGtowAi, dealtFromTreeId, debugPreflopNode, lineOf, shapeOf } from "../services/gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const db = new Database("C:/Users/Brady/poker-data/poker.sqlite", { readonly: true });
const row = db.query("select data from hands where client_hand_id = '4921843568'").get() as any;
const hand = normalizeHand(JSON.parse(row.data)).hand;
const TREE = "gtow-ai · 6-handed · UTG:119/HJ:52.5/CO:104/BTN:93/SB:0.01/BB:58.5";
const dealt = dealtFromTreeId(hand, null, TREE) ?? undefined;
console.log("dealt from the logged tree:", JSON.stringify(dealt));

const upto = hand.actions.findIndex((a) => a.hero && a.street === "preflop" && a.type === "raise");
const cut = truncateAt(hand, upto);
const pre: ParsedHand = {
  ...cut, street: "preflop", board: [],
  committed: Object.fromEntries(roundContributions(hand, upto).get("preflop") ?? []),
  currentNode: { ...cut.currentNode, street: "preflop", pot: 0, toActIsHero: true, toActSeatId: hand.heroSeatId },
};
const show = (label: string, r: any) => console.log(label.padEnd(26), r.ok ? `${r.actor}  ${r.actions.map((a: any) => `${a.code} ${(100 * a.freq).toFixed(1)}`).join(" · ")}` : r.reason);
show("hero's node  F-F", await debugPreflopNode(pre, null, "F-F"));
show("BTN vs the open F-F-R2.5", await debugPreflopNode(pre, null, "F-F-R2.5"));

const shape = shapeOf(hand, null, 0, undefined, dealt);
if ("error" in shape) throw new Error(shape.error);
console.log("flop line:", lineOf(hand, shape).tokens.join("-"));
const t0 = Date.now();
const r = await arrivalRangesGtowAi(hand, null, 6, dealt);
console.log(`arrival ranges: ${r.ok ? "ok" : "REFUSED — " + r.reason} (${Date.now() - t0} ms)`);
if (r.ok) {
  for (const [pos, rec] of Object.entries(r.ranges)) {
    const classes = Object.entries(rec as Record<string, number>);
    const combos = classes.reduce((s, [c, w]) => s + w * (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12), 0);
    const top = classes.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, w]) => `${c} ${w.toFixed(2)}`).join(", ");
    console.log(`  ${pos.padEnd(4)} ${classes.length} classes · ${combos.toFixed(0)} combos (${(100 * combos / 1326).toFixed(1)}%) · A9o ${((rec as any).A9o ?? 0).toFixed(2)} · top: ${top}`);
  }
  console.log("  id:", r.id, "\n  note:", r.note);
}
process.exit(0);
