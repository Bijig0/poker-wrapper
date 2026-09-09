/**
 * Game-state tester API + the spec stepper. Ported from the dashboard app's
 * lib/stateTesterApi.ts and lib/specStepper.ts.
 *
 * The wrapper renders an authored spec as the real DOM contract, so the study
 * tools read it exactly as they read a live table. See CONTRACT.md and
 * ignition-study-wrapper/faketable.py.
 */

/**
 * The TEST rig. 7700 is the LIVE rig — pointing the State Tester at it would
 * push authored spots into a wrapper that may be sitting at a real table.
 *
 * Overridable from the page via ?wrapper= so a differently-ported rig can be
 * driven without a rebuild — the old build took this from a Vite env var,
 * which no longer exists now that these pages are served as plain files.
 */
const params = new URLSearchParams(location.search);
export const WRAPPER = params.get("wrapper") ?? "http://127.0.0.1:7701";

async function post(path, body) {
  const r = await fetch(WRAPPER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
}

/** Render the spec and enter test mode. */
export const loadState = (spec) => post("/faketable/load", spec);

/** Leave test mode; live reading resumes. */
export const stopTest = () => post("/faketable/stop");

/** Ask the relay for an action, exactly as the panel's buttons do. */
export const relay = (label, kind = "action") => post("/act", { label, kind });

/** What the fake page recorded as the last control actually pressed. */
export async function lastClick() {
  const r = await fetch(`${WRAPPER}/faketable/lastclick`);
  return (await r.json()).click ?? null;
}

/** The parsed hand the study tools would consume for the loaded state. */
export async function fetchHand() {
  const r = await fetch(`${WRAPPER}/hand`);
  return (await r.json()).hand ?? null;
}

/**
 * The spec the fake table is showing RIGHT NOW (e.g. a Solve Audit row that
 * was clicked onto it) — null when the table is not in test mode.
 */
export async function fetchCurrentSpec() {
  const r = await fetch(`${WRAPPER}/faketable/current`);
  return (await r.json()).spec ?? null;
}

/**
 * The STUDY ANSWER for the loaded state — the exact call the panel's poller
 * makes: the wrapper's /hand into the fast-solver (local charts preflop, GTO
 * Wizard AI postflop). Returns the route's whole payload so the caller can
 * show source, warnings and the node beside the verdict.
 *
 * Same-origin now: this page is served by the API that owns /api/fast-solver.
 */
export async function fetchStudyAnswer(strategy) {
  const hand = await fetchHand();
  if (!hand) return { ok: false, error: "no hand on the fake table — push a state first" };
  const r = await fetch("/api/fast-solver", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hand, ...(strategy ? { strategy } : {}) }),
  });
  return r.json();
}

export const fakeTableUrl = `${WRAPPER}/faketable`;

/** The suite's fixtures — authored spots and regression cases are one set. */
export async function fetchFixtures() {
  const r = await fetch(`${WRAPPER}/faketable/fixtures`);
  const j = await r.json();
  return j.ok ? j.fixtures : [];
}

/** Write a fixture into tests/fixtures/, so the suite picks it up. */
export const saveFixture = (name, fixture) => post("/faketable/fixture", { name, fixture });

/* ------------------------------------------------------- spec stepper --- */

/**
 * Walk an authored spot BACKWARDS AND FORWARDS through its own action list.
 *
 * A spec is authored at its decision point, but its node.actions carry the
 * whole story that led there — posts, folds, raises, calls, street bets. This
 * replays that story deterministically: step k is the table as it stood after
 * the first k actions, with stacks, bets-in-front, badges, pot and board all
 * derived, and the FINAL step is the authored spec verbatim (offer, timer and
 * all).
 *
 * Amount conventions match the fixtures and the wrapper's fake node builder:
 * posts, bets and raises are the seat's TOTAL for that street; calls are the
 * INCREMENT added. Starting stacks are recovered from the authored stacks plus
 * everything the actions say each seat put in — so the walk is consistent with
 * the endpoint by construction, whatever the authoring conventions were.
 */
const STREET_N = { preflop: 0, flop: 3, turn: 4, river: 5 };
const BADGE = {
  "post-sb": "POST SB", "post-bb": "POST BB", fold: "FOLD", check: "CHECK",
  call: "CALL", bet: "BET", raise: "RAISE", "all-in": "ALL-IN",
};

