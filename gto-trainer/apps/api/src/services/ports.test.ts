import { describe, expect, test } from "bun:test";
import { PORT_DEFAULTS, apiUrl, livePort, port, portOffset, rewritePorts } from "./ports";

describe("ports: one offset moves every port", () => {
  test("no setting = the defaults", () => {
    const env = {};
    expect(portOffset(env)).toBe(0);
    for (const k of Object.keys(PORT_DEFAULTS) as (keyof typeof PORT_DEFAULTS)[]) expect(port(k, env)).toBe(PORT_DEFAULTS[k]);
    expect(apiUrl(env)).toBe("http://127.0.0.1:2000");
  });

  test("PORT_OFFSET shifts all six; junk reads as 0", () => {
    const env = { PORT_OFFSET: "50" };
    expect(port("api", env)).toBe(2050);
    expect(port("charts", env)).toBe(8827);
    expect(port("panel", env)).toBe(7750);
    expect(port("gtow", env)).toBe(9272);
    expect(port("gtowSecondary", env)).toBe(9273);
    expect(port("tableCdp", env)).toBe(9383);
    for (const junk of ["", "abc", "-5", "1e3", "99999"]) expect(portOffset({ PORT_OFFSET: junk })).toBe(0);
  });

  test("an explicit variable wins for THIS process; livePort still says where the install runs", () => {
    const env = { PORT_OFFSET: "50", PORT: "2001", PANEL_PORT: "7701" };
    expect(port("api", env)).toBe(2001);
    expect(livePort("api", env)).toBe(2050);
    expect(port("panel", env)).toBe(7701);
    expect(livePort("panel", env)).toBe(7750);
    expect(port("charts", env)).toBe(8827);   // untouched by the others
    expect(port("api", { PORT: "nope" })).toBe(2000);
  });
});

describe("rewritePorts: browser files get this install's addresses", () => {
  const page = `<a href="http://localhost:2000/hands">Hands</a> const API="http://127.0.0.1:2000"; CHARTS=":8777/api";
setTimeout(poll, 2000); "240 min / 2000 hands"; {timeout:20000} "CDP :9222" "panel :7700" "port :7701" x:8777y`;

  test("a no-op without an offset", () => {
    expect(rewritePorts(page, {})).toBe(page);
  });

  test("only the :<default> forms move; bare numbers, other ports and longer numbers stay", () => {
    const out = rewritePorts(page, { PORT_OFFSET: "50" });
    expect(out).toContain("http://localhost:2050/hands");
    expect(out).toContain('"http://127.0.0.1:2050"');
    expect(out).toContain(":8827/api");
    expect(out).toContain("setTimeout(poll, 2000)");
    expect(out).toContain("240 min / 2000 hands");
    expect(out).toContain("{timeout:20000}");
    expect(out).toContain("CDP :9272");
    expect(out).toContain("panel :7750");
    expect(out).toContain("port :7701");
    expect(out).toContain("x:8827y");
  });

  test("an explicit PORT for this process is what the page gets", () => {
    expect(rewritePorts("api :2000", { PORT: "2001" })).toBe("api :2001");
  });
});
