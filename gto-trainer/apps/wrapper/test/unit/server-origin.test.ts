/**
 * A WEB PAGE MAY NOT DRIVE THE WRAPPER (2026-09-25 audit): with `Access-Control-Allow-Origin: *` and bodies parsed
 * whatever their type, any page open in any browser here could POST /act, arm real-money auto-execute, force a
 * top-up, and read /state. A foreign Origin is now refused before any handler runs; the study API and the panels
 * (local origins) and server-side callers (no Origin at all) are unaffected.
 */
import { expect, test } from "bun:test";
import { resetState } from "../../src/state";
import { scratchDirs } from "./helpers";

resetState();
scratchDirs("wrapper-origin-");
const { buildApp, ALLOWED_ORIGIN } = await import("../../src/server");
const app = buildApp();

test("a foreign page's POST never reaches a handler", async () => {
  for (const path of ["/act", "/study-auto", "/topup/now", "/session/end", "/quit"]) {
    const r = await app.request(path, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" }, body: '{"auto":true,"allowRealMoney":true}' });
    expect(r.status).toBe(403);
  }
  // DNS rebinding: the page's own hostname rides the Origin even when it resolves to this machine
  const rb = await app.request("/act", { method: "POST", headers: { Origin: "http://attacker.test:7700" }, body: "{}" });
  expect(rb.status).toBe(403);
});

test("the study API (a local origin) and server-side callers (no Origin) pass the gate", async () => {
  const fromApi = await app.request("/definitely-not-a-route", { method: "POST", headers: { Origin: "http://127.0.0.1:2000", "Content-Type": "application/json" }, body: "{}" });
  expect(fromApi.status).toBe(404);        // reached routing, not refused
  const serverSide = await app.request("/definitely-not-a-route", { method: "POST", body: "{}" });
  expect(serverSide.status).toBe(404);
});

test("the CORS header names only an allowed origin — a foreign page cannot read /state (hero's cards)", async () => {
  const foreign = await app.request("/definitely-not-a-route", { headers: { Origin: "https://evil.example" } });
  expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  const local = await app.request("/definitely-not-a-route", { headers: { Origin: "http://localhost:2000" } });
  expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:2000");
  const pre = await app.request("/act", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  expect(pre.status).toBe(403);
});

test("the allow-list: the API's ports and any local panel, nothing else", () => {
  for (const o of ["http://127.0.0.1:2000", "http://localhost:2001", "http://127.0.0.1:7700", "http://127.0.0.1:7730"]) expect(ALLOWED_ORIGIN.test(o)).toBe(true);
  for (const o of ["https://127.0.0.1:2000", "http://127.0.0.1.evil.com:2000", "http://192.168.0.2:7700", "http://localhost:8080", "null"]) expect(ALLOWED_ORIGIN.test(o)).toBe(false);
});
