/**
 * collapseCoverage — how often can a real 4+ way postflop spot actually be collapsed to three seats?
 *
 * The stress run (scripts/stressSixMax.ts) found four-way spots the chain refuses outright: "no collapse to
 * three seats is legal". That is a structural limit, not a quota one — `planCollapses` returns [] when every
 * villain has chips in on a walked street (nothing is ghostable) and no adjacent villain pair commits at most
 * once per street (nothing is mergeable). The question that decides whether it matters is how often real
 * hands land there, and that is answerable for FREE: legality depends only on the seats and the tokens, never
 * on the ranges or the solver, so this replays hand histories through the real `planCollapses` with dummy
 * ranges and counts.
 *
 *   bun src/scripts/collapseCoverage.ts [--stake $1-$2] [--limit 0]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { planCollapses, pickCollapses, type CollapseSeat, type SeatTok } from "../services/multiwayCollapse";

const HH = "C:\\Users\\Brady\\Ignition Casino Poker\\Hand History";
const arg = (k: string, d?: string) => { const i = Bun.argv.indexOf(k); return i >= 0 ? Bun.argv[i + 1] : d; };
const STAKE = arg("--stake", "$1-$2")!;

/** Legality reads only `pos` and the tokens — a flat range keeps the plans honest and costs nothing. */
const DUMMY = new Array(1326).fill(1);

const VERB = /^(?<who>.+?)\s*:\s*(?<verb>Folds|Checks|Calls|Raises|Bets|All-in\(raise\)|All-in)\b(?<rest>.*)$/;
const SKIP = /Card dealt|Set dealer|Small blind|Big blind|Return uncalled|Hand result|Does not show|Showdown|Seat sit|Table enter|Table leave/i;

interface Step { who: string; tok: string }

/** One street's actions as collapse tokens: X check, F fold, C call, R<bb> bet/raise. */
function streetSteps(text: string, bb: number): Step[] {
  const out: Step[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || SKIP.test(line)) continue;
    const m = VERB.exec(line);
    if (!m?.groups) continue;
    const who = m.groups.who!.replace("[ME]", "").trim();
    const verb = m.groups.verb!;
    const rest = m.groups.rest ?? "";
    const to = /\$([\d.,]+)\s*$/.exec(rest.replace(/ to /, " to "))?.[1]?.replace(/,/g, "");
    const amt = to ? Number(to) / bb : 0;
    const tok =
      verb === "Folds" ? "F"
      : verb === "Checks" ? "X"
      : verb === "Calls" ? "C"
      : `R${Math.round(amt * 10) / 10}`;
    out.push({ who, tok });
  }
  return out;
}

