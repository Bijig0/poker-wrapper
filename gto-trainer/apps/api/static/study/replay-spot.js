/**
 * Recorded tick -> replica spot. Ported from the dashboard app's
 * lib/replaySpot.ts.
 *
 * The wrapper keys seats by CLIENT SEAT NUMBER and records no positions in
 * log.jsonl; the raw DOM carries each seat's number-badge anchor with its
 * viewport position. Slots are assigned from those anchors: hero is the
 * bottom-most anchor (the client pins the player bottom-centre and rotates
 * everyone else), and the rest map to replica slots by ANGLE around the frame
 * centre. Angle survives what absolute positions do not — this layout renders
 * at a different scale and frame size than the replica's measured 955x512
 * felt, but the ring ORDER around the centre is scale-free.
 */
import { SEAT_BOX, SEAT_MAPS } from "./table-spec.js";

/** "10♥" / "J♦" (wrapper display form) -> "Th" / "Jd" (replica card code). */
export function toCardCode(display) {
  const m = String(display).trim().match(/^(10|[2-9AKQJT])([♠♥♦♣shdc])$/i);
  if (!m) return null;
  const rank = m[1] === "10" ? "T" : m[1].toUpperCase();
  const suit = ({ "♠": "s", "♥": "h", "♦": "d", "♣": "c" })[m[2]] ?? m[2].toLowerCase();
  return rank + suit;
}

const num = (s) => {
  if (!s) return undefined;
  const m = String(s).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : undefined;
};

/** Seat-number badge anchors ("1".."9" in a small box) from the raw nodes. */
export function seatAnchors(dom) {
  const out = new Map();
  for (const n of dom.nodes ?? []) {
    if (/^[1-9]$/.test(n.text) && n.w <= 16 && n.h <= 20) {
      // Badge centre; duplicates keep the first sighting.
      if (!out.has(Number(n.text))) {
        out.set(Number(n.text), { x: n.x + n.w / 2, y: n.y + n.h / 2 });
      }
    }
  }
  return out;
}

/**
 * Assign client seat numbers to replica screen slots.
 *
 * Hero (bottom-most anchor) takes slot 0. Every other anchor takes the free
 * slot whose centre lies at the nearest angle around the table centre,
 * measured in the recorded frame for anchors and in design space for slots.
 */
export function assignSlots(anchors, frame, capacity) {
  const map = SEAT_MAPS[capacity];
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  const slotAngle = map.map((o) => {
    const sx = o.x + SEAT_BOX.w / 2 - 400; // design centre (400, 200)
    const sy = o.y + SEAT_BOX.h / 2 - 200;
    return Math.atan2(sy, sx);
  });

  const out = new Map();
  if (anchors.size === 0) return out;

  const entries = [...anchors.entries()];
  const hero = entries.reduce((a, b) => (b[1].y > a[1].y ? b : a));
  out.set(hero[0], 0);
  const taken = new Set([0]);

  const angDiff = (a, b) => {
    const d = Math.abs(a - b) % (2 * Math.PI);
    return d > Math.PI ? 2 * Math.PI - d : d;
  };

  for (const [seatNo, p] of entries) {
    if (seatNo === hero[0]) continue;
    const a = Math.atan2(p.y - cy, p.x - cx);
    let best = -1;
    let bestD = Infinity;
    for (let i = 1; i < map.length; i++) {
      if (taken.has(i)) continue;
      const d = angDiff(a, slotAngle[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { taken.add(best); out.set(seatNo, best); }
  }
  return out;
}

/** Build the replica's spot for one recorded tick. */
export function tickToSpot(log, dom) {
  const seatsIn = log.seats ?? {};
  const seatNos = Object.keys(seatsIn).map(Number);
  // The client seats 5-max and shorter on its six-slot table (it has no
  // dedicated short-handed layouts), so anything up to 6 draws on the 6-max
  // map — same convention as the replica's own 3-max preset.
  const capacity = seatNos.length > 6 ? 9 : 6;

  const anchors = dom ? seatAnchors(dom) : new Map();
  const slotOf = dom?.frame && anchors.size
    ? assignSlots(anchors, dom.frame, capacity)
    : new Map();

  const seats = [];
  const used = new Set();
  let fallback = 0;
  for (const no of seatNos.sort((a, b) => a - b)) {
    const s = seatsIn[String(no)];
    let slot = slotOf.get(no);
    if (slot === undefined || used.has(slot)) {
      while (used.has(fallback)) fallback++;
      slot = fallback;
    }
    used.add(slot);
    const isHero = slot === 0;
    const folded = (s.cards ?? 0) === 0;
    seats.push({
      slot,
      status: folded ? "folded" : isHero && log.toAct ? "acting" : "active",
      seatNo: no,
      stackBB: num(s.stack),
      betBB: num(s.bet),
      action: s.badge ?? undefined,
      // Hero shows the recorded faces; villains still in the hand show backs
      // (omitted array = backs by the renderer's contract).
      cards: isHero
        ? (log.heroCards ?? []).map(toCardCode).filter(Boolean)
        : folded ? [] : undefined,
      isHero: isHero || undefined,
    });
  }
  for (let slot = 0; slot < capacity; slot++) {
    if (!used.has(slot)) seats.push({ slot, status: "empty" });
  }

  return {
    capacity,
    title: `replay · hand ${log.hand ?? "?"} · tick ${log.seq}`,
    potBB: num(log.pot),
    board: (log.board ?? []).map(toCardCode).filter(Boolean),
    seats: seats.sort((a, b) => a.slot - b.slot),
    actions: log.toAct && log.actions?.length ? { buttons: log.actions, allIn: false } : undefined,
  };
}

/* --------------------------------------------------------------- api ----- */

/**
 * Debug-recording replay endpoints. Same-origin now that these pages are
 * served by the API itself — the old dashboard build had to name :2000
 * explicitly and pay a CORS preflight for the verdict POST.
 */
const BASE = "/api/replay";

async function get(path, what) {
  const r = await fetch(BASE + path);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error ?? `${what} unavailable`);
  return j;
}

export const fetchSessions = async () => (await get("/sessions", "sessions")).sessions;
export const fetchLog = async (name) => (await get(`/${name}/log`, "log")).ticks;
export const fetchDom = async (name) => (await get(`/${name}/dom`, "dom")).ticks;
export const fetchQueue = () => get("/queue", "queue");
export const frameUrl = (name, seq) => `${BASE}/${name}/frame/${seq}`;

/**
 * Records ONE side; the server merges, so a replica call never clears a
 * reader verdict recorded in an earlier pass.
 */
export async function saveVerdict(id, patch) {
  const r = await fetch(`${BASE}/verdict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...patch }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error ?? "could not save");
  return j.verdict;
}
