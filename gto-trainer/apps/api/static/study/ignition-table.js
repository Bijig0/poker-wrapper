/**
 * The Ignition table replica — vanilla port of the dashboard app's
 * components/table/ignition-table.tsx, made when the study pages moved onto
 * the API server and the React build went away.
 *
 * The client scales its 800x400 table with CSS `zoom` rather than
 * `transform: scale()`. We do the same: `zoom` reflows descendants, so every
 * child keeps laying out in design units and computed geometry stays readable
 * — which is exactly the property that made the original inspectable.
 *
 * Structure follows the original component tree (CardRow / Seat / table) so
 * the two can still be diffed by eye. All geometry lives in table-spec.js.
 */
import {
  ACTION_BAR, BOARD_BOX, C, CARD_ASPECT, DESIGN, FELT, FELTS, FELT_NOISE,
  FONT, HEADER_H, MAIN_POT_PILL, OVAL, PARTS, POT_PILL, SEAT_BOX, SEAT_INSET,
  SEAT_MAPS, TYPE, bb, cardArt, chipAnchor,
} from "./table-spec.js";

/** Minimal element builder: tag, style object, extra props/children. */
function el(tag, style, props) {
  const n = document.createElement(tag);
  if (style) Object.assign(n.style, style);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else if (k === "kids") v.filter(Boolean).forEach((c) => n.appendChild(c));
      else n.setAttribute(k, v);
    }
  }
  return n;
}

const px = (n) => `${n}px`;

/* ------------------------------------------------------------------ cards */

/**
 * A row of cards laid out on a fixed pitch. Width comes from the height via
 * CARD_ASPECT, so faces are never stretched; when pitch is narrower than that
 * width the cards overlap into a fan, matching the client's hero hand.
 *
 * `cards` entries are face-up codes, or null for a card back.
 */
