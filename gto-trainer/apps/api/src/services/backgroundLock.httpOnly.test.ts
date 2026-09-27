import { afterEach, describe, expect, it } from "bun:test";
import { httpOnlyByConfig } from "./backgroundLock";

const saved = { port: process.env.PORT, only: process.env.API_HTTP_ONLY };
afterEach(() => {
  if (saved.port === undefined) delete process.env.PORT; else process.env.PORT = saved.port;
  if (saved.only === undefined) delete process.env.API_HTTP_ONLY; else process.env.API_HTTP_ONLY = saved.only;
});

describe("a second API never takes the background work (2026-09-27)", () => {
  it("the live API (no PORT, or 2000) may own it; the :2001 verify server or API_HTTP_ONLY=1 never", () => {
    delete process.env.PORT; delete process.env.API_HTTP_ONLY;
    expect(httpOnlyByConfig()).toBeNull();
    process.env.PORT = "2000";
    expect(httpOnlyByConfig()).toBeNull();
    process.env.PORT = "2001";
    expect(httpOnlyByConfig()).toContain(":2001");
    process.env.PORT = "2000"; process.env.API_HTTP_ONLY = "1";
    expect(httpOnlyByConfig()).toBe("API_HTTP_ONLY=1");
  });
});
