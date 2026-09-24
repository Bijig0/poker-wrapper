/** The SB facing two limps (F-F-C-C) — and one limp (F-F-F-C) — across every even limp chart: are the premium mixes stable? */
import { fetchNode } from "../services/hrc3max";
const HANDS = ["AA", "KK", "QQ", "JJ", "TT", "AKs", "AKo", "AQs", "A5s", "KQo", "T9s"];
const show = (n: any, h: string) => { const c = (n.cells ?? []).find((x: any) => x.hand === h); if (!c) return "-"; return Object.entries(c.actions ?? {}).filter(([, v]) => (v as number) >= 0.5).map(([k, v]) => `${k.replace("Raise ", "R")} ${Math.round(v as number)}`).join(" / "); };
for (const line of ["F-F-C-C", "F-F-F-C"]) {
  console.log(`\n##### line ${line} (SB to act)`);
  for (const d of [30, 50, 75, 100, 125, 150]) {
    const id = `ign200_6max_D${d}_olimp`;
    const t0 = Date.now();
    const n = await fetchNode(id, line);
    const ms = Date.now() - t0;
    if (!n || n === "unreachable") { console.log(`${id}: ${String(n)} (${ms} ms)`); continue; }
    console.log(`${id}: pos ${(n as any).pos} menu [${(n as any).actions?.map((a: any) => a.token).join(" ")}] (${ms} ms)`);
    for (const h of HANDS) console.log(`   ${h.padEnd(4)} ${show(n, h)}`);
  }
}
