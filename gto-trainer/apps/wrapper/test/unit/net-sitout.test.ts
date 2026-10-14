/**
 * THE CONNECTION GUARD'S "Sit out next hand" TICK (netguard.ts ignitionSitoutNextHand → sitoutBox.ts tickSitoutBox,
 * 2026-10-09) over the fake table frame of fakeSitoutBox.ts, running the REAL page snippet (src/js/sitout.READ_JS_TMPL.js).
 *
 * session_20261008_185314 (server.log): four connection drops, each `[net] sit-out: {'ok': False, 'why': "no 'Sit out
 * next hand' box on the table"}` — hero was never sat out. The guard's read (launch.SITOUT_READ_JS_TMPL.js, now gone)
 * looked only at LEAF elements whose text was the label; the client's label is not one (the deep-stack reset's read had
 * the same pattern and the same failure, session_20261009_052537). Its walk-up also took the FIRST checkbox in any
 * ancestor — in a row shared with "Sit out next big blind" that could be the big-blind box, read or pressed for ours.
 * `oldRead` below is that logic, kept here only to show what it made of each frame.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { ignitionSitoutNextHand, netStep } from "../../src/netguard";
import { SessionStore } from "../../src/sessions";
import { sitoutBoxJs } from "../../src/sitoutBox";
import { S, resetState, seams } from "../../src/state";
import { FakeSitoutTable, FDoc, FEl, ariaRows, labelRows, sharedRow } from "./fakeSitoutBox";
import { checker, J, scratchDirs } from "./helpers";

const T0 = 1_791_032_000;
const HAND = "Sit out next hand";

/** The real tick over a fake table frame: one table, fake time (its 0.4 s waits are instant). */
async function tick(doc: FDoc, o: { clickedBefore?: boolean; visibility?: string } = {}) {
  delete process.env.TABLE_SLOT;
  delete process.env.TABLE_COUNT;
  reloadConfig();
  resetState();
  setFakeTime(T0);
  if (o.clickedBefore) S.net.sitout = { ok: true, clicked: true, at: T0 };
  const t = new FakeSitoutTable(doc);
  if (o.visibility) t.visibility = o.visibility;
  const undo = t.install();
  try {
    const res = await ignitionSitoutNextHand();
    return { res, t };
  } finally {
    undo();
    realTime();
    resetState();
  }
}

/** What the guard's read did until 2026-10-09: a leaf whose text is the label, then the first checkbox up its chain. */
function oldRead(doc: FDoc): { found: boolean; checked: boolean | null } {
  const lab = doc.body.querySelectorAll("*").find((e) => e.children.length === 0 && /^\s*sit out next hand\s*$/i.test(e.textContent)) ?? null;
  if (!lab) return { found: false, checked: null };
  for (let c: FEl | null = lab, i = 0; i < 5 && c && c !== doc.body; c = c.parentElement, i++) {
    const inp = c.querySelector("input[type=checkbox]");
    if (inp) return { found: true, checked: inp.checked };
  }
  return { found: true, checked: null };
}

test("the label is not a leaf: found by its text, the hand box pressed and read ticked; the big-blind box untouched", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const L = labelRows();
  const d = new FakeSitoutTable(L.doc).run(sitoutBoxJs(HAND, null));
  eq("found, unticked, by the box inside the label, pointing at the box", [d.found, d.checked, d.via, d.shared, d.on], [true, false, "input", false, "box"]);
  eq("  ... at the hand box's centre in page coordinates (frame 2,70; the row 20 px above the big blind's)", [d.x, d.y], [2 + 18 + 6.5, 70 + 1440 + 6.5]);
  eq("  (the old leaf-only read: nothing — the live defect)", oldRead(L.doc), { found: false, checked: null });
  const { res, t } = await tick(L.doc);
  eq("the tick: a pointer press on the hand box, ticked", [res.ok, res.clicked, res.state, res.method, L.handBox.checked], [true, true, "ticked", "point (box)", true]);
  eq("  ... one press, on our box; the big-blind box untouched", [t.presses.map((p) => p.hit), L.bbBox.checked], [["input"], false]);
  const again = await tick(L.doc);
  eq("read again: already ticked, nothing pressed", [again.res.ok, again.res.state, again.t.presses.length], [true, "already ticked", 0]);
  expect(fails).toEqual([]);
});

