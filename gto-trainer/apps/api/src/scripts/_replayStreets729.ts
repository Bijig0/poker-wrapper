/** Hand 729 flop root → turn root → river root in ONE process: does the depth pin make later streets reuse the flop trees? */
import { fastSolve } from "../services/fastSolve";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
const r = await fetch("http://127.0.0.1:2000/api/dashboard/hand/729").then((x) => x.json());
const cuts: [string, number, string[], number][] = [["flop", 7, ["6h", "4s", "3c"], 4], ["turn", 12, ["6h", "4s", "3c", "3d"], 9.07], ["river", 15, ["6h", "4s", "3c", "3d", "Qs"], 20.56]];
for (const [street, cut, board, pot] of cuts) {
  const raw = { ...r.hand, ended: false, street, board, currentNode: { street, toActSeatId: r.hand.heroSeatId, toActIsHero: true, pot, toCall: 0, legalActions: [], complete: false } };
  raw.actions = r.hand.actions.slice(0, cut);
  const hand = normalizeHand(raw).hand;
  const t0 = Date.now();
  const res = await fastSolve(hand, hand.positions[hand.heroSeatId] ?? null, { strategyId: "ign200-ring-6max-equilibrium", origin: "replay" });
  const wall = Date.now() - t0;
  const m = /(\d+) collapses/.exec(res.warning ?? "");
  console.log(`${street.padEnd(5)} wall ${String(wall).padStart(6)} ms | ok ${res.ok} | ${res.ok ? `${res.decision?.action.padEnd(9)} · ${res.actions.map((a) => `${a.action} ${Math.round(a.frequency * 10) / 10}`).join(" / ")}` : (res as any).reason.slice(0, 200)}`);
}
const s = await fetch("http://127.0.0.1:2000/api/dashboard/solves").then((x) => x.json());
const rows = (s.rows ?? s.solves ?? []).filter((x: any) => x.clientHandId === "4919957671" && x.origin === "replay");
console.log("replay solve records (id:street:solves:solveMs):", rows.slice(-9).map((x: any) => `${x.id}:${x.street}:${x.solves}:${x.solveMs}`).join("  "));
