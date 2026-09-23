/**
 * GOLDEN: the CoinPoker reader over every CoinPoker log the Python recorder replayed
 * (tests/golden/record_cp.py -> corpus/cp-*.jsonl.gz): feed lines, the ParsedHand export, Site.table(), hero status,
 * the room's state and the finished hands the archiver drains — after every log line that changed anything.
 *
 * THE WRAPPER IS TYPESCRIPT ONLY NOW (2026-09-24): the Python recorder made the first baseline; a deliberate change
 * to the reader re-baselines from THIS implementation, same input lines, same delta format:
 *   GOLDEN_UPDATE=1 bun test test/golden/coinpoker.test.ts      (then review the corpus diff before committing)
 */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realTime, setFakeTime } from "../../src/clock";
import { Site } from "../../src/sites/coinpoker";
import * as feed from "../../src/sites/cpFeed";
import { canon, CORPUS, corpusFiles, firstDiff, normPy, readCorpus } from "./lib";

const UPDATE = process.env.GOLDEN_UPDATE === "1";

function snapshot(f: feed.Feed, site: Site, out: [string, string][], touched: string | null) {
  const snap: Record<string, unknown> = {
    lines: out, hero: feed.hero.name, lineAt: f.lineAt, pending: f.pending !== null, broken: f.broken,
    unknown: new Map(f.unknown),
  };
  if (touched && f.rooms.has(touched)) {
    const r = f.rooms.get(touched)!;
    site.pinned = touched;
    snap.room = touched;
    snap.export = feed.exportHand(r);
    snap.table = site.table();
    snap.heroStatus = site.heroStatus();
    snap.practice = site.practice();
    const hand: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.hand || {})) if (!["t0", "tEnd", "turnAt"].includes(k)) hand[k] = v;
    snap.roomState = {
      seats: r.seats, status: r.status, props: r.props, sitout: r.sitout, closed: r.closed, touched: r.touched, hand,
      last: r.last ? r.last.id ?? null : null,
    };
    snap.finished = f.drainFinished().map(([rr, h]) => ({ room: rr.name, id: h.id ?? null, export: site.exportFinished(rr, h) }));
    site.pinned = null;
    snap.active = f.active()?.name ?? null;
  }
  return normPy(snap) as Record<string, unknown>;
}

for (const file of corpusFiles("cp-")) {
  test(`golden: CoinPoker log ${file}`, () => {
    delete process.env.CP_HERO;
    const recs = [...readCorpus(file)];
    const meta = recs[0];
    const lines = recs.filter((r) => r.type === "in").map((r) => r.line as string);
    const tmp = join(mkdtempSync(join(tmpdir(), "golden-cp-")), "main.log");
    writeFileSync(tmp, lines.join("\n"), "utf8");
    setFakeTime(1_790_000_000.0);
    feed.hero.name = "";
    feed.hero.source = null;
    const f = new feed.Feed(tmp, true);
    const site = new Site();
    site.feed = f;
    const fails: string[] = [];
    if (feed.hero.name !== meta.heroAtStart) fails.push(`hero at start: ${feed.hero.name} vs ${meta.heroAtStart}`);
    const expected: Record<string, unknown> = {};
    const rebased: string[] = [JSON.stringify(meta)];     // GOLDEN_UPDATE: the corpus rewritten from this implementation
    const prev = new Map<string, string>();
    let k = 1;
    let n = 0;
    while (k < recs.length && (UPDATE || fails.length < 10)) {
      const inp = recs[k++];
      if (inp.type !== "in") continue;
      const outRec = recs[k] && recs[k].type === "out" && recs[k].i === inp.i ? recs[k++] : null;
      if (UPDATE) rebased.push(JSON.stringify(inp));
      if (f.lineAt) setFakeTime(f.lineAt + 0.5);
      const beforeRooms = new Set(f.rooms.keys());
      const out: [string, string][] = [];
      let touched: string | null = null;
      const raw: string = inp.line;
      if (raw.includes("Login on SFS")) {
        const lm = /Login on SFS with (\S+) Address/.exec(raw);
        if (lm) feed.learnHero(lm[1]!);
      }
      const p = f.join(raw);
      if (!p) {
        const q = feed.QUIT.exec(raw);
        if (q && f.rooms.has(q[1]!)) {
          touched = q[1]!;
          for (const s of f.rooms.get(q[1]!)!.apply("game.quit_table", {}, f.lineAt)) out.push([q[1]!, s]);
        }
      } else {
        const [cmd, d] = p;
        const room = d.room || "?";
        touched = room;
        let r = f.rooms.get(room);
        if (!r) {
          r = new feed.Room(room);
          f.rooms.set(room, r);
        }
        const got = r.apply(cmd, d.bean, f.lineAt);
        for (const s of got) out.push([room, s]);
        if (!got.length && cmd.startsWith("game.") && !feed.QUIET.has(cmd)) f.unknown.set(cmd, (f.unknown.get(cmd) || 0) + 1);
      }
      const changed = !(touched === null && f.rooms.size === beforeRooms.size && [...f.rooms.keys()].every((x) => beforeRooms.has(x))
                        && f.pending === null && !out.length);
      if (!changed) {
        if (outRec && !UPDATE) fails.push(`line ${inp.i}: Python snapshotted, the port saw no change`);
        continue;
      }
      if (UPDATE) {
        if (f.lineAt) setFakeTime(f.lineAt + 0.5);
        const snap = snapshot(f, site, out, touched);
        const delta: Record<string, unknown> = { type: "out", i: inp.i };
        for (const [key, v] of Object.entries(snap)) {
          const enc = canon(v);
          if (prev.get(key) !== enc) {
            delta[key] = v;
            prev.set(key, enc);
          }
        }
        rebased.push(JSON.stringify(delta));
        n++;
        continue;
      }
      if (!outRec) {
        fails.push(`line ${inp.i}: the port saw a change, Python did not (${JSON.stringify(out).slice(0, 200)})`);
        continue;
      }
      if (f.lineAt) setFakeTime(f.lineAt + 0.5);
      const snap = snapshot(f, site, out, touched);
      for (const [key, v] of Object.entries(outRec)) if (key !== "type" && key !== "i") expected[key] = v;
      for (const [key, v] of Object.entries(snap)) {
        if (!(key in expected)) continue;
        if (canon(v) !== canon(expected[key])) {
          fails.push(`line ${inp.i} (${String(raw).slice(0, 90)}…) ${key}: ${firstDiff(v, expected[key])}`);
          break;
        }
      }
      n++;
    }
    realTime();
    if (UPDATE) {
      const body = rebased.map((r) => r + String.fromCharCode(10)).join("");
      writeFileSync(join(CORPUS, file), Bun.gzipSync(new TextEncoder().encode(body), { level: 9 }));
      console.log(`${file}: re-baselined, ${n} snapshots`);
      return;
    }
    console.log(`${file}: ${n} snapshots compared`);
    expect(fails).toEqual([]);
  }, 600_000);
}
