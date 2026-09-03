import { parsePanelFeed, type PanelRow } from "../feed/parsePanelFeed/parsePanelFeed";
import { fastSolve } from "../services/fastSolve";
// M2: hero BTN opens, SB folds, BB calls; flop Kc7d2h checks through; turn 2c; BB checks -> hero to act
const rows: PanelRow[] = [
  { k: "info", t: "New hand — you have A♥ Q♠" },
  { k: "act", t: "Seat 2 (SB) posts the small blind 0.5 BB" },
  { k: "act", t: "Seat 3 (BB) posts the big blind 1 BB" },
  { k: "hero", t: "You raise to 2.5 BB" },
  { k: "act", t: "Seat 2 (SB) folds" },
  { k: "act", t: "Seat 3 (BB) calls 1.5 BB" },
  { k: "street", t: "FLOP  K♣ 7♦ 2♥ — pot 5.5 BB" },
  { k: "act", t: "Seat 3 (BB) checks" },
  { k: "hero", t: "You check" },
  { k: "street", t: "TURN  K♣ 7♦ 2♥ 2♣ — pot 5.5 BB" },
  { k: "act", t: "Seat 3 (BB) checks" },
  { k: "turn", t: "YOUR TURN — pot 5.5 BB" },
];
const { hand, warnings } = parsePanelFeed(rows);
if (!hand) { console.log("NO HAND", warnings); process.exit(1); }
const res = await fastSolve(hand, "BTN", { strategy: "exploit" });
console.log(res.ok ? { source: res.source, street: res.street, tier: res.tier, tag: res.exploitTag, mesBoard: res.mesBoard, ev: res.mesEvGainBb,
  actions: res.actions.map((a) => `${a.action} ${a.frequency.toFixed(0)}%${a.ev != null ? ` (${a.ev}bb)` : ""}`).join("  "),
  decision: res.decision?.action, warning: res.warning } : res);
process.exit(0);
