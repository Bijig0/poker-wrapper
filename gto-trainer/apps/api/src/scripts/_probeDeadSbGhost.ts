/**
 * Probe for hand 4921843568 (session_20261001_130914, table 2, 13:27 local): 5 dealt, the SB seat empty. Hero (CO)
 * opens, the BTN cold-calls, and the flop gets no answer — "token C is not an action at 'F-F-R2.6'".
 * Measured over the solve cache: a non-blind seat facing one open is offered a call in 49 of 49 live-SB trees and 0
 * of 6 dead-SB trees. Hypothesis: the dead-SB ghost (blind = stack = 0.01, all-in for a penny) always "reaches the
 * flop", so it takes one of the three flop seats GTO Wizard AI allows and the engine drops every cold-call but the
 * BB's. This asks the same node of the same table under other ways of writing the empty seat.
 *
 *   POKER_DATA_DIR=C:\Users\Brady\poker-data bun run src/scripts/_probeDeadSbGhost.ts [variant ...]
 */
import { Database } from "bun:sqlite";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt, roundContributions } from "../utils/archivedHand/archivedHand";
import { debugCreateTree, debugPreflopNode, debugTree } from "../services/gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const db = new Database("C:\\Users\\Brady\\poker-data\\poker.sqlite", { readonly: true });
const row = db.query("select data from hands where client_hand_id = '4921843568'").get() as any;
const hand = normalizeHand(JSON.parse(row.data)).hand;
const upto = hand.actions.findIndex((a) => a.hero && a.street === "preflop" && a.type === "raise");
const cut = truncateAt(hand, upto);
const t: ParsedHand = {
  ...cut, street: "preflop", board: [],
  committed: Object.fromEntries(roundContributions(hand, upto).get("preflop") ?? []),
  currentNode: { ...cut.currentNode, street: "preflop", pot: 0, toActIsHero: true, toActSeatId: hand.heroSeatId },
};

const dt = debugTree(t, null);
if ("error" in dt) throw new Error(dt.error);
console.log("shape", dt.shape.positions.map((p) => `${p}:${dt.shape.stacks[p]}`).join(" "), "· sb", dt.shape.sb, "· deadSb", dt.shape.deadSb, "· line", JSON.stringify(dt.line));

const base = dt.body;
const players = (sb: Record<string, unknown>) => base.players.map((p: any) => (p.position === "SB" ? { ...p, ...sb } : p));
const sizes = (sb: Record<string, unknown>) => ({
  ...base.bet_sizes,
  street_bet_sizes: base.bet_sizes.street_bet_sizes.map((st: any) => ({
    ...st, position_bet_sizes: st.position_bet_sizes.map((x: any) => (x.position === "SB" ? { ...x, ...sb } : x)),
  })),
});
const MUTE = { allow_limp: false, allow_call_opens: false, allow_3betplus_cold_calls: false };
const NO_SIZES = { bet_sizes: [], raise_sizes: [], second_raise_sizes: [], third_plus_raise_sizes: [] };

const VARIANTS: Record<string, { what: string; patch?: Record<string, unknown> }> = {
  base: { what: "the ghost as shipped: SB blind 0.01, stack 0.01 (all-in)" },
  muteAllin: { what: "the same all-in ghost, its calls switched off", patch: { bet_sizes: sizes(MUTE) } },
  live100mute: { what: "SB blind 0.01, stack 100, no limp / no calls, its raise sizes kept",
                 patch: { players: players({ blind: 0.01, stack: 100 }), bet_sizes: sizes(MUTE) } },
  live100foldOnly: { what: "SB blind 0.01, stack 100, no limp / no calls, NO raise sizes (fold only?)",
                     patch: { players: players({ blind: 0.01, stack: 100 }), bet_sizes: sizes({ ...MUTE, ...NO_SIZES }) } },
  short2mute: { what: "SB blind 0.01, stack 0.02 (one penny behind), no limp / no calls",
                patch: { players: players({ blind: 0.01, stack: 0.02 }), bet_sizes: sizes({ ...MUTE, ...NO_SIZES }) } },
  emptyRange: { what: "SB blind 0.01, stack 100, an all-zero starting range",
                patch: { players: players({ blind: 0.01, stack: 100, range: new Array(1326).fill(0) }), bet_sizes: sizes(MUTE) } },
};

const LINES = ["F-F-R2.5", "F-F-R2.5-C", "F-F-R2.5-C-F", "F-F-R2.5-F", "F-F-F-F"];
const want = process.argv.slice(2);
for (const [name, v] of Object.entries(VARIANTS)) {
  if (want.length && !want.includes(name)) continue;
  console.log(`\n== ${name}: ${v.what}`);
  for (const line of LINES) {
    const r = await debugPreflopNode(t, null, line, v.patch);
    if (!r.ok) {
      console.log(`   ${line.padEnd(14)} -> ${r.reason.slice(0, 260)}`);
      // a tree the API refuses outright says why only at creation: ask once, then stop this variant
      if (line === LINES[0] && /custom-trees|custom-solutions|VALIDATION|Invalid/i.test(r.reason)) {
        const made = await debugCreateTree(t, null, v.patch);
        console.log("   create:", made.status ?? "", JSON.stringify(made.got ?? made.error).slice(0, 400));
        break;
      }
      if (line === LINES[0]) break;
      continue;
    }
    console.log(`   ${line.padEnd(14)} -> ${String(r.actor).padEnd(3)} ${r.actions.map((a) => `${a.code} ${a.freq == null ? "?" : (100 * a.freq).toFixed(1)}`).join(" · ")}`);
  }
}
process.exit(0);
