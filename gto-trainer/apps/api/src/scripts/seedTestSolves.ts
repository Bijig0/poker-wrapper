/**
 * Insert two synthetic AI-chain traces (origin "test") so the dashboard's
 * walkthrough and compare views can be exercised without GTO Wizard.
 * Prints the ids. Remove them with:  bun run src/scripts/seedTestSolves.ts --clean
 */
import { Database } from "bun:sqlite";
import { solveStore } from "../services/solveStore";
import { COMBOS } from "../utils/comboIndex/comboIndex";

if (process.argv.includes("--clean")) {
  const db = new Database(solveStore.path);
  const r = db.query("DELETE FROM solves WHERE origin = 'test'").run();
  console.log(`deleted ${r.changes} test solves`);
  process.exit(0);
}

const board = "Kc7d2h";
const blocked = new Set(board.match(/.{2}/g)!);
const seeded = (seed: number) => { let x = seed; return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; };
const range = (seed: number, tight: number) => {
  const rnd = seeded(seed);
  return COMBOS.map((c) => (blocked.has(c.cards[0]) || blocked.has(c.cards[1]) ? 0 : rnd() < tight ? Math.round(rnd() * 100) / 100 : 0));
};
const heroIdx = COMBOS.findIndex((c) => c.hand === "9s2s") >= 0 ? COMBOS.findIndex((c) => c.hand === "9s2s") : 100;

function trace(variant: number) {
  const oop = range(1 + variant, 0.55), ip = range(7, 0.4);
  ip[heroIdx] = Math.max(ip[heroIdx]!, 0.5);
  const rnd = seeded(99 + variant);
  const strat = (n: number, arr: number[]) => {
    const out: number[][] = Array.from({ length: n }, () => new Array(1326).fill(0));
    for (let i = 0; i < 1326; i++) {
      if (arr[i]! <= 0) continue;
      const ws = Array.from({ length: n }, () => rnd());
      const s = ws.reduce((a, b) => a + b, 0);
      ws.forEach((w, k) => (out[k]![i] = Math.round((w / s) * 10000) / 10000));
    }
    return out;
  };
  const oopActs = ["Check", "Bet"]; const oopS = strat(2, oop);
  const oopAfter = oop.map((w, i) => w * oopS[0]![i]!);
  const ipActs = ["Check", "Bet", "Bet"]; const ipS = strat(3, ipAfter(ip));
  function ipAfter(x: number[]) { return x; }
  return {
    spec: { oopPos: "SB", ipPos: "BTN", oopRange: oop, ipRange: ip, flopPot: 5.5, flopStack: 97.5, board, streets: [["X"]], heroSeat: "ip", heroComboIdx: heroIdx },
    streets: [{ si: 0, street: "FLOP", board, potIn: 5.5, stackIn: 97.5, labels: ["Check"], fixedLevels: null, solId: variant ? "sol-b7c2d9e1" : "sol-a1b2c3d4", created: variant === 0, oopIn: oop, ipIn: ip }],
    nodes: [
      { si: 0, ti: 0, street: "FLOP", board, codes: [], actor: 0, potNode: 5.5, invested: [0, 0],
        actions: oopActs.map((name, k) => ({ name, code: String(k), betsize: k ? 1.8 : null, position: "SB", totalFrequency: k ? 0.39 : 0.61, totalEv: k ? 2.1 : 2.4, strategy: oopS[k], evs: oopS[k]!.map((x) => Math.round(x * 300) / 100) })),
        taken: 0, heroNode: false },
      { si: 0, ti: 1, street: "FLOP", board, codes: ["0"], actor: 1, potNode: 5.5, invested: [0, 0],
        actions: ipActs.map((name, k) => ({ name, code: String(k), betsize: k === 1 ? 1.8 : k === 2 ? 4.1 : null, position: "BTN", totalFrequency: [0.57, 0.31, 0.12][k], totalEv: [2.9, 3.1, 3.0][k], strategy: ipS[k], evs: ipS[k]!.map((x) => Math.round(x * 300) / 100) })),
        taken: null, heroNode: true },
    ],
    result: { ok: true, potNode: 5.5, stackStreet: 97.5, line: "F-R3-C / (flop node after 0)", solves: variant === 0 ? 1 : 0 },
  };
}

const ids = [0, 1].map((v) => solveStore.save({
  origin: "test", clientHandId: null, wrapperHandId: null, decisionKey: null, street: "flop", board, heroCards: "9s2s", heroPos: "BTN",
  tier: "ai-chain", line: "F-R3-C / (flop node after 0)", solves: v === 0 ? 1 : 0, solveMs: 3300 + v * 900, ok: true, why: null,
}, trace(v)));
console.log(JSON.stringify({ ids }));
