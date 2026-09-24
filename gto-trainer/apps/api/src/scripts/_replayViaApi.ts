/** Replay a hands.db hand (dbId) up to action index N through the RUNNING API's /api/fast-solver (the API owns the GTOW token). */
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
const id = Bun.argv[2]!, n = Number(Bun.argv[3]);
const r = await fetch(`http://127.0.0.1:2000/api/dashboard/hand/${id}`).then((x) => x.json());
const raw = { ...r.hand, ended: false, currentNode: { ...r.hand.currentNode, toActSeatId: r.hand.heroSeatId, toActIsHero: true, complete: false } };
raw.actions = raw.actions.slice(0, n);
const hand = normalizeHand(raw).hand;
const t0 = Date.now();
const body = await fetch("http://127.0.0.1:2000/api/fast-solver", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ hand, heroPos: hand.positions[hand.heroSeatId], strategyId: "ign200-ring-6max-equilibrium", origin: "adhoc" }) }).then((x) => x.json()) as any;
const s = body.solution ?? {};
console.log(`${id}@${n} ${Date.now() - t0}ms ok=${s.ok} tier=${s.tier ?? ""} line=${s.line ?? ""} pick=${s.decision?.action ?? ""} ${s.ok ? "" : "REASON " + s.reason}`);
if (s.warning) console.log("   warning:", String(s.warning).slice(0, 300));