function main() {
  const dirs = existsSync(HH) ? readdirSync(HH) : [];
  const files: string[] = [];
  for (const d of dirs) {
    const p = join(HH, d);
    try { for (const f of readdirSync(p)) if (f.includes(" RING ") && f.includes(STAKE) && f.endsWith(".txt")) files.push(join(p, f)); }
    catch { /* not a directory */ }
  }
  const bbM = /\$[\d.]+-\$([\d.]+)/.exec(STAKE);
  const bb = bbM ? Number(bbM[1]) : 2;
  console.log(`${files.length} ${STAKE} RING files · bb $${bb}\n`);

  let hands = 0, flops = 0, decisions = 0;
  const byField: Record<number, { decisions: number; none: number; blend: number; single: number }> = {};
  const byStreet: Record<string, { decisions: number; none: number }> = {};
  const examples: string[] = [];

  for (const path of files) {
    for (const chunk of readFileSync(path, "utf-8").split(/(?=^Ignition Hand #)/m)) {
      if (!chunk.startsWith("Ignition Hand #")) continue;
      const seats = [...chunk.matchAll(/^Seat \d+: (.+?)\s*(\[ME\])?\s*\(\$[\d.,]+ in chips\)/gm)]
        .map((m) => ({ pos: m[1]!.trim(), hero: !!m[2] }));
      if (seats.length < 5 || seats.length > 6) continue;
      const hero = seats.find((s) => s.hero)?.pos;
      if (!hero) continue;
      hands++;
      const holeSplit = chunk.split("*** HOLE CARDS ***");
      if (holeSplit.length < 2) continue;
      const afterHole = holeSplit[1]!;
      const flopSplit = afterHole.split(/^\*\*\* FLOP \*\*\*.*$/m);
      if (flopSplit.length < 2) continue;
      flops++;

      // who is still in at the flop
      const pre = streetSteps(flopSplit[0]!, bb);
      const dead = new Set(pre.filter((s) => s.tok === "F").map((s) => s.who));
      if (dead.has(hero)) continue;
      const live = seats.map((s) => s.pos).filter((p) => !dead.has(p));
      if (live.length < 4) continue;

      // postflop streets, in order
      const rest = flopSplit[1]!;
      const turnSplit = rest.split(/^\*\*\* TURN \*\*\*.*$/m);
      const riverSplit = (turnSplit[1] ?? "").split(/^\*\*\* RIVER \*\*\*.*$/m);
      const rawStreets = [
        turnSplit[0]!,
        riverSplit[0] ?? "",
        (riverSplit[1] ?? "").split(/^\*\*\* SUMMARY \*\*\*/m)[0] ?? "",
      ].filter((x) => x.trim().length);

      // postflop seat order: the order they act on the first street, then anyone who never acted
      const first = streetSteps(rawStreets[0] ?? "", bb);
      const order = [...new Set([...first.map((s) => s.who), ...live])].filter((p) => live.includes(p));

      const walked: SeatTok[][] = [];
      const out = new Set<string>();
      for (const raw of rawStreets) {
        const steps = streetSteps(raw, bb).filter((s) => !s.who.startsWith("***"));
        const street: SeatTok[] = [];
        for (const st of steps) {
          if (st.who === hero) {
            // hero is about to act: this is a decision the chain would have to answer
            const seatsNow: CollapseSeat[] = order.filter((p) => !out.has(p)).map((p) => ({ pos: p, range: DUMMY }));
            if (seatsNow.length >= 4 && seatsNow.some((s) => s.pos === hero)) {
              decisions++;
              const n = seatsNow.length;
              const b = (byField[n] ??= { decisions: 0, none: 0, blend: 0, single: 0 });
              b.decisions++;
              const sname = ["flop", "turn", "river"][walked.length] ?? "?";
              const bs = (byStreet[sname] ??= { decisions: 0, none: 0 });
              bs.decisions++;
              const plans = planCollapses(seatsNow, hero, [...walked, street]);
              const picked = pickCollapses(plans);
              if (!picked) {
                b.none++; bs.none++;
                if (examples.length < 6) {
                  examples.push(`${n}-way ${["flop", "turn", "river"][walked.length]} · hero ${hero} · ` +
                    [...walked, street].map((s) => s.map((t) => `${t.seat}:${t.tok}`).join(" ")).join(" | "));
                }
              } else if (picked.mode === "blend") b.blend++;
              else b.single++;
            }
          }
          street.push({ tok: st.tok, seat: st.who });
          if (st.tok === "F") out.add(st.who);
        }
        walked.push(street);
      }
    }
  }

  console.log(`${hands} hands (5-6 handed) · ${flops} saw a flop · ${decisions} hero decisions with 4+ live\n`);
  console.log("field   decisions   no legal collapse        blend      single");
  let dTot = 0, nTot = 0;
  for (const k of Object.keys(byField).map(Number).sort()) {
    const b = byField[k]!;
    dTot += b.decisions; nTot += b.none;
    console.log(`  ${k}-way ${String(b.decisions).padStart(8)}   ${String(b.none).padStart(6)} (${(100 * b.none / b.decisions).toFixed(1).padStart(5)}%)        ${String(b.blend).padStart(5)}      ${String(b.single).padStart(5)}`);
  }
  if (dTot) console.log(`\n  ALL    ${String(dTot).padStart(8)}   ${String(nTot).padStart(6)} (${(100 * nTot / dTot).toFixed(1)}%) of 4+ way hero decisions have NO legal collapse`);
  console.log("\nby street (a later street is harder: every earlier commitment blocks a ghost):");
  for (const k of ["flop", "turn", "river"]) {
    const b = byStreet[k];
    if (!b) { console.log(`  ${k.padEnd(6)}        0 decisions — the field had already thinned below 4`); continue; }
    console.log(`  ${k.padEnd(6)} ${String(b.decisions).padStart(8)} decisions · ${b.none} with no legal collapse`);
  }
  if (examples.length) {
    console.log("\nexamples of the refusal:");
    for (const e of examples) console.log(`  ${e}`);
  }
}

main();
