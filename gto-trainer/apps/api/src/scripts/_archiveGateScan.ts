// scratch: every archived Ignition hand's hero decisions through the capture gate (read-only); prints the
// "acts on the … round it never matched" faults for a seat that FOLDED later (round 2's rule-2 change), to judge them
import { Database } from "bun:sqlite";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt } from "../utils/archivedHand/archivedHand";
import { lostActionFaults } from "../utils/repairPostflopRotation/repairPostflopRotation";
const db = new Database("C:/Users/Brady/poker/ignition-study-wrapper/data/hands.db", { readonly: true });
let hands = 0, decisions = 0, hit = 0;
const seen = new Set<string>();
for (const r of db.query<{ rowid: number; data: string }, []>("SELECT rowid, data FROM hands").all()) {
  const d = JSON.parse(r.data);
  if ((d.site ?? "ignition") !== "ignition") continue;
  let h; try { h = normalizeHand(d).hand!; } catch { continue; }
  hands++;
  h.actions.forEach((a, i) => {
    if (!a.hero || a.type === "post-sb" || a.type === "post-bb") return;
    decisions++;
    const t = truncateAt(h, i);
    const folded = new Set(t.actions.filter((x) => x.type === "fold").map((x) => (x.hero ? t.heroSeatId : x.seatId)));
    for (const f of lostActionFaults(t)) {
      if (!/acts on the/.test(f)) continue;
      const pos = f.split(" ")[0]!;
      const seat = Object.entries(t.positions).find(([, p]) => p.toUpperCase() === pos)?.[0];
      if (!seat || !folded.has(Number(seat))) continue;
      hit++;
      const key = `${d.clientHandId}`;
      if (!seen.has(key)) { seen.add(key); console.log(`${d.clientHandId} rowid ${r.rowid} k=${i}: ${f.slice(0, 160)}`); }
    }
  });
}
console.log(`${hands} hands, ${decisions} hero decisions; ${hit} decision(s) newly flagged in ${seen.size} hand(s)`);
