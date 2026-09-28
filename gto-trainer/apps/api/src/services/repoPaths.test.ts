import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { DATA_DIR, factoryFile } from "./repoPaths";

const saved = process.env.FACTORY_DATA_DIR;
afterEach(() => { if (saved === undefined) delete process.env.FACTORY_DATA_DIR; else process.env.FACTORY_DATA_DIR = saved; });

describe("factoryFile — where the chart factory's data outputs are read from", () => {
  it("data/ by default; FACTORY_DATA_DIR (the owner's machine: the factory's own folder) when set, read per call", () => {
    delete process.env.FACTORY_DATA_DIR;
    expect(factoryFile("hrc6max-preflop.sqlite")).toBe(join(DATA_DIR, "hrc6max-preflop.sqlite"));
    process.env.FACTORY_DATA_DIR = "C:\factory\data";
    expect(factoryFile("resolved-charts.json")).toBe(join("C:\factory\data", "resolved-charts.json"));
    process.env.FACTORY_DATA_DIR = "";
    expect(factoryFile("mes_turn")).toBe(join(DATA_DIR, "mes_turn"));   // blank = unset (local.env's empty template line)
  });
});
