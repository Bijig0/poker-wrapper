/**
 * WHO FLIPPED AUTO-EXECUTE (2026-09-30, session_20260930_190719): at 19:34:14 the real-money session's auto went off
 * with an event that said only {on: false}. It took a transcript search to learn that another Claude session's preview
 * browser, verifying a panel card on the LIVE :7700 panel, had clicked where a card header had been — by then the auto
 * label. Every study-auto event now says who asked: the panel names itself and its window's focus/visibility, and the
 * route adds the request's Origin / Referer / User-Agent; the code paths that arm it name themselves.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { S, resetState } from "../../src/state";
import { setAuto } from "../../src/relay";
import { scratchDirs } from "./helpers";

scratchDirs("wrapper-study-auto-by-");
const { buildApp } = await import("../../src/server");

let events: [string, any][] = [];
beforeEach(() => {
  resetState();
  events = [];
  S.session.id = "session_test_by";
  S.sessions = { event: (_sid: string, kind: string, data: any = null) => events.push([kind, data]) } as any;
  S.liveStatus.practice = true;
});
afterEach(() => { resetState(); });

const PREVIEW_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.0 Chrome/154.0.0.0 Electron/40.0.0 Safari/537.36";

test("the panel's checkbox: via, the page's focus and visibility, and the request's headers ride on the event", async () => {
  expect(setAuto(true).ok).toBe(true);
  events = [];
  const app = buildApp();
  const r = await app.request("/study-auto", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:7700", Referer: "http://127.0.0.1:7700/panel", "User-Agent": PREVIEW_UA },
    body: JSON.stringify({ auto: false, via: "panel checkbox", page: { focused: false, visible: "hidden" } }),
  });
  expect(r.status).toBe(200);
  expect(S.study.auto).toBe(false);
  const ev = events.find(([k]) => k === "study-auto")?.[1];
  expect(ev.on).toBe(false);
  expect(ev.by).toEqual({ via: "panel checkbox", page: { focused: false, visible: "hidden" }, origin: "http://127.0.0.1:7700",
                          referer: "http://127.0.0.1:7700/panel", ua: PREVIEW_UA });
});

test("a caller that does not name itself is still identified by its headers", async () => {
  const app = buildApp();
  await app.request("/study-auto", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "curl/8.9.1" }, body: '{"auto":true}' });
  const ev = events.find(([k]) => k === "study-auto")?.[1];
  expect(ev.on).toBe(true);
  expect(ev.by).toMatchObject({ via: "http (no via)", origin: null, ua: "curl/8.9.1" });
});

test("arming on a real-money table records who granted the allowance too", async () => {
  S.liveStatus.practice = false;
  const app = buildApp();
  await app.request("/study-auto", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:7710" },
    body: JSON.stringify({ auto: true, allowRealMoney: true, minutes: 10, hands: 5, reason: "test", via: "panel checkbox", page: { focused: true, visible: "visible" } }) });
  const ev = events.find(([k]) => k === "study-auto")?.[1];
  expect(ev.realMoneyAllowance).toMatchObject({ minutes: 10, hands: 5 });
  expect(ev.by).toMatchObject({ via: "panel checkbox", origin: "http://127.0.0.1:7710", page: { focused: true } });
});

test("the code paths name themselves", () => {
  setAuto(true, { by: { via: "session setup (declared)" } });
  expect(events.find(([k]) => k === "study-auto")?.[1].by).toEqual({ via: "session setup (declared)" });
  events = [];
  setAuto(false);   // an internal caller with nothing to say: an explicit null, never a missing key
  expect(events.find(([k]) => k === "study-auto")?.[1]).toMatchObject({ on: false, by: null });
});
