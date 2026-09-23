/**
 * Port of tests/test_bet_input.py and tests/test_frame_resolver.py.
 *
 * Which field a relayed raise types into (hand 4919313617: the size went into the Buy-chips box) — the one beside
 * the button the raise is confirmed on, and REFUSE when that cannot be decided. And which iframe is MY table: the
 * resolver takes the Nth table frame in the client's own tag order, whatever numbers it tags them with; the one
 * snippet every read goes through is run here as the real JavaScript, against a tiny DOM shim.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { js } from "../../src/js";
import { pickBetInput } from "../../src/relay";
import { checker, J } from "./helpers";

test("which field a relayed raise types into", () => {
  const { fails, check } = checker();
  const FRAME_W = 883;
  const RAISE = { x: 606 + 66, y: 594 };
  const BET_FIELD = { x: 640, y: 660, value: "2", type: "text" };
  const BUYIN_FIELD = { x: 98, y: 608, value: "200", type: "text" };
  let [inp, why] = pickBetInput([BUYIN_FIELD, BET_FIELD], RAISE, FRAME_W);
  check("the BET field is chosen, not the buy-in box", inp === BET_FIELD, `${J(inp)} / ${why}`);
  check("  ... and nothing is refused when it can be told apart", why === null, String(why));
  [inp] = pickBetInput([BET_FIELD, BUYIN_FIELD], RAISE, FRAME_W);
  check("bet field first in the list", inp === BET_FIELD);
  [inp] = pickBetInput([BUYIN_FIELD, BET_FIELD], RAISE, FRAME_W);
  check("buy-in first in the list (the hand-513 order)", inp === BET_FIELD);
  [inp, why] = pickBetInput([BET_FIELD], RAISE, FRAME_W);
  check("taken", inp === BET_FIELD && why === null, String(why));
  [inp, why] = pickBetInput([], RAISE, FRAME_W);
  check("no inputs at all", inp === null && (why || "").includes("no bet input"), String(why));
  [inp, why] = pickBetInput([BUYIN_FIELD], RAISE, FRAME_W);
  check("only the buy-in box on screen → refuse, do not type into it", inp === null && (why || "").includes("RAISE/BET button"), String(why));
  [inp, why] = pickBetInput([BUYIN_FIELD, BET_FIELD], null, FRAME_W);
  check("two fields and no RAISE/BET anchor → refuse", inp === null && (why || "").includes("tell them apart"), String(why));
  [inp, why] = pickBetInput([BET_FIELD], null, FRAME_W);
  check("one field and no anchor → still usable", inp === BET_FIELD && why === null, String(why));
  const farLeft = { x: 98, y: 660 }, nearStrip = { x: 326, y: 660 };
  [inp, why] = pickBetInput([nearStrip], RAISE, FRAME_W);
  check("a field at the left end of the sizing row is still the bet field", inp === nearStrip, String(why));
  [inp, why] = pickBetInput([farLeft], RAISE, FRAME_W);
  check("a field over at the Buy-chips panel is not", inp === null && (why || "").includes("not the bet field"), String(why));
  // THE FRAME IS NOT A RULER
  const TALL_RAISE = { x: 672, y: 591 };
  const TALL_FIELD = { x: 640, y: 591, h: 42, value: "4", type: "text" };
  [inp, why] = pickBetInput([TALL_FIELD], TALL_RAISE, 1392);
  check("the bet field is found though it sits at 39% of a 1513px frame", inp === TALL_FIELD, String(why));
  const FAR_ROW = { x: 660, y: 591 - 400, h: 42, value: "9", type: "text" };
  [inp, why] = pickBetInput([FAR_ROW], TALL_RAISE, 1392);
  check("  ... but a field 400px above the button is a different row → refuse", inp === null && (why || "").includes("row"), String(why));
  [inp] = pickBetInput([FAR_ROW, TALL_FIELD], TALL_RAISE, 1392);
  check("  ... and with both on screen it still takes the one beside the button", inp === TALL_FIELD);
  const NO_H = { x: 640, y: 591, value: "4", type: "text" };
  [inp, why] = pickBetInput([NO_H], TALL_RAISE, 1392);
  check("an input with no height recorded is still usable", inp === NO_H, String(why));
  expect(fails).toEqual([]);
});

type Frame = [string, string | null, boolean];

/** Run the REAL resolver snippet against a DOM shim of these frames. */
function resolve(frames: Frame[], slots: (number | null)[]): (string | null)[] {
  const els = frames.map(([id, tag, play]) => ({
    id,
    getAttribute(name: string) {
      if (name === "data-multitableslot") return tag;
      if (name === "src") return play ? `x?playMode=real#${id}` : `x#${id}`;
      return null;
    },
  }));
  const document = {
    querySelectorAll(sel: string) {
      if (sel !== "iframe") throw new Error("the resolver asked for " + sel);
      return els;
    },
  };
  const frame = new Function("document", js("launch.FRAME_JS") + "\nreturn __frame;")(document) as (s: number | null) => any;
  return slots.map((s) => {
    const f = frame(s);
    return f ? f.id : null;
  });
}