const round2 = (v) => Math.round(v * 100) / 100;

function describe(a, posOf) {
  const who = posOf(a.seat);
  switch (a.type) {
    case "post-sb": return `${who} posts SB ${a.amount ?? ""}`;
    case "post-bb": return `${who} posts BB ${a.amount ?? ""}`;
    case "fold": return `${who} folds`;
    case "check": return `${who} checks`;
    case "call": return `${who} calls ${a.amount ?? ""}`;
    case "bet": return `${who} bets ${a.amount ?? ""}`;
    case "raise": return `${who} raises to ${a.amount ?? ""}`;
    case "all-in": return `${who} is all-in ${a.amount ?? ""}`;
    default: return `${who} ${a.type}`;
  }
}

/** Position names for labels, derived like the wrapper does (dealer = BTN). */
function positionNamer(spec) {
  const dealt = (spec.node?.dealt ?? Object.keys(spec.seats).map(Number)).slice().sort((a, b) => a - b);
  const btn = spec.dealerSeat;
  if (btn == null || !dealt.length) return (s) => `seat ${s}`;
  const ring = [...new Set([...dealt, btn])].sort((a, b) => a - b);
  const i = ring.indexOf(btn);
  const order = [...ring.slice(i + 1), ...ring.slice(0, i + 1)]; // SB … BTN
  const n = order.length;
  const names =
    n === 2 ? ["SB", "BB"]
    : n === 3 ? ["SB", "BB", "BTN"]
    : ["SB", "BB", ...(n > 6 ? ["UTG", "UTG1", "UTG2", "LJ", "HJ", "CO"] : ["UTG", "HJ", "CO"]).slice(-(n - 3)), "BTN"];
  const map = new Map(order.map((s, k) => [s, names[k]]));
  return (s) => map.get(s) ?? `seat ${s}`;
}

export function stepsOf(spec) {
  const actions = (spec.node?.actions ?? []).map((a) => ({ ...a, street: a.street ?? "preflop" }));
  if (!actions.length) return [{ label: "authored state", spec }];

  const posOf = positionNamer(spec);
  const seatNums = Object.keys(spec.seats).map(Number);

  // Recover each seat's total contribution across the whole story, so the
  // authored (current) stacks can be rolled back to starting stacks.
  const totalPut = new Map();
  {
    const street = new Map(); // seat -> committed this street
    let cur = "preflop";
    const bank = (s, v) => totalPut.set(s, (totalPut.get(s) ?? 0) + v);
    const flushStreet = () => {
      for (const [s, v] of street) bank(s, v);
      street.clear();
    };
    for (const a of actions) {
      if (a.street !== cur) { flushStreet(); cur = a.street; }
      const amt = a.amount ?? 0;
      if (a.type === "call") street.set(a.seat, (street.get(a.seat) ?? 0) + amt);
      else if (amt) street.set(a.seat, amt);
    }
    flushStreet();
  }
  const startStack = new Map();
  for (const n of seatNums) {
    const s = spec.seats[String(n)] ?? {};
    startStack.set(n, round2((s.stack ?? 0) + (totalPut.get(n) ?? 0)));
  }

  // Now replay, emitting a step after each action.
  const steps = [];
  const folded = new Set();
  const streetPut = new Map();
  const putSoFar = new Map();
  const badge = new Map();
  let potBase = 0;
  let curStreet = "preflop";

  const snapshot = (label) => {
    const seats = {};
    for (const n of seatNums) {
      const authored = spec.seats[String(n)] ?? {};
      if (authored.empty) { seats[String(n)] = { ...authored }; continue; }
      const bet = streetPut.get(n) ?? 0;
      const st = {
        stack: round2((startStack.get(n) ?? 0) - (putSoFar.get(n) ?? 0) - bet),
        cards: folded.has(n) ? 0 : authored.cards ?? 0,
      };
      if (bet) st.bet = round2(bet);
      const b = folded.has(n) ? "FOLD" : badge.get(n);
      if (b) st.badge = b;
      seats[String(n)] = st;
    }
    const boardN = STREET_N[curStreet] ?? 0;
    return {
      label,
      spec: {
        ...spec,
        potBB: round2(potBase + [...streetPut.values()].reduce((a, b) => a + b, 0)),
        board: (spec.board ?? []).slice(0, boardN),
        seats,
        offer: undefined,           // no decision strip mid-story
        node: {
          ...(spec.node ?? {}),
          toActSeat: undefined,     // set by the caller for push-a-step
          committed: Object.fromEntries([...streetPut].map(([s, v]) => [String(s), v])),
          maxBet: Math.max(0, ...streetPut.values()),
          actions: [],              // filled by the caller for push-a-step
        },
      },
    };
  };

  steps.push(snapshot("hand start"));
  actions.forEach((a, i) => {
    if (a.street !== curStreet) {
      // street change: bets sweep into the pot, badges clear, board runs out
      for (const [, v] of streetPut) potBase += v;
      for (const [s, v] of streetPut) putSoFar.set(s, (putSoFar.get(s) ?? 0) + v);
      streetPut.clear();
      badge.clear();
      curStreet = a.street;
    }
    const amt = a.amount ?? 0;
    if (a.type === "fold") folded.add(a.seat);
    else if (a.type === "call") streetPut.set(a.seat, (streetPut.get(a.seat) ?? 0) + amt);
    else if (amt) streetPut.set(a.seat, amt);
    if (a.type !== "fold") badge.set(a.seat, BADGE[a.type] ?? a.type.toUpperCase());
    const step = snapshot(describe(a, posOf));
    // give push-a-step a coherent node: the story so far, next actor to act
    step.spec.node = {
      ...step.spec.node,
      actions: actions.slice(0, i + 1),
      toActSeat: actions[i + 1]?.seat ?? spec.node?.toActSeat,
    };
    steps.push(step);
  });

  // the authored decision point, verbatim — offer, timer, full board
  steps.push({ label: "authored decision point", spec });
  return steps;
}