test("a container holding BOTH labels is rejected: its box never answers for the hand's, nor is pressed for it", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  // the row's one box is the BIG BLIND's, ticked: the old walk-up read it as ours — "already ticked" — and never sat out
  const bbBox = new FEl("input", { type: "checkbox", checked: true, rect: { x: 18, y: 1460, width: 13, height: 13 } });
  const handLab = new FEl("span", { text: HAND, rect: { x: 36, y: 1440, width: 75, height: 13 } });
  const bbLab = new FEl("span", { text: "Sit out next big blind", rect: { x: 36, y: 1460, width: 90, height: 13 } });
  const me = new FEl("div", { attrs: { "data-qa": "myPlayerTag" }, text: "Hero", rect: { x: 500, y: 600, width: 60, height: 20 } });
  const doc = new FDoc([me, new FEl("div", { rect: { x: 0, y: 1430, width: 300, height: 60 } }, [bbBox, handLab, bbLab])]);
  eq("(the old read: the big-blind box taken for the hand's, 'already ticked')", oldRead(doc), { found: true, checked: true });
  const d = new FakeSitoutTable(doc).run(sitoutBoxJs(HAND, null));
  eq("found; the shared row's box is NOT read as ours — unknown", [d.found, d.checked, d.via, d.shared, d.on], [true, null, null, true, "label"]);
  const { res, t } = await tick(doc);
  eq("the press goes to OUR label; the big-blind box stays as it was, never clicked", [t.presses.map((p) => p.hit), bbBox.checked, bbBox.clicks],
     [[`span:${HAND}`], true, 0]);
  eq("  ... the result says the state is unreadable, never 'ticked'", [res.ok, res.clicked, res.state], [true, true, "clicked (tick state unreadable - check the table)"]);
  const again = await tick(doc, { clickedBefore: true });
  eq("pressed earlier this bad stretch (S.net.sitout.clicked), state unreadable: not pressed again", [again.res.ok, again.res.state, again.t.presses.length],
     [true, "clicked earlier (tick state unreadable)", 0]);
  // the fixture's shared row (its one box the hand's, ticked): still unknown — a shared row's box is nobody's
  const Sh = sharedRow();
  const e = new FakeSitoutTable(Sh.doc).run(sitoutBoxJs(HAND, null));
  eq("the fixture's shared row: unknown too, the press on our label", [e.checked, e.shared, (await tick(Sh.doc)).t.presses.map((p) => p.hit)], [null, true, [`span:${HAND}`]]);
  expect(fails).toEqual([]);
});

test("a hidden label (display: none up its chain, [hidden], visibility: hidden, opacity 0) is not found and not clicked", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  type Rows = ReturnType<typeof labelRows>;
  const ways: [string, (L: Rows) => void][] = [
    ["display: none on the row", (L) => { L.hand.parentElement!.style.display = "none"; }],
    ["[hidden] on the label", (L) => { L.hand.hidden = true; }],
    ["visibility: hidden", (L) => { L.hand.style.visibility = "hidden"; }],
    ["opacity 0", (L) => { L.hand.style.opacity = "0"; }],
  ];
  for (const [name, hide] of ways) {
    const L = labelRows();
    hide(L);
    const { res, t } = await tick(L.doc);
    eq(`${name}: not found, nothing pressed, no DOM click, the box untouched`,
       [res.ok, res.clicked ?? false, t.presses.length, t.evals.filter((e) => e === "click").length, L.handBox.checked, L.bbBox.checked],
       [false, false, 0, 0, false, false]);
    check(`  ... says so`, /^no 'Sit out next hand' box on the table \(1 hidden by style\)$/.test(res.why), res.why);
  }
  // a hidden stale copy beside the shown one: the shown one is the one pressed
  const L = labelRows();
  const stale = new FEl("label", { text: HAND, style: { display: "none" } }, [new FEl("input", { type: "checkbox" })]);
  L.doc.body.append(stale);
  stale.doc = L.doc;
  const { res } = await tick(L.doc);
  eq("a hidden stale copy beside the shown one: the shown one ticked", [res.ok, L.handBox.checked, (stale.children[0] as FEl).checked], [true, true, false]);
  expect(fails).toEqual([]);
});

