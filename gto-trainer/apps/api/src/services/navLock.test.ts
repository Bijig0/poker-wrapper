import { describe, expect, it } from "bun:test";
import { navLock } from "./navLock";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("navLock", () => {
  it("runs a single caller normally", async () => {
    const result = await navLock.run(async () => ({ ok: true, value: 1 }));
    expect(result).toEqual({ ok: true, value: 1 });
  });

  it("turns away a second caller that arrives while the first is in flight", async () => {
    const first = navLock.run(async () => {
      await wait(50);
      return { ok: true, value: "first" };
    });
    await wait(5); // let `first` claim the lock before the second call starts
    const second = await navLock.run(async () => ({ ok: true, value: "second" }));

    expect(second).toEqual({ ok: false, error: "Navigation already in progress — skipped.", skipped: true });
    expect(await first).toEqual({ ok: true, value: "first" });
  });

  it("allows a new caller through once the first has resolved", async () => {
    await navLock.run(async () => ({ ok: true, value: "one" }));
    const result = await navLock.run(async () => ({ ok: true, value: "two" }));
    expect(result).toEqual({ ok: true, value: "two" });
  });

  it("releases the lock even when the wrapped function throws", async () => {
    await expect(
      navLock.run(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const result = await navLock.run(async () => ({ ok: true, value: "after-throw" }));
    expect(result).toEqual({ ok: true, value: "after-throw" });
  });
});