/* ---------------------------------------------------- spec -> replica --- */

/**
 * Draw the authored spec with the replica, so the spot is visible as a table.
 *
 * The replica has no 3-max seat map because the client has no 3-max layout:
 * three players sit on the six-slot ring at the bottom chair and the two lower
 * side chairs. So a 3-max spec draws as a 6-max table with its seats mapped
 * onto slots 0, 1 and 5 — the same three the fake table uses.
 */
export function specToSpot(spec) {
  const short = spec.capacity <= 3;
  const cap = spec.capacity > 6 ? 9 : 6;
  const nSeats = short ? 3 : cap;
  const slotFor = short ? [0, 1, 5] : null;
  const hero = spec.heroSeat ?? 1;
  const seats = [];
  const order = [];
  for (let i = 0; i < nSeats; i++) order.push(((hero - 1 + i) % nSeats) + 1);
  order.forEach((numSeat, i) => {
    const slot = slotFor ? slotFor[i] : i;
    const s = spec.seats[String(numSeat)];
    if (!s || s.empty) {
      seats.push({ slot, status: "empty" });
      return;
    }
    const isHero = numSeat === hero;
    seats.push({
      slot,
      status: spec.node?.toActSeat === numSeat ? "acting"
        : (s.cards ?? 0) === 0 ? "folded"
        : "active",
      seatNo: numSeat,
      stackBB: s.stack,
      betBB: s.bet,
      action: s.badge || undefined,
      timer: s.timer,
      cards: isHero ? spec.heroCards : (s.cards ?? 0) > 0 ? undefined : [],
      isHero: isHero || undefined,
      isDealer: numSeat === spec.dealerSeat || undefined,
    });
  });

  const btn = [];
  if (spec.offer?.fold) btn.push("FOLD");
  if (spec.offer?.check) btn.push("CHECK");
  if (spec.offer?.call != null) btn.push(`CALL\n${spec.offer.call} BB`);
  if (spec.offer?.bet != null) btn.push(`BET\n${spec.offer.bet} BB`);

  return {
    capacity: cap,
    title: spec.title,
    potBB: spec.potBB,
    board: spec.board ?? [],
    seats: seats.sort((a, b) => a.slot - b.slot),
    handStrength: spec.handStrength,
    actions: btn.length || spec.offer?.raise != null
      ? {
          buttons: btn,
          raise: spec.offer?.raise != null ? `RAISE TO\n${spec.offer.raise} BB` : undefined,
        }
      : undefined,
  };
}
