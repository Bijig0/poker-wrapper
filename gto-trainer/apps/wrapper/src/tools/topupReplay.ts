/**
 * THE TOP-UP NEED OVER THE SOCKET DUMPS (2026-10-04) — topupReplayCore.ts replayed from the command line.
 *
 *   bun run src/tools/topupReplay.ts --session <id> [--dump <ws_dump.jsonl>] [--rid <socket>]
 *       one session, one table: the presses and screen receipts the session filed (its `top-up` / `top-up-receipt`
 *       events, matched to this dump's hands), replayed through tapFrame — per hand: the need at the deal, the first
 *       window, whether the new rule lets a press go there and whether the old 180 s lockout blocked it.
 *   bun run src/tools/topupReplay.ts --all [--dir <wrapper-debug>]
 *       every ws_dump*.jsonl(.1): presses taken from the dumps' own Buy-chips panels; per hand hero was dealt: short at
 *       the deal (the need), a press seen in that hand or the next (BEFORE: what the wrapper did), the new rule letting a
 *       press go at the hand's first window (AFTER), and what blocked it when it did not.
 *
 * SANDBOXED like replayWsDecisions.ts: the reader archives finished hands and appends to the ws dump, so data/ and
 * debug/ point at a throwaway directory before anything is imported. The sessions DB is opened read-only.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "topup-replay-"));
process.env.WRAPPER_DATA_DIR = join(sandbox, "data");
process.env.WRAPPER_DEBUG_DIR = join(sandbox, "debug");
mkdirSync(process.env.WRAPPER_DATA_DIR, { recursive: true });

const { Database } = await import("bun:sqlite");
const { dumpEntries, replayTopUp } = await import("./topupReplayCore");
const { realTime } = await import("../clock");
const { resetState } = await import("../state");

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const DATA = process.env.POKER_DATA_ROOT || "C:/Users/Brady/poker-data";
const DEBUG = arg("--dir") || join(DATA, "wrapper-debug");
const t = (s: number | null | undefined) => (s ? new Date(s * 1000).toTimeString().slice(0, 8) : "--:--:--");

function sessionEvents(id: string): { started: number; ended: number | null; events: any[] } {
  const db = new Database(join(DATA, "poker.sqlite"), { readonly: true });
  try {
    const r: any = db.query("select started_at, ended_at, events from sessions where id = ?").get(id);
    if (!r) throw new Error(`no session ${id}`);
    return { started: r.started_at, ended: r.ended_at, events: JSON.parse(r.events || "[]") };
  } finally {
    db.close();
  }
}

if (args.includes("--session")) {
  const id = arg("--session")!;
  const s = sessionEvents(id);
  const text = readFileSync(arg("--dump") || join(DEBUG, "ws_dump.jsonl"), "utf8");
  const entries = dumpEntries(text, { from: s.started / 1000, to: s.ended ? s.ended / 1000 + 60 : undefined, rid: arg("--rid") });
  const keys = new Set(entries.filter((e) => e.pid === "PLAY_STAGE_INFO").map((e) => String(e.data?.stageNo)));
  const presses = s.events.filter((e) => e.kind === "top-up" && e.pressed && keys.has(String(e.handKey)))
    .map((e) => ({ atMs: e.payload_at ?? e.at, amountCents: e.amountCents, beforeCents: e.beforeCents ?? null, handKey: e.handKey, trigger: e.trigger ?? null }));
  const oldReceiptsMs = s.events.filter((e) => e.kind === "top-up-receipt").map((e) => e.payload_at ?? e.at);
  const { hands } = replayTopUp(entries, { viaTap: true, presses, oldReceiptsMs });
  realTime();
  resetState();
  console.log(`session ${id}: ${entries.length} frames, ${hands.length} hands, ${presses.length} presses of this table`);
  console.log("hand        deal     stack  src                      need  short  pending   | window              new: press / blocked by                      | old rule");
  let shortDeals = 0, newAllowed = 0, oldBlockedN = 0, unlocked = 0;
  for (const h of hands) {
    const d = h.deal, w = h.window;
    if (d?.need) shortDeals++;
    if (w?.need && w.pressAllowed) newAllowed++;
    if (w?.need && w.oldBlocked) oldBlockedN++;
    if (w?.need && w.pressAllowed && w.oldBlocked) unlocked++;
    console.log([
      h.handKey.padEnd(11), t(h.dealAt), String(d?.stackCents ?? "-").padStart(6), String(d?.stackSource ?? "-").padEnd(24),
      String(d ? (d.need ? "NEED" : "no") : "-").padEnd(5), String(d?.shortBb ?? "-").padStart(5), String(d?.pendingVerdict ?? "-").padEnd(8), "|",
      w ? `${t(w.at)} ${w.trigger.padEnd(9)}` : "-".padEnd(18),
      w ? (w.need ? (w.pressAllowed ? "PRESS" : `blocked: ${w.blockedBy}`) : "not needed").slice(0, 44).padEnd(44) : "".padEnd(44), "|",
      w?.need ? (w.oldBlocked ? "BLOCKED (180 s lockout)" : "pressable") : "",
      h.pressedAt.length ? ` presses ${h.pressedAt.map(t).join(",")}` : "",
      h.receiptsAt.length ? ` receipts ${h.receiptsAt.map((r) => `${t(r.at)} ${r.cents}c ${r.source}`).join(",")}` : "",
      h.lost.length ? ` LOST: ${h.lost.join("; ")}` : "",
    ].join(" "));
  }
  console.log(`\nshort at the deal: ${shortDeals} hands; first windows with a need: the new rule presses in ${newAllowed}, the old rule `
              + `was locked out in ${oldBlockedN} — ${unlocked} of them are presses the new rule makes and the old lockout did not`);
} else if (args.includes("--all")) {
  const files = readdirSync(DEBUG).filter((f) => /^ws_dump(-\d+)?\.jsonl(\.1)?$/.test(f)).sort();
  // per hand hero was dealt with a verdict: NEED at the deal; BEFORE = the wrapper pressed (a Buy-chips panel opened)
  // in that hand or the next; AFTER = a press in that hand (the pre-action buy runs as before) or the new rule pressing
  // at its first window
  const tot = { hands: 0, need: 0, beforePressed: 0, beforeMissed: 0, afterCovered: 0, afterMissed: 0, lost: 0 };
  const missWhy = new Map<string, number>();
  for (const f of files) {
    const entries = dumpEntries(readFileSync(join(DEBUG, f), "utf8"));
    const { hands } = replayTopUp(entries, { viaTap: false, fromDump: true });
    realTime();
    resetState();
    const row = { hands: 0, need: 0, beforePressed: 0, beforeMissed: 0, afterCovered: 0, afterMissed: 0, lost: 0 };
    hands.forEach((h, i) => {
      row.lost += h.lost.length;
      if (!h.deal || !h.deal.known) return;
      row.hands++;
      if (!h.deal.need) return;
      row.need++;
      const pressedHere = h.pressedAt.length > 0;
      if (pressedHere || (hands[i + 1]?.pressedAt.length ?? 0) > 0) row.beforePressed++;
      else row.beforeMissed++;
      const w = h.window;
      if (pressedHere || (w && w.need && w.pressAllowed)) row.afterCovered++;
      else {
        row.afterMissed++;
        const why = !w ? "no window seen in the dump (the hand cut off: a socket move, the dump's end)"
          : !w.need ? "not needed by the window (hero won chips, or a buy landed)"
          : String(w.blockedBy).replace(/\$\d+\.\d+/g, "$N").replace(/\d+ s/g, "N s").slice(0, 90);
        missWhy.set(why, (missWhy.get(why) ?? 0) + 1);
        if (args.includes("--verbose")) {
          const prev = hands[i - 1], next = hands[i + 1];
          console.log(`   ${f} ${h.handKey} dealt ${t(h.dealAt)} ${h.deal.stackCents}c (${h.deal.stackSource}) window ${w ? `${t(w.at)} ${w.trigger}` : "-"}: ${why}`
                      + ` | prev ${prev?.handKey} presses ${prev?.pressedAt.map(t).join(",") || "-"} receipts ${prev?.receiptsAt.map((r) => t(r.at)).join(",") || "-"}`
                      + ` | this receipts ${h.receiptsAt.map((r) => t(r.at)).join(",") || "-"} | next presses ${next?.pressedAt.map(t).join(",") || "-"} lost ${h.lost.length}`);
        }
      }
    });
    console.log(f.padEnd(22), JSON.stringify(row));
    for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += row[k];
  }
  console.log("TOTAL".padEnd(22), JSON.stringify(tot));
  console.log("short at the deal and still no press under the new rule:");
  for (const [k, n] of [...missWhy].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
} else {
  console.log("usage: --session <id> [--dump file] [--rid socket]  |  --all [--dir wrapper-debug]");
}
