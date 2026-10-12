import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SELF-RELOAD RULE (static/study/page-reload.js `decide`): token changed × hidden × idle × editing → reload now /
 * later (by itself, when idle or hidden) / button (only by hand while the reason lasts). The browser file is a classic
 * script; given a `module` it hands over the rule instead of wiring a page, which is how this reads it.
 */
const FILE = join(import.meta.dir, "..", "..", "static", "study", "page-reload.js");
const mod: { exports: any } = { exports: {} };
new Function("module", readFileSync(FILE, "utf8"))(mod);
const { decide, IDLE_MS, LOOP_MS } = mod.exports as {
  decide: (s: Record<string, unknown>) => { act: "none" | "reload" | "later" | "button"; why: string };
  IDLE_MS: number; LOOP_MS: number;
};

/** a changed page, visible, idle a long time, nothing open — the plain "reload" case; each test changes one thing */
const base = {
  changed: true, hidden: false, idleMs: 10 * 60_000, editing: false, dialog: false, held: "", selection: false,
  quiet: false, sinceReloadMs: Infinity, justShown: false,
};
const act = (over: Record<string, unknown>) => decide({ ...base, ...over }).act;

describe("page-reload decide", () => {
  test("nothing changed: nothing to do, whatever else is true", () => {
    expect(act({ changed: false })).toBe("none");
    expect(act({ changed: false, hidden: true, idleMs: 0, editing: true })).toBe("none");
    expect(decide(null as any).act).toBe("none");
  });

  test("changed + hidden → reload now (nobody is looking)", () => {
    expect(act({ hidden: true, idleMs: 0 })).toBe("reload");
  });

  test("changed + hidden while a session is live → later (reloads when looked at again)", () => {
    expect(act({ hidden: true, quiet: true })).toBe("later");
    // brought back during the session: reload then
    expect(act({ hidden: false, quiet: true, justShown: true, idleMs: 0 })).toBe("reload");
  });

  test("changed + visible: reload only after a minute idle", () => {
    expect(act({ idleMs: IDLE_MS })).toBe("reload");
    expect(act({ idleMs: IDLE_MS - 1 })).toBe("later");
    expect(act({ idleMs: 0 })).toBe("later");
    expect(act({ idleMs: undefined })).toBe("later");   // unknown activity is not idleness
  });

  test("changed + just brought back (nothing pressed since) → reload now, idle or not", () => {
    expect(act({ justShown: true, idleMs: 0 })).toBe("reload");
  });

  test("editing → button, hidden or visible, idle or not", () => {
    for (const hidden of [false, true]) for (const idleMs of [0, 10 * IDLE_MS]) for (const justShown of [false, true]) {
      const d = decide({ ...base, editing: true, hidden, idleMs, justShown });
      expect(d.act).toBe("button");
      expect(d.why).toContain("typed text");
    }
  });

  test("an open dialog or work the page holds → button, even hidden", () => {
    expect(act({ dialog: true, hidden: true })).toBe("button");
    const d = decide({ ...base, held: "a recording is open in the replayer", hidden: true });
    expect(d).toEqual({ act: "button", why: "a recording is open in the replayer" });
    expect(decide({ ...base, held: true }).why).toBe("this page is busy");
  });

  test("selected text → later while visible; a hidden tab reloads regardless", () => {
    expect(act({ selection: true })).toBe("later");
    expect(act({ selection: true, justShown: true })).toBe("later");
    expect(act({ selection: true, hidden: true })).toBe("reload");
  });

  test("an automatic reload moments ago → later (a file being rewritten never loops the tab)", () => {
    expect(act({ sinceReloadMs: 0, hidden: true })).toBe("later");
    expect(act({ sinceReloadMs: LOOP_MS - 1 })).toBe("later");
    expect(act({ sinceReloadMs: LOOP_MS })).toBe("reload");
    // the loop guard never overrides a hard hold
    expect(act({ sinceReloadMs: 0, editing: true })).toBe("button");
  });

  test("every waiting outcome says why", () => {
    for (const over of [{ idleMs: 0 }, { editing: true }, { dialog: true }, { selection: true }, { hidden: true, quiet: true }]) {
      const d = decide({ ...base, ...over });
      expect(d.act === "later" || d.act === "button").toBe(true);
      expect(d.why.length).toBeGreaterThan(10);
    }
  });
});
