/**
 * Visual spot editor — ported from the dashboard app's
 * components/table/spot-editor.tsx.
 *
 * Authoring is visual (a card picker plus per-seat fields) because a raw JSON
 * blob gave no clue what could be configured.
 *
 * Porting note: React re-rendered this on every keystroke and reconciliation
 * kept the caret where it was. Rebuilding the DOM here would drop focus
 * mid-type, so the editor is built ONCE and its inputs mutate the model in
 * place. Only a structural change (capacity, which alters the number of seat
 * rows) rebuilds a section, and only that section.
 */
import { SEAT_MAPS } from "./table-spec.js";

const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
const SUITS = [
  { s: "s", glyph: "♠", red: false },
  { s: "h", glyph: "♥", red: true },
  { s: "d", glyph: "♦", red: true },
  { s: "c", glyph: "♣", red: false },
];
const STATUSES = ["empty", "active", "folded", "acting"];

const RED = "#e2483f";
const BLK = "#1b2426";

/** Every card already placed elsewhere on the table — a real table has no dupes. */
export function usedCards(spot, except) {
  const out = new Set();
  (spot.board ?? []).forEach((c, i) => {
    if (`board-${i}` !== except) out.add(c);
  });
  (spot.seats ?? []).forEach((s) =>
    (s.cards ?? []).forEach((c, i) => {
      if (`seat-${s.slot}-${i}` !== except) out.add(c);
    })
  );
  return out;
}

/** Close whichever picker is open, wherever it is on the page. */
function closeAllPickers(root = document) {
  root.querySelectorAll(".cs-pop").forEach((p) => p.remove());
  root.querySelectorAll(".cs-btn.open").forEach((b) => b.classList.remove("open"));
}
document.addEventListener("click", (e) => {
  if (!e.target.closest?.(".cs")) closeAllPickers();
});

/**
 * One card button that opens a 52-card picker.
 *
 * `getUsed` is a callback, not a value: the set of taken cards changes as the
 * user fills other slots, and a snapshot taken at build time would go stale
 * and start allowing duplicates.
 */
export function cardSlot({ value, getUsed, onPick }) {
  const wrap = document.createElement("div");
  wrap.className = "cs";
  wrap.style.position = "relative";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cs-btn";
  wrap.appendChild(btn);

  let current = value;

  function paint() {
    const suit = current ? SUITS.find((s) => s.s === current.slice(-1).toLowerCase()) : null;
    btn.innerHTML = current
      ? `<span style="line-height:1">${current[0]}<br>${suit?.glyph ?? ""}</span>`
      : "+";
    btn.style.color = current ? (suit?.red ? RED : BLK) : "";
    btn.classList.toggle("filled", !!current);
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    const isOpen = btn.classList.contains("open");
    closeAllPickers();
    if (isOpen) return;
    btn.classList.add("open");

    const used = getUsed();
    const pop = document.createElement("div");
    pop.className = "cs-pop";

    const head = document.createElement("div");
    head.className = "cs-pop-head";
    head.innerHTML = `<span>Pick a card</span>`;
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "cs-clear";
    clear.textContent = "clear";
    clear.onclick = (ev) => {
      ev.stopPropagation();
      current = undefined;
      paint();
      onPick(null);
      closeAllPickers();
    };
    head.appendChild(clear);
    pop.appendChild(head);

    for (const { s, glyph, red } of SUITS) {
      const row = document.createElement("div");
      row.className = "cs-row";
      for (const r of RANKS) {
        const code = r + s;
        const taken = used.has(code) && code !== current;
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = r;
        b.disabled = taken;
        b.className = "cs-pick" + (code === current ? " sel" : "");
        b.title = taken ? `${code} already on the table` : code;
        if (!taken && red) b.style.color = RED;
        b.onclick = (ev) => {
          ev.stopPropagation();
          current = code;
          paint();
          onPick(code);
          closeAllPickers();
        };
        row.appendChild(b);
      }
      const g = document.createElement("span");
      g.className = "cs-suit";
      g.textContent = glyph;
      if (red) g.style.color = RED;
      row.appendChild(g);
      pop.appendChild(row);
    }
    wrap.appendChild(pop);
  };

  paint();
  return { node: wrap, set: (v) => { current = v; paint(); } };
}

/* ------------------------------------------------------------------ editor */

const numOrUndef = (v) => (v === "" ? undefined : Number(v));

function field(label, control, span) {
  const l = document.createElement("label");
  l.className = "fld";
  if (span) l.style.gridColumn = `span ${span}`;
  const s = document.createElement("span");
  s.className = "fld-l";
  s.textContent = label;
  l.appendChild(s);
  l.appendChild(control);
  return l;
}

