/**
 * Table panels reopen (2026-09-25: a new session REUSED table wrappers left running from the last one — "already
 * running" — and their closed panel windows were never reopened: four tables playing, one panel on screen).
 * ensurePanelWindow opens this wrapper's own panel only when it is missing, in its own tile; the leader's
 * reopenPanels asks each table for its own window, and says which tables it could not reach.
 */
import { expect, test } from "bun:test";
import { reloadConfig } from "../../src/config";
import { realTime } from "../../src/clock";
import { S, resetState, seams } from "../../src/state";
import { ensurePanelWindow, reopenPanels, sessionSeams } from "../../src/session";
import { checker, J, scratchDirs } from "./helpers";

test("table panels reopen: only when missing, in their own tile, from the leader's grid", async () => {
  const { fails, check } = checker();
  scratchDirs();
  realTime();
  resetState();
  const env0 = { slot: process.env.TABLE_SLOT, count: process.env.TABLE_COUNT, port: process.env.PANEL_PORT };
  const seams0 = { ...sessionSeams };
  const registry0 = seams.registry;
  const log0 = console.log;
  console.log = () => {};
  const opened: any[] = [];
  const asked: any[] = [];
  // a stand-in for another table's wrapper: it answers POST /panel/open-window
  const peer = Bun.serve({
    port: 0,
    async fetch(req) {
      asked.push({ path: new URL(req.url).pathname, body: await req.json().catch(() => null) });
      return Response.json({ ok: true, opened: true });
    },
  });
  const events: any[] = [];
  S.sessions = { event: (_sid: string, kind: string, data: any = null) => events.push([kind, data]) } as any;
  const asTable = (slot: number, n: number) => {
    Object.assign(process.env, { TABLE_SLOT: String(slot), TABLE_COUNT: String(n), PANEL_PORT: String(7700 + 10 * (slot - 1)) });
    reloadConfig();
  };
  try {
    asTable(2, 4);
    S.session.id = "session_test";
    sessionSeams.openWindow = (url, profile, x, y, w, h) => { opened.push({ url, profile, x, y, w, h }); return 4242; };

    sessionSeams.panelWindow = () => 777;
    let r = ensurePanelWindow("test");
    check("its panel window is on screen → left alone", r.already === true && opened.length === 0, J({ r, opened }));

    sessionSeams.panelWindow = () => null;
    r = ensurePanelWindow("joined session_test");
    check("missing → opened", r.ok && r.opened && opened.length === 1, J({ r, opened }));
    check("  ... its OWN panel, on its own port", opened[0]?.url === "http://127.0.0.1:7710/panel", J(opened[0]));
    check("  ... in its own browser profile", String(opened[0]?.profile).endsWith("-2"), J(opened[0]));
    check("  ... logged as a session event", events.some(([k, d]) => k === "panel-reopened" && d.slot === 2), J(events));

    // the leader's grid: every table, or one
    asTable(1, 4);
    opened.length = 0;
    seams.registry = () => [
      { slot: 1, panelPort: 7700, live: true, me: true },
      { slot: 2, panelPort: peer.port, live: true, panelOpen: false },
      { slot: 3, panelPort: peer.port, live: true, panelOpen: false },
      { slot: 4, panelPort: 7730, live: false },
    ];
    const all = await reopenPanels(null);
    check("reopen all: the leader opens its own", opened.length === 1 && opened[0].url === "http://127.0.0.1:7700/panel", J(opened));
    check("  ... and asks each running table for its own", asked.filter((a) => a.path === "/panel/open-window").length === 2, J(asked));
    check("  ... and names the table that is not running", all.results.find((x: any) => x.slot === 4)?.ok === false
          && String(all.results.find((x: any) => x.slot === 4)?.error).includes("not running"), J(all));
    check("  ... so the whole ask is not ok", all.ok === false, J(all));

    asked.length = 0;
    opened.length = 0;
    const one = await reopenPanels(3);
    check("reopen one table → only that table is asked", one.ok && asked.length === 1 && opened.length === 0 && one.results.length === 1, J({ one, asked }));
    const none = await reopenPanels(4);
    check("a table that is not running → says so", !none.ok, J(none));
  } finally {
    Object.assign(sessionSeams, seams0);
    seams.registry = registry0;
    peer.stop(true);
    for (const [k, v] of [["TABLE_SLOT", env0.slot], ["TABLE_COUNT", env0.count], ["PANEL_PORT", env0.port]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    reloadConfig();
    console.log = log0;
  }
  expect(fails).toEqual([]);
});
