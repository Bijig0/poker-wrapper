/**
 * THE CHAIN LINE (2026-09-25): the API's poller pushes each answer's chain verdict (clean / rebuilt / extra requests /
 * no answer) and the session's clean count with the answer; the wrapper keeps the verdict only as long as the answer
 * is fresh, keeps the session count across pushes, and the panel shows a banner only when the answer did NOT come
 * the happy way. The panel's renderer is read straight out of panel.html and run against a stub DOM.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { S, freshStudy } from "../../src/state";
import { currentChain } from "../../src/relay";
import { time } from "../../src/clock";

const saved = S.study;
afterEach(() => { S.study = saved; });

describe("currentChain — the /state panelChain key", () => {
  test("a fresh answer carries its verdict; the session count rides along", () => {
    S.study = { ...freshStudy(), on: true, text: "TURN — Check 80%", at: time(),
      chain: { verdict: "rebuilt", label: "rebuilt", reason: "flop: memo lost" }, chainSession: { hands: 3, clean: 2, rate: 2 / 3 } };
    const c = currentChain()!;
    expect(c.verdict).toBe("rebuilt");
    expect(c.reason).toBe("flop: memo lost");
    expect(c.session.clean).toBe(2);
  });
  test("a stale answer loses its verdict, the session count stays", () => {
    S.study = { ...freshStudy(), on: true, text: "TURN — Check 80%", at: time() - 10,
      chain: { verdict: "rebuilt", label: "rebuilt", reason: "x" }, chainSession: { hands: 3, clean: 2, rate: 2 / 3 } };
    const c = currentChain()!;
    expect(c.verdict).toBeNull();
    expect(c.session.hands).toBe(3);
  });
  test("answers off: nothing at all (the /state key is omitted, the reader goldens stay byte-identical)", () => {
    S.study = { ...freshStudy(), on: false, chainSession: { hands: 3, clean: 2, rate: 2 / 3 } };
    expect(currentChain()).toBeNull();
  });
});

describe("the panel's renderChain", () => {
  const html = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "ignition-study-wrapper", "panel.html"), "utf-8").replace(/\r\n/g, "\n");
  const start = html.indexOf("function renderChain(ch, hasAnswer) {");
  const end = html.indexOf("\n  }\n", start) + 4;
  const src = html.slice(start, end);
  const el = () => ({ className: "", innerHTML: "", textContent: "", style: { display: "" } });
  const make = () => {
    const box = el(), rate = el();
    const $ = (id: string) => (id === "sa-chain" ? box : rate);
    const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const renderChain = new Function("$", "esc", `${src}; return renderChain;`)($, esc) as (ch: any, has: boolean) => void;
    return { box, rate, renderChain };
  };
  test("found in panel.html", () => { expect(start).toBeGreaterThan(0); });
  test("clean and by-design: no banner, only the session count", () => {
    const { box, rate, renderChain } = make();
    renderChain({ verdict: "by-design", label: "clean (by design)", reason: null, session: { hands: 10, clean: 9, rate: 0.9 } }, true);
    expect(box.className).toBe("");
    expect(rate.textContent).toBe("chain 9/10 clean this session (90%)");
    expect(rate.style.display).toBe("block");
  });
  test("rebuilt: an amber banner with the reason; extra requests / no answer: red", () => {
    const { box, renderChain } = make();
    renderChain({ verdict: "rebuilt", label: "rebuilt", reason: "flop: the capture re-read the flop <X,X>", session: null }, true);
    expect(box.className).toBe("warn");
    expect(box.innerHTML).toContain("<b>REBUILT</b>");
    expect(box.innerHTML).toContain("&lt;X,X>");
    renderChain({ verdict: "leaked", label: "extra requests", reason: "turn: tree created again", session: null }, true);
    expect(box.className).toBe("bad");
    expect(box.innerHTML).toContain("EXTRA REQUESTS");
  });
  test("no answer on screen: no banner, whatever the last verdict was", () => {
    const { box, rate, renderChain } = make();
    renderChain({ verdict: "rebuilt", label: "rebuilt", reason: "x", session: { hands: 0, clean: 0, rate: null } }, false);
    expect(box.className).toBe("");
    expect(rate.style.display).toBe("none");
  });
});
