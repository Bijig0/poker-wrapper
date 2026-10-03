/**
 * GET /api/dashboard/gtow-token (2026-10-03): the wrapper's chain keeper's light token check — the registry's
 * armed.gtow.tokenLive / multiwayLive (gtowApi.tokenStatus(), memory only) without building the registry. It must
 * stay that: no CDP probe, nothing awaited.
 */
import { afterAll, describe, expect, it, mock, spyOn } from "bun:test";
import * as gtowApiMod from "../services/gtowApi";
import { gtowSessions } from "../services/gtowSessions";

// nothing here may reach GTO Wizard
const status = spyOn(gtowApiMod.gtowApi, "tokenStatus").mockImplementation((() => ({})) as never);
const probed = spyOn(gtowSessions, "statusProbed").mockImplementation((async () => []) as never);
afterAll(() => mock.restore());

const { default: app } = await import("./dashboard");
const get = async () => {
  const r = await app.request("/gtow-token");
  return { status: r.status, body: (await r.json()) as any };
};
const token = (t: { live: boolean; multiwayLive: boolean; expiresInMs: number | null }) =>
  status.mockImplementation((() => ({ ...t, lastAttemptMs: null, keeperRunning: true, sessions: [] })) as never);

describe("the light token check", () => {
  it("answers the pool's token state, under the registry's names", async () => {
    token({ live: true, multiwayLive: false, expiresInMs: 1_740_000 });
    expect(await get()).toEqual({ status: 200, body: { ok: true, tokenLive: true, multiwayLive: false, expiresInMs: 1_740_000 } });
    token({ live: false, multiwayLive: false, expiresInMs: null });
    expect((await get()).body).toEqual({ ok: true, tokenLive: false, multiwayLive: false, expiresInMs: null });
  });

  it("probes nothing", async () => {
    token({ live: true, multiwayLive: true, expiresInMs: 60_000 });
    await get();
    expect(probed).not.toHaveBeenCalled();
  });
});
