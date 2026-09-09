/**
 * What the READER extracted, as a GAME STATE. Ported from the dashboard app's
 * reader-extract.tsx.
 *
 * Not the replica. The replica is a faithful redrawing of the client, which
 * makes it useless for judging the reader: it invents geometry and art of its
 * own, so a wrong-looking table might be a misparse or a misdraw and nothing
 * on screen says which. Worse, it renders "no bet found" and "bet of zero"
 * identically, which is how two unread blind posts sat in a recording looking
 * entirely normal.
 *
 * Three rules:
 *
 *   ABSENCE IS DRAWN — a field the reader returned nothing for shows a dashed
 *   em-dash, never blank space.
 *
 *   THE HAND IS NARRATED — the reader's own play-by-play sits beside the
 *   seats. A list of stacks and bets does not tell you the action folded round
 *   to the small blind; the feed does, and it was already in every tick.
 *
 *   THE EXTRACT CHECKS ITSELF — where the reader's own fields disagree, that
 *   is stated outright. Those contradictions are the reader's, provable
 *   without looking at the frame at all.
 */

const NBSP = "—";

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** Acting order runs clockwise from the bottom, so it reads like a client
 *  without pretending to be a picture of one. */
function slotPos(i, n) {
  const deg = 90 + (i * 360) / n;
  const rad = (deg * Math.PI) / 180;
  return { left: `${50 + 40 * Math.cos(rad)}%`, top: `${50 + 36 * Math.sin(rad)}%` };
}

