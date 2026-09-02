import { parsePanelFeed, type PanelRow } from "../feed/parsePanelFeed/parsePanelFeed";
import { fastSolve } from "../services/fastSolve";
const rows: PanelRow[] = [
  { k: "info", t: "New hand — you have A♥ Q♠" },
  { k: "hero", t: "You post the small blind 0.5 BB" },
  { k: "act", t: "Seat 3 (BB) posts the big blind 1 BB" },
  { k: "act", t: "Seat 1 (BTN) folds" },
  { k: "turn", t: "YOUR TURN — pot 1.5 BB — 0.5 BB to call" },
];
const { hand } = parsePanelFeed(rows);
const res = await fastSolve(hand!, "SB", {});
console.log(res.ok ? { source: res.source, tier: res.tier, decision: res.decision?.action, exploit: res.exploitDecision?.action, chart: res.chartDecision?.action, warning: res.warning } : res);
process.exit(0);