test("an undrawn frame (every box 0 x 0) or a hidden page: the label is still found, the hand box clicked through the DOM", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const A = ariaRows();
  A.doc.undrawn = true;
  const d = new FakeSitoutTable(A.doc).run(sitoutBoxJs(HAND, null));
  eq("found by text, unticked (aria), nothing to point at", [d.found, d.checked, d.via, d.x, d.y], [true, false, "aria", null, null]);
  const { res, t } = await tick(A.doc);
  eq("the tick: no pointer press, a DOM click on the hand box, ticked; the big-blind row untouched",
     [res.ok, res.clicked, res.state, t.presses.length, A.hand.box.attrs["aria-checked"], A.bb.box.attrs["aria-checked"]],
     [true, true, "ticked", 0, "true", "false"]);
  check("  ... said so", /^dom: div \(the box\) \(nothing to point at/.test(res.method), res.method);
  const B = ariaRows();
  const h = await tick(B.doc, { visibility: "hidden" });
  eq("page hidden (a parked pointer click never arrives): DOM click, ticked", [h.res.ok, h.t.presses.length, B.hand.box.attrs["aria-checked"]], [true, 0, "true"]);
  const C = ariaRows();
  const p = await tick(C.doc);
  eq("drawn: a pointer press on the aria box, the row's handler ticks it", [p.res.ok, p.res.method, p.t.presses[0]?.hit, C.hand.box.attrs["aria-checked"]],
     [true, "point (box)", "div", "true"]);
  expect(fails).toEqual([]);
});

test("through the guard: the second bad probe ticks the box on the table, the third does not press it again", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const tmp = scratchDirs("net-sitout-");
  delete process.env.TABLE_SLOT;
  delete process.env.TABLE_COUNT;
  reloadConfig();
  resetState();
  setFakeTime(T0);
  S.site.id = "ignition";
  S.fakeMode = false;
  S.sessions = new SessionStore(join(tmp, "data", "sessions.sqlite"));
  const sid = "session_20261008_netsitout_test";
  const rec = S.sessions.start(sid, "strategy:test", null, null, { tables: 1, answers: true, netGuard: true /* the sit-out is the session's choice since 2026-10-14 */ }, { ok: true }, {});
  Object.assign(S.session, { id: sid, rec, started: time() });
  const seams0 = { ...seams };
  seams.livePeers = async () => [];
  const L = labelRows();
  const t = new FakeSitoutTable(L.doc);
  const undo = t.install();
  const log0 = console.log;
  console.log = () => {};
  try {
    const BAD = { ok: false, why: ["round trip 290 ms (max 200)"], rttMs: 290 };
    await netStep(BAD);
    eq("one bad probe: nothing pressed", [t.presses.length, L.handBox.checked, S.net.sitout], [0, false, null]);
    await netStep(BAD);
    eq("two in a row: the hand box pressed and ticked; the guard keeps the press", [t.presses.map((p) => p.hit), L.handBox.checked, S.net.sitout?.clicked, S.net.sitout?.state],
       [["input"], true, true, "ticked"]);
    eq("  ... the big-blind box untouched; the drop noted", [L.bbBox.checked, S.net.drop?.sid], [false, sid]);
    await netStep(BAD);
    eq("a third: read 'already ticked', no press", [t.presses.length, S.net.sitout?.state, S.net.sitout?.clicked], [1, "already ticked", true]);
    const ev = ((S.sessions.get(sid)?.events ?? []) as any[]).filter((e: any) => e.kind === "net-sitout");
    eq("one net-sitout event, with the tick's outcome and no html", [ev.length, ev[0]?.result?.state, "html" in (ev[0]?.result ?? {})], [1, "ticked", false]);
    check("the feed says it is sitting out", S.feed.some((f: any) => /CONNECTION TOO SLOW .* sitting out next hand/.test(String(f.line))), J(S.feed.map((f: any) => f.line)));
  } finally {
    console.log = log0;
    undo();
    Object.assign(seams, seams0);
    realTime();
    resetState();
  }
  expect(fails).toEqual([]);
});