const num = (v) => {
  if (v == null) return null;
  const m = String(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};

function field(label, value) {
  const missing = value === null || value === undefined || value === "";
  return `<div class="rx-f"><span class="rx-k">${esc(label)}</span>` +
    `<span class="rx-v${missing ? " miss" : ""}">${missing ? NBSP : esc(value)}</span></div>`;
}

/** Seats the feed says folded this hand — the narrative's own claim. */
function foldedInFeed(feed) {
  const out = new Set();
  for (const line of feed) {
    const m = line.match(/seat\s+(\d+)\s+folds/i);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

/** Contradictions inside the reader's OWN output — no frame needed. */
function selfChecks(tick, heroSeat) {
  const out = [];
  const seats = tick.seats ?? {};
  const feedFolds = foldedInFeed(tick.feedTail ?? []);

  for (const [n, s] of Object.entries(seats)) {
    const cards = s.cards ?? 0;
    if (s.badge === "FOLD" && cards > 0)
      out.push(`seat ${n}: FOLD badge but still holds ${cards} cards`);
    if (feedFolds.has(Number(n)) && cards > 0 && s.badge !== "FOLD")
      out.push(`seat ${n}: the feed says it folded, but it shows ${cards} cards and no badge`);
    if (cards !== 0 && cards !== 2)
      out.push(`seat ${n}: ${cards} cards — a hold'em seat holds 0 or 2`);
  }

  const bets = Object.values(seats).reduce((a, s) => a + (num(s.bet) ?? 0), 0);
  const pot = num(tick.pot);
  if (pot != null && bets > pot + 0.01)
    out.push(`bets on the table (${bets}) exceed the pot (${pot})`);

  if (heroSeat == null && (tick.heroCards ?? []).length)
    out.push("hero holds cards but no seat is identifiable as hero");
  if (tick.toAct && !(tick.actions ?? []).length)
    out.push("hero is to act but no buttons were captured");
  if (!tick.toAct && (tick.actions ?? []).length)
    out.push("buttons were captured but hero is not to act");
  return out;
}

export function renderReaderExtract(host, tick) {
  host.textContent = "";
  host.className = "rx";
  if (!tick) {
    host.innerHTML = `<p class="sub" style="padding:14px">no state</p>`;
    return;
  }

  const seats = tick.seats ?? {};
  const seatNums = Object.keys(seats).map(Number).sort((a, b) => a - b);

  /*
   * Hero comes from the client's own myPlayerTag, carried through as
   * seats.hero. Older captures predate that field; for those hero is UNKNOWN
   * and says so, because the previous fallback ("the seat holding more than
   * two cards") quietly anchored the ring on seat 1 the moment hole cards
   * stopped being double-counted — drawing a villain in hero's chair with
   * every value right, which reads as though the reader invented the stacks.
   */
  const tagged = seatNums.filter((n) => seats[String(n)]?.hero);
  const heroSeat = tagged.length === 1 ? tagged[0] : null;
  const heroKnown = seatNums.some((n) => seats[String(n)]?.hero !== undefined);

  // Only rotate the ring when hero is KNOWN. Otherwise leave seats in client
  // order and label the bottom slot as such, so nothing implies a hero chair.
  const at = heroSeat != null ? seatNums.indexOf(heroSeat) : 0;
  const ordered = [...seatNums.slice(at), ...seatNums.slice(0, at)];

  const board = tick.board ?? [];
  const hero = tick.heroCards ?? [];
  const actions = tick.actions ?? [];
  const feed = tick.feedTail ?? [];
  const problems = selfChecks(tick, heroSeat);
  const feedFolds = foldedInFeed(feed);

  const street = board.length >= 5 ? "river"
    : board.length === 4 ? "turn"
    : board.length === 3 ? "flop" : "preflop";

  let html = "";

  /* the spot, in words */
  html += `<div class="rx-head">` +
    `<span class="mono"><b>hand ${esc(tick.hand ?? "?")}</b></span>` +
    `<span class="sub">${street}</span>` +
    `<span>pot <b class="mono">${esc(tick.pot ?? NBSP)}</b></span>` +
    `<span>board <b class="mono">${board.length ? esc(board.join(" ")) : NBSP}</b></span>` +
    `<span>hero <b class="mono">${hero.length ? esc(hero.join(" ")) : NBSP}</b></span>` +
    `<span>seat <b class="mono">${heroSeat != null ? heroSeat : heroKnown ? "none tagged" : "unknown"}</b></span>` +
    `<span class="rx-turn ${tick.toAct ? "on" : ""}">${tick.toAct ? "HERO TO ACT" : "waiting"}</span>` +
    `</div>`;

  if (!heroKnown) {
    html += `<p class="box warn-box">This capture predates the reader recording hero's seat, so seats are shown in client order and the bottom slot is <b>not</b> hero.</p>`;
  }

  /* the seat ring */
  html += `<div class="rx-ring">`;
  ordered.forEach((n, i) => {
    const s = seats[String(n)] ?? {};
    const cards = s.cards ?? 0;
    const isHero = n === heroSeat;
    const out = cards === 0 || s.badge === "FOLD" || feedFolds.has(n);
    const p = slotPos(i, ordered.length);
    html += `<div class="rx-seat${isHero ? " hero" : ""}${out ? " out" : ""}" style="left:${p.left};top:${p.top}">` +
      `<div class="rx-seat-h">` +
      `<span class="mono"><b>seat ${n}</b></span>` +
      (s.dealer ? `<span class="rx-d" title="dealer button, read from the client's own marker">D</span>` : "") +
      (isHero ? `<span class="rx-hero">hero</span>` : "") +
      `<span class="rx-st ${out ? "" : "live"}">${out ? "OUT" : "LIVE"}</span>` +
      `</div>` +
      field("stack", s.stack) + field("bet", s.bet) +
      field("did", s.badge) + field("cards", cards) +
      `</div>`;
  });
  html += `</div>`;

  /* the story */
  html += `<div class="box"><div class="box-h">what the reader says happened</div>`;
  html += feed.length
    ? `<ol class="feed-list">${feed.map((l) =>
        `<li class="${l.startsWith("YOUR TURN") ? "turn" : ""}">${esc(l)}</li>`).join("")}</ol>`
    : `<span class="mono miss">${NBSP} nothing recorded</span>`;
  html += `</div>`;

  html += `<div class="box"><div class="box-h">buttons offered</div>`;
  html += actions.length
    ? `<div class="row">${actions.map((a) => `<span class="chip">${esc(a)}</span>`).join("")}</div>`
    : `<span class="mono miss">${NBSP} none</span>`;
  html += `</div>`;

  /* the extract against itself */
  if (problems.length) {
    html += `<div class="box bad-box"><div class="box-h">this extract contradicts itself (${problems.length})</div>` +
      `<ul class="notes">${problems.map((p) => `<li>· ${esc(p)}</li>`).join("")}</ul>` +
      `<p class="sub" style="margin-top:4px">These are reader faults by construction — no frame needed to call them.</p></div>`;
  }

  html += `<p class="sub">Every field the reader returned, with ${NBSP} wherever it returned nothing. A difference from the frame is the reader's, not the replica's.</p>`;

  host.innerHTML = html;
}