test("which iframe is MY table, whatever numbers the client tags them with", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const CASES: Record<string, Frame[]> = {
    "zero-based, 2 tables": [["lobby", "-1", false], ["t1", "0", true], ["t2", "1", true]],
    "one-based, 2 tables": [["lobby", "0", false], ["t1", "1", true], ["t2", "2", true]],
    "one table, no attribute at all": [["t1", null, true]],
    "4 tables, DOM order != tag order": [["t3", "2", true], ["t1", "0", true], ["t4", "3", true], ["lobby", "-1", false], ["t2", "1", true]],
    "tags with gaps in them": [["t1", "5", true], ["t2", "9", true]],
    "the lobby alone": [["lobby", "-1", false]],
  };
  for (const label of ["zero-based, 2 tables", "one-based, 2 tables"]) {
    eq(`${label}: 0,1 are the two tables; 2 is nothing; null is the first`, resolve(CASES[label]!, [0, 1, 2, null]), ["t1", "t2", null, "t1"]);
  }
  eq("one untagged table: ordinal 0 is it", resolve(CASES["one table, no attribute at all"]!, [0, null]), ["t1", "t1"]);
  eq("  ... and there is no second table to read", resolve(CASES["one table, no attribute at all"]!, [1]), [null]);
  eq("four tables sort by their own tag, not by DOM order", resolve(CASES["4 tables, DOM order != tag order"]!, [0, 1, 2, 3, 4]), ["t1", "t2", "t3", "t4", null]);
  eq("gaps in the numbering change nothing", resolve(CASES["tags with gaps in them"]!, [0, 1, 2]), ["t1", "t2", null]);
  eq("a page with only the lobby resolves to nothing", resolve(CASES["the lobby alone"]!, [0, 1, null]), [null, null, null]);
  eq("  ... and it is skipped even when it sorts first", resolve(CASES["4 tables, DOM order != tag order"]!, [0]), ["t1"]);
  eq("formats' resolver is the identical snippet", js("formats.FRAME_FN"), js("launch.FRAME_JS"));
  // no literal [data-multitableslot="N"] lookup anywhere in the port's page code or sources
  const src = join(import.meta.dir, "..", "..", "src");
  // the reader, the relay and the lobby driver (launch.py + formats.py in the Python test); the fake table's own
  // markup legitimately RENDERS the attribute and is not a lookup
  const files = [...readdirSync(join(src, "js")).map((f) => join(src, "js", f)),
                 ...readdirSync(join(src, "ignition")).map((f) => join(src, "ignition", f)),
                 ...["formats.ts", "relay.ts", "topup.ts", "session.ts", "netguard.ts", "server.ts"].map((f) => join(src, f))];
  const literal = files.flatMap((f) => readFileSync(f, "utf8").split(/\r?\n/)
    .filter((ln) => ln.includes('data-multitableslot="') && !ln.includes("//") && !ln.includes("#")).map((ln) => `${f}: ${ln.trim()}`));
  eq('no literal [data-multitableslot="N"] lookup is left anywhere', literal, []);
  expect(fails).toEqual([]);
});