function input(props = {}) {
  const i = document.createElement("input");
  i.type = props.type ?? "text";
  if (props.step) i.step = props.step;
  if (props.placeholder) i.placeholder = props.placeholder;
  i.value = props.value ?? "";
  if (props.cls) i.className = props.cls;
  return i;
}

/**
 * Build the editor into `host`. `onChange` receives a fresh spot object on
 * every edit; the caller redraws the table from it but must NOT re-mount the
 * editor, or typing would be interrupted.
 */
export function mountSpotEditor(host, spot, onChange) {
  host.textContent = "";
  host.className = "spot-ed";

  // The live model. Mutated in place, cloned on the way out so the caller
  // always gets a value it can keep.
  const model = structuredClone(spot);
  const emit = () => onChange(structuredClone(model));

  const seatCount = () => SEAT_MAPS[model.capacity]?.length ?? 6;

  /** Always one row per physical slot, even if the spot omits some. */
  const rowsOf = () =>
    Array.from({ length: seatCount() }, (_, slot) =>
      model.seats.find((s) => s.slot === slot) ?? { slot, status: "empty" }
    );

  /** Normalise `model.seats` to exactly one entry per slot. */
  const syncSeats = () => { model.seats = rowsOf(); };

  /* -------------------------------------------------------------- table */
  const top = document.createElement("div");
  top.className = "ed-grid4";

  const capWrap = document.createElement("div");
  capWrap.className = "row";
  const capBtns = [6, 9].map((n) => {
    const b = document.createElement("button");
    b.className = "mini" + (model.capacity === n ? " on" : "");
    b.style.flex = "1";
    b.textContent = `${n}-max`;
    b.onclick = () => {
      model.capacity = n;
      capBtns.forEach((x, i) => x.classList.toggle("on", [6, 9][i] === n));
      syncSeats();
      buildSeats();
      emit();
    };
    capWrap.appendChild(b);
    return b;
  });
  top.appendChild(field("Seats", capWrap));

  const potIn = input({ type: "number", step: "0.1", value: model.potBB ?? "" });
  potIn.oninput = () => { model.potBB = numOrUndef(potIn.value); emit(); };
  top.appendChild(field("Pot (BB)", potIn));

  const titleIn = input({ value: model.title ?? "", placeholder: "$1/$2 No Limit Hold'em" });
  titleIn.oninput = () => { model.title = titleIn.value || undefined; emit(); };
  top.appendChild(field("Title", titleIn, 2));

  host.appendChild(top);

  /* -------------------------------------------------------------- board */
  const boardSec = document.createElement("div");
  boardSec.innerHTML = `<div class="fld-l" style="margin-bottom:6px">Board</div>`;
  const boardRow = document.createElement("div");
  boardRow.className = "row";
  const boardCount = document.createElement("div");
  boardCount.className = "sub";
  boardCount.style.marginLeft = "8px";

  const paintBoardCount = () => {
    const n = model.board?.length ?? 0;
    boardCount.textContent = n === 0 ? "preflop" : `${n} card${n > 1 ? "s" : ""}`;
  };

  const boardSlots = [0, 1, 2, 3, 4].map((i) => {
    const cs = cardSlot({
      value: model.board?.[i],
      getUsed: () => usedCards(model, `board-${i}`),
      onPick: (code) => {
        const board = [...(model.board ?? [])];
        if (code === null) board.splice(i, 1);
        else board[i] = code;
        model.board = board.filter(Boolean);
        boardSlots.forEach((s, k) => s.set(model.board[k]));
        paintBoardCount();
        emit();
      },
    });
    boardRow.appendChild(cs.node);
    return cs;
  });
  boardRow.appendChild(boardCount);
  paintBoardCount();
  boardSec.appendChild(boardRow);
  host.appendChild(boardSec);

  /* -------------------------------------------------------------- seats */
  const seatsSec = document.createElement("div");
  seatsSec.innerHTML =
    `<div class="fld-l" style="margin-bottom:6px">Seats — slot 0 is always hero's screen position</div>`;
  const seatsBox = document.createElement("div");
  seatsSec.appendChild(seatsBox);
  host.appendChild(seatsSec);

  function buildSeats() {
    seatsBox.textContent = "";
    syncSeats();

    for (const seat of model.seats) {
      const card = document.createElement("div");
      card.className = "seat-row" + (seat.status === "empty" ? " off" : "");

      /* line 1 — who and what they hold */
      const l1 = document.createElement("div");
      l1.className = "row";

      const num = document.createElement("span");
      num.className = "seat-n";
      num.textContent = seat.slot;
      l1.appendChild(num);

      const sel = document.createElement("select");
      STATUSES.forEach((s) => {
        const o = document.createElement("option");
        o.value = s; o.textContent = s;
        if (s === seat.status) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = () => {
        seat.status = sel.value;
        card.classList.toggle("off", seat.status === "empty");
        emit();
      };
      l1.appendChild(sel);

      const cardsWrap = document.createElement("div");
      cardsWrap.className = "row";
      const slots = [0, 1].map((i) => {
        const cs = cardSlot({
          value: seat.cards?.[i],
          getUsed: () => usedCards(model, `seat-${seat.slot}-${i}`),
          onPick: (code) => {
            const cards = [...(seat.cards ?? [])];
            if (code === null) cards.splice(i, 1);
            else cards[i] = code;
            seat.cards = cards.filter(Boolean);
            slots.forEach((s, k) => s.set(seat.cards[k]));
            maybeSeat();
            emit();
          },
        });
        cardsWrap.appendChild(cs.node);
        return cs;
      });
      l1.appendChild(cardsWrap);

      const tags = document.createElement("div");
      tags.className = "row";
      tags.style.marginLeft = "auto";

      const heroBtn = document.createElement("button");
      heroBtn.className = "mini" + (seat.isHero ? " on" : "");
      heroBtn.textContent = "hero";
      heroBtn.onclick = () => {
        const on = !seat.isHero;
        model.seats.forEach((r) => { r.isHero = r.slot === seat.slot ? on : false; });
        seatsBox.querySelectorAll("[data-tag=hero]").forEach((b) =>
          b.classList.toggle("on", +b.dataset.slot === seat.slot && on));
        emit();
      };
      heroBtn.dataset.tag = "hero";
      heroBtn.dataset.slot = seat.slot;
      tags.appendChild(heroBtn);

      const dBtn = document.createElement("button");
      dBtn.className = "mini" + (seat.isDealer ? " on" : "");
      dBtn.textContent = "D";
      dBtn.onclick = () => {
        const on = !seat.isDealer;
        model.seats.forEach((r) => { r.isDealer = r.slot === seat.slot ? on : false; });
        seatsBox.querySelectorAll("[data-tag=dealer]").forEach((b) =>
          b.classList.toggle("on", +b.dataset.slot === seat.slot && on));
        emit();
      };
      dBtn.dataset.tag = "dealer";
      dBtn.dataset.slot = seat.slot;
      tags.appendChild(dBtn);

      l1.appendChild(tags);
      card.appendChild(l1);

      /* line 2 — the numbers, with room to actually type */
      const l2 = document.createElement("div");
      l2.className = "ed-grid5";

      /**
       * Entering a stack, seat number or card on an empty chair seats the
       * player — otherwise the fields look editable but do nothing visible.
       */
      function maybeSeat() {
        if (seat.status !== "empty") return;
        if (seat.stackBB != null || seat.seatNo != null || seat.cards?.length) {
          seat.status = "active";
          sel.value = "active";
          card.classList.remove("off");
        }
      }

      const mk = (label, key, step) => {
        const i = input({ type: "number", step, value: seat[key] ?? "" });
        i.oninput = () => { seat[key] = numOrUndef(i.value); maybeSeat(); emit(); };
        l2.appendChild(field(label, i));
      };
      mk("seat #", "seatNo");
      mk("stack", "stackBB", "0.1");
      mk("bet", "betBB", "0.1");
      mk("timer", "timer");

      const act = input({ placeholder: "FOLD", value: seat.action ?? "" });
      act.oninput = () => { seat.action = act.value || undefined; emit(); };
      l2.appendChild(field("action", act));

      card.appendChild(l2);
      seatsBox.appendChild(card);
    }
  }
  buildSeats();

  /* ------------------------------------------------------------ actions */
  const acts = document.createElement("div");
  acts.className = "ed-grid2";

  const btnsIn = input({
    placeholder: "FOLD, CALL 6.4 BB",
    value: (model.actions?.buttons ?? []).join(", "),
  });
  btnsIn.oninput = () => {
    const buttons = btnsIn.value.split(",").map((s) => s.trim()).filter(Boolean);
    model.actions = buttons.length || model.actions?.raise
      ? { ...model.actions, buttons }
      : undefined;
    emit();
  };
  acts.appendChild(field("Action buttons (comma separated)", btnsIn));

  const raiseIn = input({ placeholder: "RAISE TO 13.8 BB", value: model.actions?.raise ?? "" });
  raiseIn.oninput = () => {
    model.actions = { ...model.actions, raise: raiseIn.value || undefined };
    emit();
  };
  acts.appendChild(field("Raise button", raiseIn));

  host.appendChild(acts);
}
