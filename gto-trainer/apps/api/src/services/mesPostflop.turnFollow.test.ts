import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mesTurnLines, setTurnMissRecheckMs } from "./mesPostflop";
import { testTempDir } from "../test/tempDir";

// The turn-file cache was keyed by path alone and remembered a missing file as "none" forever: a board extracted after
// the API started never answered, and a re-extracted one kept its old nodes until a restart.
const dir = testTempDir("data-reread-");
const FAM = "M2_heroBTN_srp_vs_BB", BOARD = "Kc7d2h";
const file = join(dir, `${FAM}_${BOARD}.turn.json`);
const fixture = join(import.meta.dir, "__fixtures__", "mes_turn", `${FAM}_${BOARD}.turn.json`);
let n = 0;
/** give the file an mtime of its own (Windows' coarse clock can give two quick writes the same one) */
const aged = () => { const t = new Date(Date.now() - 60_000 + ++n * 1000); utimesSync(file, t, t); };
/** a minimal turn file: one flop line ("1") reaching the turn on the given cards */
const turnFile = (cards: string[]) => JSON.stringify({
  family: FAM, board: BOARD, hero_player: 1, holes: ["AhQs"],
  lines: { "1": { labels: ["Check"], cards: Object.fromEntries(cards.map((c) => [c, { pot: 5, w: [1], nodes: [] }])) } },
});

const saved = process.env.MES_TURN_DIR;
beforeAll(() => { process.env.MES_TURN_DIR = dir; });
afterAll(() => {
  if (saved === undefined) delete process.env.MES_TURN_DIR; else process.env.MES_TURN_DIR = saved;
  setTurnMissRecheckMs(30_000);
});
beforeEach(() => setTurnMissRecheckMs(0));

describe("MES turn files are followed", () => {
  test("a missing file is remembered for the recheck interval only; one extracted later is found", () => {
    setTurnMissRecheckMs(60_000);
    expect(mesTurnLines(FAM, BOARD)).toBeNull();
    copyFileSync(fixture, file);
    expect(mesTurnLines(FAM, BOARD)).toBeNull();          // inside the interval: still "none", no stat
    setTurnMissRecheckMs(0);                              // the interval has passed
    const lines = mesTurnLines(FAM, BOARD);               // the "none" expired: found
    expect(lines).not.toBeNull();
    expect(lines!.length).toBeGreaterThan(0);
  });

  test("a re-extracted file (same name) is read again", () => {
    writeFileSync(file, turnFile(["2c"])); aged();
    expect(mesTurnLines(FAM, BOARD)).toEqual([{ hist: [1], labels: ["Check"], cards: ["2c"] }]);
    writeFileSync(file, turnFile(["2c", "3d", "Ah"])); aged();
    expect(mesTurnLines(FAM, BOARD)).toEqual([{ hist: [1], labels: ["Check"], cards: ["2c", "3d", "Ah"] }]);
  });

  test("a file caught mid-copy keeps the copy read before; a deleted one is gone", () => {
    writeFileSync(file, turnFile(["9s"])); aged();
    expect(mesTurnLines(FAM, BOARD)![0]!.cards).toEqual(["9s"]);
    writeFileSync(file, turnFile(["9s", "Td"]).slice(0, 40)); aged();
    expect(mesTurnLines(FAM, BOARD)![0]!.cards).toEqual(["9s"]);
    writeFileSync(file, turnFile(["9s", "Td"])); aged();
    expect(mesTurnLines(FAM, BOARD)![0]!.cards).toEqual(["9s", "Td"]);
    unlinkSync(file);
    expect(mesTurnLines(FAM, BOARD)).toBeNull();
  });
});
