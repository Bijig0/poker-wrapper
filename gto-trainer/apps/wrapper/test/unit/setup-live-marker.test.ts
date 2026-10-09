/**
 * THE SETUP PAGE COUNTS AS LIVE (2026-10-09, catalogue-incremental). The study API holds its heavy rebuilds (the strategy
 * catalogue, the registry) while a session is live — and now while the setup page is open. The page marks its polls
 * (`/session?from=setup`, `/session/gtow-accounts?from=setup`); for two minutes after one, the wrapper's own calls to the
 * API for it carry `X-Poker-Setup: 1` (the API's services/setupLive.ts). Here: the header against a stub API, and the
 * page's markers read out of setup.html.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as SES from "../../src/sessions";

let seen: (string | null)[] = [];
let stub: ReturnType<typeof Bun.serve>;
const apiBefore = process.env.STUDY_API;

beforeAll(() => {
  stub = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(req.headers.get("x-poker-setup"));
      return Response.json({ ok: true, strategies: [{ id: "s1" }] });
    },
  });
  process.env.STUDY_API = `http://127.0.0.1:${stub.port}`;
});
afterAll(() => {
  stub.stop(true);
  if (apiBefore === undefined) delete process.env.STUDY_API; else process.env.STUDY_API = apiBefore;
  SES.__resetSetupPage();
});

describe("the setup page's marker on the wrapper's API calls", () => {
  test("no marker until the setup page polls; then the catalogue and registry reads carry it", async () => {
    SES.__resetSetupPage();
    seen = [];
    expect(SES.setupPageOpen()).toBe(false);
    expect(SES.setupHeaders()).toEqual({});
    await SES.realFetchStrategies(2);
    SES.noteSetupPage();
    expect(SES.setupPageOpen()).toBe(true);
    await SES.realFetchStrategies(2);
    await SES.realFetchRegistry(2);
    expect(seen).toEqual([null, "1", "1"]);
  });

  test("setup.html marks its own polls", () => {
    const html = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "ignition-study-wrapper", "setup.html"), "utf8");
    expect(html.match(/fetch\("\/session\?from=setup"\)/g)?.length).toBe(2);   // the first read and the catalogue watch
    expect(html).toContain('fetch("/session/gtow-accounts?from=setup")');
    expect(html).not.toContain('fetch("/session")');
  });
});
