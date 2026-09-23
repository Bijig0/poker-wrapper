/** Golden dispatch entries for modules ported after terminal/reconcile (kept apart so pure.test.ts stays short). */
import * as FAKE from "../../src/faketable";
import * as TABLES from "../../src/tables";
import * as F from "../../src/formats";
import * as S from "../../src/sessions";
import * as NC from "../../src/netcheck";
import * as BAL from "../../src/balances";
import * as AUTH from "../../src/auth";
import * as CDP from "../../src/cdp";
import { setFakeTime, time } from "../../src/clock";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as CPF from "../../src/sites/cpFeed";
import { Site as CPSite, FORMATS as CP_FORMATS } from "../../src/sites/coinpoker";
import * as CPA from "../../src/sites/cpActions";

let CATALOGUE: any[] = [];
const BAL_DIR = mkdtempSync(join(tmpdir(), "golden-pure-bal-"));
const onBalDb = <T>(f: () => T): T => {
  const was = process.env.WRAPPER_DATA_DIR;
  process.env.WRAPPER_DATA_DIR = BAL_DIR;
  try {
    return f();
  } finally {
    if (was === undefined) delete process.env.WRAPPER_DATA_DIR;
    else process.env.WRAPPER_DATA_DIR = was;
  }
};
function sessionsDeps() {
  setFakeTime(1_790_100_000.0);
  S.deps.fetchStrategies = async () => structuredClone(CATALOGUE);
  S.deps.scrapeCached = async () => ({ ok: false, reason: "no Ignition client on CDP port 9333" });
  S.deps.latestBalance = (profile: string) => (profile === "brady" ? { amountCents: 123456, ts: 1_790_000_000_000 } : null);
  S.deps.netCached = async () => ({ ok: true, detail: "round trip 120 ms · 0/10 lost", rttMs: 120 });
  S.deps.gitHead = () => null;
}

const withEnv = (env: Record<string, string>, fn: () => unknown) => {
  const keys = ["TABLE_SLOT", "TABLE_COUNT"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

export const FNS_EXTRA: Record<string, (args: any[], rec: any) => unknown> = {
  "faketable.render_inner": ([spec]) => FAKE.renderInner(spec),
  "faketable.render_outer": ([url, n]) => FAKE.renderOuter(url, n),
  "faketable.display_card": ([c]) => FAKE.displayCard(c),
  "faketable.encode_card": ([c]) => {
    try {
      return FAKE.encodeCard(c);
    } catch (e: any) {
      return { __error__: `ValueError: ${e.message}` };
    }
  },
  "faketable._bb": ([v]) => FAKE.bbText(v),
  "tables.grid": ([i, n, area]) => TABLES.grid(i, n, area),
  "tables.client_rect": ([n, area]) => TABLES.clientRect(n, area),
  "tables.panel_rect": ([s, n, area, other]) => TABLES.panelRect(s, n, area, other),
  "tables.dip_layout": ([mons]) => TABLES.dipLayout(mons),
  "tables.to_dip": ([rect, mons]) => TABLES.toDip(rect, mons),
  "tables.env": ([env]) => withEnv(env, () => ({
    slot: TABLES.slot(), count: TABLES.count(), domSlot: TABLES.domSlot(), isLeader: TABLES.isLeader(),
    leaderPort: TABLES.leaderPort(), ports: [1, 2, 3, 4].map((k) => TABLES.panelPort(k)), rig: TABLES.rig(),
  })),
  "formats.data": () => F.data(),
  "formats.stake_for_bb": ([b]) => F.stakeForBb(b),
  "formats.format_id_for": ([gt, st, seats]) => F.formatIdFor(gt, st, seats),
  "formats._describe": ([p]) => F.describe(p),
  "formats.compare": ([fid, o]) => F.compare(fid, o),
  "formats._table_js": ([slot]) => F.tableJs(slot),
  "formats._LOBBY": () => F.LOBBY(),
  "formats._SIGNED_OUT_JS": () => F.SIGNED_OUT_JS(),
  "formats._SEATED_JS": () => F.SEATED_JS(),
  "formats._LOBBY_BTN_JS": () => F.LOBBY_BTN_JS(),
  "formats._js_click_text": ([sel, text]) => F.jsClickText(sel, text),
  "auth._STATE_JS": () => AUTH.STATE_JS(),
  "auth._SNAP_JS": () => AUTH.SNAP_JS(),
  "balances._SCRAPE_JS": () => BAL.SCRAPE_JS(),
  "balances._IN_PLAY_JS": () => BAL.IN_PLAY_JS(),
  "cdp._EXTRACT_JS": () => CDP.EXTRACT_JS(),
  "sessions.catalogue": (_a, rec) => {
    CATALOGUE = rec.out;
    return rec.out;
  },
  "sessions._strategy_preset": ([s]) => S.strategyPreset(s),
  "sessions.presets": async () => {
    sessionsDeps();
    return S.presets(true);
  },
  "sessions.merged_config": async ([preset, o]) => {
    sessionsDeps();
    return S.mergedConfig(preset, o);
  },
  "sessions.requirements_for": async ([preset, cfg]) => {
    sessionsDeps();
    return S.requirementsFor(preset, cfg);
  },
  "sessions.run_preflight": async ([preset, cfg, fake, reg, port]) => {
    sessionsDeps();
    const out = await S.runPreflight(preset, cfg, fake, reg, port);
    for (const c of out.checks) if (c.id === "recording") c.detail = "<debug dir>";
    return out;
  },
  "sessions.versions_snapshot": ([reg]) => {
    sessionsDeps();
    const v = S.versionsSnapshot(reg);
    delete v.wrapperGit;
    return v;
  },
  "netcheck.probe": async ([conn, lost, warm, err]) => {
    setFakeTime(1_790_100_000.0);
    NC.deps.connects = async () => [conn, lost];
    NC.deps.warm = async () => [warm, err];
    return NC.probe();
  },
  "balances.fmt": ([c]) => BAL.fmt(c),
  "cp_feed.card": ([c]) => CPF.card(c),
  "cp_feed.glyph": ([c]) => CPF.glyph(c),
  "cp_feed.positions": ([d, b]) => CPF.positions(d, b),
  "cp_feed._line_time": ([s]) => {
    setFakeTime(1_790_000_000.0);
    return CPF.lineTime(s);
  },
  "coinpoker.label": ([room, props]) => CPSite.label(room, props),
  "coinpoker._format_for": ([props]) => CPSite.formatFor(props),
  "coinpoker.FORMATS": () => CP_FORMATS,
  "cp_actions.parse_amount": ([t]) => CPA.parseAmount(t),
  "cp_actions._fmt": ([v]) => CPA.fmtAmount(v),
  "balances.record": () => onBalDb(() => {
    setFakeTime(1_790_100_000.0);
    const rows = [];
    for (const [p, a, src, sid, ph, how, raw, ip] of [
      ["brady", 100000, "scraped", "s1", "open", "header", "Balance: $1,000.00", null],
      ["brady", 99000, "scraped", "s1", "close", "header", "x".repeat(300), 1500],
      ["other", 5, "seed", null, null, null, null, 0],
    ] as const) {
      setFakeTime(time() + 60);
      rows.push(BAL.record(p, a, src, sid, ph, how, raw, "USD", ip));
    }
    return rows;
  }),
  "balances.latest": ([p]) => onBalDb(() => BAL.latest(p)),
  "balances.history": ([p, n]) => onBalDb(() => BAL.history(p, n)),
  "balances.for_session": ([sid]) => onBalDb(() => BAL.forSession(sid)),
};