function cardRow({ cards, kind, w, pitch, dimmed }) {
  const h = w / CARD_ASPECT;
  const row = el("div", {
    position: "relative",
    width: px(pitch * (cards.length - 1) + w),
    height: px(h),
    opacity: dimmed ? "0.4" : "1",
  });

  cards.forEach((code, i) => {
    const slot = el("div", {
      position: "absolute",
      left: px(i * pitch),
      top: "0px",
      width: px(w),
      height: px(h),
      borderRadius: px(w * 0.09),
      overflow: "hidden",
      background: code ? "#fff" : "transparent",
      boxShadow: "0 1px 3px rgba(0,0,0,0.55)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });
    const img = el(
      "img",
      code
        ? { width: "100%", height: "100%", objectFit: "fill", display: "block" }
        : { width: "100%", height: "100%", display: "block" },
      // The client's own card back, harvested from its DOM.
      { src: code ? cardArt(code, kind) : "/ign/card-back.svg", alt: code || "", draggable: "false" }
    );
    slot.appendChild(img);
    row.appendChild(slot);
  });
  return row;
}

/* ------------------------------------------------------------------- seat */

function actionButton(label, bg, h) {
  const btn = el("div", {
    width: px(ACTION_BAR.btn.w),
    height: px(h ?? ACTION_BAR.btn.h),
    borderRadius: "8px",
    background: bg,
    color: "#fff",
    fontSize: "14px",
    fontWeight: "600",
    lineHeight: "1.15",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  });
  String(label).split("\n").forEach((l) => btn.appendChild(el("div", null, { text: l })));
  return btn;
}

function seatNode(seat, origin, chips) {
  const { pill, badge, strip, holeCard, villainCard } = PARTS;
  const hero = !!seat.isHero;
  const folded = seat.status === "folded";
  const acting = seat.status === "acting";
  const card = hero ? holeCard : villainCard;

  if (seat.status === "empty") {
    const box = el("div", {
      position: "absolute",
      left: px(origin.x),
      top: px(origin.y),
      width: px(SEAT_BOX.w),
      height: px(SEAT_BOX.h),
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "5px",
      color: "rgba(255,255,255,0.55)",
    });
    const ring = el("div", {
      width: "32px", height: "32px", borderRadius: "50%",
      border: "1.5px solid rgba(255,255,255,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }, {
      html: '<svg width="17" height="17" viewBox="0 0 24 24">' +
        '<circle cx="12" cy="8.2" r="3.6" fill="currentColor"></circle>' +
        '<path d="M4.6 20c0-4 3.3-6.2 7.4-6.2S19.4 16 19.4 20Z" fill="currentColor"></path></svg>',
    });
    box.appendChild(ring);
    box.appendChild(el("div", { fontSize: "9px", textAlign: "center", lineHeight: "1.2" },
      { html: "Vacant<br>seat" }));
    return box;
  }

  const box = el("div", {
    position: "absolute",
    left: px(origin.x),
    top: px(origin.y),
    width: px(SEAT_BOX.w),
    height: px(SEAT_BOX.h),
  });

  // Halo behind the acting seat.
  if (acting) {
    box.appendChild(el("div", {
      position: "absolute",
      left: px(SEAT_BOX.w / 2),
      top: px(pill.y + pill.h / 2),
      width: "160px", height: "160px",
      transform: "translate(-50%,-50%)",
      borderRadius: "50%",
      background: "radial-gradient(circle, rgba(255,255,255,0.13) 38%, rgba(255,255,255,0.05) 58%, transparent 68%)",
      pointerEvents: "none",
    }));
  }

  // Committed chips, in front of the seat.
  if (seat.betBB != null && seat.betBB > 0) {
    const wrap = el("div", {
      position: "absolute",
      left: px(chips.x), top: px(chips.y),
      height: px(PARTS.chipsH),
      display: "flex", alignItems: "center", gap: "3px",
    });
    wrap.appendChild(el("span", {
      background: C.chipBg, borderRadius: "9999px", padding: "0 6px",
      color: "#fff", fontSize: px(TYPE.chip.size), lineHeight: "15px", whiteSpace: "nowrap",
    }, { text: bb(seat.betBB) }));
    // The client's chip icon (31x33 viewBox), AFTER the amount.
    wrap.appendChild(el("img", { width: "14px", height: "15px", display: "block" },
      { src: "/ign/chip-icon.svg", alt: "", draggable: "false" }));
    box.appendChild(wrap);
  }

  /*
   * Hole cards, at their measured offsets. They sit behind the pill by design
   * — the pill carries a z-index so it paints over the card bottoms, exactly
   * as the client does it.
   */
  if (seat.cards?.length !== 0) {
    const holder = el("div", { position: "absolute", left: px(card.x), top: px(card.y) });
    holder.appendChild(cardRow({
      cards: seat.cards?.length ? seat.cards : [null, null],
      kind: "hole", w: card.w, pitch: card.pitch, dimmed: folded,
    }));
    box.appendChild(holder);
  }

  // Status strip, sliding out from under the pill.
  if (seat.action) {
    box.appendChild(el("div", {
      position: "absolute",
      left: px(pill.x), top: px(strip.y),
      width: px(pill.w), height: px(strip.h),
      background: folded ? C.stripFold : C.strip,
      borderRadius: strip.radius,
      color: "#fff",
      fontSize: px(TYPE.strip.size),
      fontWeight: String(TYPE.strip.weight),
      letterSpacing: "0.3px",
      display: "flex", alignItems: "center", justifyContent: "center",
      paddingTop: px(strip.h - strip.visible),
    }, { text: seat.action }));
  }

  // Countdown bar for the seat on the clock.
  if (acting && seat.timer != null) {
    const bar = el("div", {
      position: "absolute",
      left: px(pill.x),
      top: px(seat.action ? strip.y + strip.h : pill.y + pill.h),
      width: px(pill.w), height: "11px",
      background: "rgba(0,0,0,0.55)",
      borderRadius: "0 0 6px 6px",
      display: "flex", alignItems: "center", gap: "4px", padding: "0 5px",
    });
    bar.appendChild(el("span", { color: "#fff", fontSize: "8px", fontWeight: "700" },
      { text: String(seat.timer) }));
    const track = el("span", {
      flex: "1", height: "4px", borderRadius: "2px",
      background: "rgba(255,255,255,0.25)", overflow: "hidden",
    });
    track.appendChild(el("span", {
      display: "block", height: "100%",
      width: `${Math.min(100, (seat.timer / 30) * 100)}%`,
      background: C.timer,
    }));
    bar.appendChild(track);
    box.appendChild(bar);
  }

  // Stack pill.
  const pillNode = el("div", {
    position: "absolute",
    left: px(pill.x), top: px(pill.y),
    width: px(pill.w), height: px(pill.h),
    borderRadius: px(pill.radius),
    background: folded ? C.pillFolded : C.pill,
    boxShadow: "0 1px 10px 4px rgba(0,0,0,0.5)",
    display: "flex", alignItems: "center",
    zIndex: "2",
  });
  pillNode.appendChild(el("span", {
    width: px(badge.d), height: px(badge.d), marginLeft: "3px", flex: "0 0 auto",
    borderRadius: "50%",
    background: folded ? "rgba(0,201,183,0.5)" : C.badge,
    color: "#fff",
    fontSize: px(TYPE.badge.size), fontWeight: String(TYPE.badge.weight),
    display: "flex", alignItems: "center", justifyContent: "center",
  }, { text: seat.seatNo ?? "" }));
  pillNode.appendChild(el("span", {
    flex: "1", textAlign: "center", paddingRight: "6px",
    fontSize: px(TYPE.stack.size), fontWeight: String(TYPE.stack.weight),
    color: C.text, opacity: folded ? "0.7" : "1",
  }, { text: seat.stackBB != null ? bb(seat.stackBB) : "" }));
  box.appendChild(pillNode);

  if (seat.isDealer) {
    const d = el("div", {
      position: "absolute",
      left: px(origin.x > 400 ? -8 : SEAT_BOX.w - 8),
      top: px(pill.y - 6),
      width: "17px", height: "17px", borderRadius: "50%",
      background: "#e6e6e6", border: "0.5px solid rgba(0,0,0,0.3)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: "3",
    });
    d.appendChild(el("img", { width: "10px", height: "10px", display: "block" },
      { src: "/ign/dealer-d.svg", alt: "D", draggable: "false" }));
    box.appendChild(d);
  }

  return box;
}

/* ------------------------------------------------------------------ table */

/**
 * Draw `spot` into `host`, replacing whatever was there.
 *
 * Returns a handle with `.destroy()` — the zoom ResizeObserver has to be
 * disconnected when the table is torn down, or a page that redraws on every
 * tick (Replay Review does) leaks one observer per frame.
 */
export function renderTable(host, spot, opts = {}) {
  const theme = opts.theme ?? "red";
  const showSpec = !!opts.showSpec;

  host.textContent = "";
  const map = SEAT_MAPS[spot.capacity] ?? SEAT_MAPS[6];
  const board = spot.board ?? [];
  // The action bar lives in the chrome below the 800x400 felt, so it extends
  // the canvas rather than overlaying hero's seat.
  const barH = spot.actions ? ACTION_BAR.h : 0;
  const headH = spot.title ? HEADER_H : 0;

  host.style.position = "relative";
  host.style.width = "100%";
  host.style.overflow = "hidden";
  host.style.aspectRatio = `${FELT.w} / ${FELT.h + barH + headH}`;

  const stage = el("div", {
    width: px(FELT.w),
    height: px(FELT.h + barH + headH),
    position: "relative",
    background: FELTS[theme] ?? FELTS.red,
    fontFamily: FONT,
    userSelect: "none",
  });

  // Felt noise tile, verbatim from the client's stylesheet (.fs9k49k).
  stage.appendChild(el("div", {
    position: "absolute", inset: "0", backgroundImage: FELT_NOISE, pointerEvents: "none",
  }));

  /*
   * Centre watermark — the client's own flame + wordmark SVGs (data-qa=table).
   * Placement is approximate: their absolute positions were not measured, only
   * their rendered sizes (38du and 90du wide).
   */
  const mark = el("div", {
    position: "absolute",
    left: px(SEAT_INSET.x), top: px(SEAT_INSET.y),
    width: px(DESIGN.w), height: px(DESIGN.h),
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", gap: "6px",
    opacity: "0.12", pointerEvents: "none",
  });
  mark.appendChild(el("img", { width: "38px" }, { src: "/ign/watermark-flame.svg", alt: "" }));
  mark.appendChild(el("img", { width: "90px" }, { src: "/ign/watermark-text.svg", alt: "" }));
  stage.appendChild(mark);

  // Table header
  if (spot.title) {
    const head = el("div", {
      position: "absolute", left: "0px", right: "0px", top: "0px",
      height: px(HEADER_H),
      background: "rgba(0,0,0,0.45)",
      display: "flex", alignItems: "center", padding: "0 10px", gap: "8px",
      color: "rgba(255,255,255,0.9)", fontSize: "12px",
    });
    head.appendChild(el("span", { opacity: "0.6" }, { html: "&#9432;" }));
    head.appendChild(el("span", null, { text: spot.title }));
    head.appendChild(el("span", { marginLeft: "auto", opacity: "0.6" }, { html: "&#10005;" }));
    stage.appendChild(head);
  }

  // Everything below sits in the 800x400 felt, offset by the header.
  const felt = el("div", {
    position: "absolute",
    left: px(SEAT_INSET.x), top: px(headH + SEAT_INSET.y),
    width: px(DESIGN.w), height: px(DESIGN.h),
  });

  // Table oval
  felt.appendChild(el("div", {
    position: "absolute",
    left: px(OVAL.x), top: px(OVAL.y), width: px(OVAL.w), height: px(OVAL.h),
    borderRadius: "9999px",
    border: `2px solid ${C.ovalBorder}`,
    boxSizing: "border-box",
  }));

  // Pot readouts
  if (spot.potBB != null) {
    felt.appendChild(el("div", {
      position: "absolute",
      left: px(POT_PILL.x), top: px(POT_PILL.y),
      width: px(POT_PILL.w), height: px(POT_PILL.h),
      borderRadius: "9999px", background: C.potBg, color: "#fff",
      fontSize: px(TYPE.totalPot.size),
      display: "flex", alignItems: "center", justifyContent: "center",
    }, { html: `Total pot:&nbsp;<b>${bb(spot.potBB)}</b>` }));
  }
  if (spot.mainPotBB != null) {
    felt.appendChild(el("div", {
      position: "absolute",
      left: px(MAIN_POT_PILL.x), top: px(MAIN_POT_PILL.y),
      width: px(MAIN_POT_PILL.w), height: px(MAIN_POT_PILL.h),
      borderRadius: "9999px", background: C.potBg, color: "rgba(255,255,255,0.85)",
      fontSize: px(TYPE.mainPot.size),
      display: "flex", alignItems: "center", justifyContent: "center",
    }, { html: `Main pot:&nbsp;<b>${bb(spot.mainPotBB)}</b>` }));
  }

  /*
   * Community cards. The board is a STATIC five-slot rack, not a centred row:
   * the client keeps all five positions alive at x = 0, 61, 122, 183, 244 and
   * fills them left to right, so the flop never moves when the turn and river
   * land. Centring the dealt cards would slide the whole board every street.
   */
  if (board.length > 0) {
    const rack = el("div", {
      position: "absolute",
      left: px(BOARD_BOX.x), top: px(BOARD_BOX.y),
      width: px(BOARD_BOX.w), height: px(BOARD_BOX.h),
    });
    rack.appendChild(cardRow({
      cards: board, kind: "board",
      w: PARTS.boardCard.w, pitch: PARTS.boardCard.pitch,
    }));
    felt.appendChild(rack);
  }

  for (const s of spot.seats) {
    const origin = map[s.slot];
    if (!origin) continue;
    felt.appendChild(seatNode(s, origin, chipAnchor(spot.capacity, s.slot)));
  }

  if (spot.handStrength) {
    felt.appendChild(el("div", {
      position: "absolute", right: "6px", top: "330px",
      background: "rgba(0,0,0,0.4)", borderRadius: "4px", padding: "4px 8px",
      color: "#e8eded", fontSize: "10px",
    }, { text: spot.handStrength }));
  }

  stage.appendChild(felt);

  // Bottom action bar
  if (spot.actions) {
    const bar = el("div", {
      position: "absolute", left: "0px", right: "0px",
      top: px(FELT.h + headH), height: px(ACTION_BAR.h),
      background: "rgba(0,0,0,0.35)",
      display: "flex", alignItems: "center", justifyContent: "center",
      gap: px(ACTION_BAR.gap),
    });
    (spot.actions.buttons ?? []).forEach((label) =>
      bar.appendChild(actionButton(label, "rgba(0,0,0,0.55)")));
    if (spot.actions.raise) {
      const col = el("div", {
        display: "flex", flexDirection: "column", alignItems: "center", gap: "4px",
      });
      col.appendChild(actionButton(spot.actions.raise, "rgba(0,0,0,0.3)", ACTION_BAR.raise.h));
      if (spot.actions.allIn !== false) {
        col.appendChild(el("div", {
          width: px(ACTION_BAR.allIn.w), height: px(ACTION_BAR.allIn.h),
          borderRadius: "8px", background: "rgba(255,255,255,0.25)",
          color: "#fff", fontSize: "10px", fontWeight: "700",
          display: "flex", alignItems: "center", justifyContent: "center",
        }, { text: "ALL-IN" }));
      }
      bar.appendChild(col);
    }
    stage.appendChild(bar);
  }

  // Design-unit overlay
  if (showSpec) {
    const ov = el("div", { position: "absolute", inset: "0", pointerEvents: "none" });
    map.forEach((o, i) => {
      ov.appendChild(el("div", {
        position: "absolute",
        left: px(o.x + SEAT_INSET.x), top: px(o.y + headH + SEAT_INSET.y),
        width: px(SEAT_BOX.w), height: px(SEAT_BOX.h),
        border: "1px dashed rgba(120,255,220,0.65)",
        color: "rgba(120,255,220,0.95)", fontSize: "8px", padding: "1px",
      }, { text: `${i}: ${o.x},${o.y}` }));
    });
    ov.appendChild(el("div", {
      position: "absolute",
      left: px(OVAL.x + SEAT_INSET.x), top: px(OVAL.y + headH + SEAT_INSET.y),
      width: px(OVAL.w), height: px(OVAL.h),
      border: "1px dashed rgba(255,210,120,0.8)", borderRadius: "9999px",
    }));
    ov.appendChild(el("div", {
      position: "absolute", left: px(400 + SEAT_INSET.x), top: "0px", bottom: "0px",
      borderLeft: "1px dashed rgba(255,255,255,0.35)",
    }));
    ov.appendChild(el("div", {
      position: "absolute", top: px(200 + headH + SEAT_INSET.y), left: "0px", right: "0px",
      borderTop: "1px dashed rgba(255,255,255,0.35)",
    }));
    stage.appendChild(ov);
  }

  host.appendChild(stage);

  let specLabel = null;
  if (showSpec) {
    specLabel = el("div", {
      position: "absolute", left: "4px", top: px(headH + 4),
      borderRadius: "4px", background: "rgba(0,0,0,0.6)", padding: "2px 6px",
      font: "10px ui-monospace, SFMono-Regular, Menlo, monospace",
      color: "#6ee7b7",
    });
    host.appendChild(specLabel);
  }

  // Mirrors the client: one uniform factor, recomputed on resize.
  const applyZoom = (w) => {
    const z = w / FELT.w;
    stage.style.zoom = String(z);
    if (specLabel) {
      specLabel.textContent =
        `felt ${FELT.w}x${FELT.h} - seats ${DESIGN.w}x${DESIGN.h} @(${SEAT_INSET.x},${SEAT_INSET.y}) - zoom ${z.toFixed(4)}`;
      specLabel.style.top = px(headH * z + 4);
    }
  };
  const ro = new ResizeObserver(([e]) => applyZoom(e.contentRect.width));
  ro.observe(host);
  applyZoom(host.getBoundingClientRect().width || FELT.w);

  return { destroy: () => ro.disconnect(), stage };
}
