(() => {__FRAME__
  const SLOT = __SLOT__;
  const tf = __frame(SLOT);          // never the lobby frame: it carries no playMode
  if (!tf) return {seated: false, slot: SLOT};
  let doc = null;
  try { doc = tf.contentDocument; } catch (e) {}
  if (!doc || !doc.body) return {seated: false};
  const fb = tf.getBoundingClientRect();
  const out = [];
  const walk = (d, ox, oy) => {
    // Skip INVISIBLE text: the client leaves stale labels (old FOLD badges,
    // 0 BB bets) in the DOM at opacity 0 / visibility hidden, and reading
    // them corrupts the seat parse. Computed visibility is already resolved
    // per element; opacity must be checked up the ancestor chain (memoized).
    const view = d.defaultView;
    const opCache = new Map();
    const opOk = el => {
      if (!el || el === d.body) return true;
      if (opCache.has(el)) return opCache.get(el);
      const ok = +view.getComputedStyle(el).opacity >= 0.5 && opOk(el.parentElement);
      opCache.set(el, ok);
      return ok;
    };
    const wk = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = wk.nextNode())) {
      const s = (n.nodeValue || '').trim();
      if (!s || s.length > 90) continue;
      const pe = n.parentElement;
      if (!pe || view.getComputedStyle(pe).visibility !== 'visible' || !opOk(pe)) continue;
      const r = d.createRange(); r.selectNodeContents(n);
      const b = r.getBoundingClientRect();
      if (b.width > 0 && b.height > 0)
        out.push({text: s, x: Math.round(b.x + ox), y: Math.round(b.y + oy),
                  w: Math.round(b.width), h: Math.round(b.height)});
    }
    for (const f of d.querySelectorAll('iframe')) {
      try { const r = f.getBoundingClientRect();
            if (f.contentDocument) walk(f.contentDocument, ox + r.x, oy + r.y); } catch (e) {}
    }
  };
  walk(doc, fb.x, fb.y);
  // Community cards are card-sized SVGs in the middle band — but the board's
  // card SLOTS exist in the DOM even when no card shows, so require actual
  // visibility: the element under the card's centre must be the card itself.
  const cardEls = [];
  for (const svg of doc.querySelectorAll('svg')) {
    const r = svg.getBoundingClientRect();
    if (r.width < 40 || r.width > 80 || r.height < 60 || r.height > 110) continue;
    if (r.y < fb.height * 0.2 || r.y > fb.height * 0.65) continue;
    if (r.x < fb.width * 0.18 || r.x + r.width > fb.width * 0.82) continue;
    // Style-based visibility only — no elementFromPoint (overlays like the
    // sit-out veil or winner banner cover real cards and would hide them).
    // Empty slots are computed-visibility hidden; animation ghosts hang off
    // opacity-0 ancestors.
    if (doc.defaultView.getComputedStyle(svg).visibility !== 'visible') continue;
    let vis = true;
    for (let e = svg; e && e !== doc.body; e = e.parentElement) {
      if (+doc.defaultView.getComputedStyle(e).opacity < 0.5) { vis = false; break; }
    }
    if (vis)
      cardEls.push({x: Math.round(r.x), y: Math.round(r.y),
                    w: Math.round(r.width), h: Math.round(r.height),
                    qa: svg.getAttribute('data-qa') || ''});
  }
  // The hero's hole cards are mirrored as minis in the TAB STRIP (top page,
  // outside the table iframe) — same data-qa card indices.
  const heroMini = [...document.querySelectorAll('svg[data-qa]')].map(s => {
    const r = s.getBoundingClientRect();
    return {qa: s.getAttribute('data-qa'), x: Math.round(r.x),
            y: Math.round(r.y), w: Math.round(r.width)};
  }).filter(c => /^card\d+$/.test(c.qa) && c.y < 140 && c.w >= 12 && c.w <= 60);
  const btns = [...doc.querySelectorAll('button, [role=button]')].map(el => {
    const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
    const r = el.getBoundingClientRect();
    // The client tags each control: foldButton/callButton/raiseButton/etc are
    // turn actions, *Selector are sizing presets, *PreselectButton are the
    // between-turn pre-arm checkboxes. Carrying the hook lets the action/preset
    // split read the client's own roles instead of guessing by row geometry.
    return {text: t, x: Math.round(fb.x + r.x), y: Math.round(fb.y + r.y),
            w: Math.round(r.width), h: Math.round(r.height),
            qa: el.getAttribute('data-qa') || null};
  }).filter(b => b.text && b.text.length < 40 && b.w > 0 && b.h > 0);
  // STRUCTURAL ownership, read from the client's own containment: which
  // playerContainer a card sits under, and whether it is under the table
  // element at all. The geometric board/hole split (band + modal row) has
  // recorded near-misses — hero cards flood the board band on small layouts
  // and 13 ticks across sessions had mixed-width cards sharing a y-row — so
  // ownership is captured per element to let the split become pure DOM.
  const seatOf = el => {
    const s = el.closest && el.closest("[data-qa^='playerContainer-']");
    return s ? +s.getAttribute('data-qa').split('-')[1] : null;
  };
  const tblEl = doc.querySelector("[data-qa='table']");
  // EVERY visible card element with its position — seat card presence is the
  // reliable fold signal (a folded seat's cards are mucked and stay gone,
  // unlike action badges which animate and re-render).
  const allCards = [...doc.querySelectorAll('svg[data-qa]')].map(s => {
    const r = s.getBoundingClientRect();
    return {qa: s.getAttribute('data-qa') || '', x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2), w: Math.round(r.width), el: s};
  }).filter(c => /^card/.test(c.qa) && c.w >= 20 &&
                 doc.defaultView.getComputedStyle(c.el).visibility === 'visible')
    .map(c => ({qa: c.qa, x: c.x, y: c.y, w: c.w,
                seat: seatOf(c.el), tbl: !!(tblEl && tblEl.contains(c.el))}));
  // Per-seat structural facts, read from the client's own containment — every
  // value the geometric _parse_seats reconstructs by proximity is available
  // inside the seat's playerContainer, so no distances are needed.
  //   stack  : the playerBalance hook (data-qa, stable)
  //   bet    : the one 'X BB' money node that is NOT playerBalance
  //   badge  : the action word (FOLD/CHECK/...), animation-doubled -> first
  //   num    : the displayed seat number (bare single digit; differs from the
  //            0-indexed container id and is what the WS feed keys on)
  //   nHole  : holeCards hooks = real hole-card slots (0 = folded/not dealt)
  const SM = /^[\d,]+(\.\d+)?\s*BB$/i;
  const BW = /^(FOLD|CHECK|CALL|BET|RAISE|ALL[ -]?IN|POST SB|POST BB)$/i;
  // Seat STATUS words, captured per container (2026-09-19): "SITTING OUT" under
  // a villain's seat used to be read as hero sitting out because the status
  // scan saw the whole table as one string (hand 4919080696). Scoping the word
  // to the seat that shows it is what makes it attributable.
  const SW = /sitting out|i am back|wait(ing)?\s+(for\s+)?(the\s+)?big blind|waiting for bb/i;
  // Same visibility test the main node walk uses: the client leaves stale
  // labels (a folded seat's old FOLD, a settled 0 BB bet) in the DOM at
  // opacity 0, and a plain textContent read would resurrect them onto a seat
  // that has since acted again.
  const vw = doc.defaultView;
  const opShown = el => {
    for (let e = el; e && e !== doc.body; e = e.parentElement)
      if (+vw.getComputedStyle(e).opacity < 0.5) return false;
    return true;
  };
  const vis = el => el && vw.getComputedStyle(el).visibility === 'visible' && opShown(el);
  const seatQa = [...doc.querySelectorAll("[data-qa^='playerContainer-']")].map(s => {
    const bal = s.querySelector("[data-qa='playerBalance']");
    let bet = null, badge = null, num = null, status = null;
    const wk = doc.createTreeWalker(s, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = wk.nextNode())) {
      const tx = (n.nodeValue || '').trim();
      if (!tx) continue;
      const pe = n.parentElement;
      if (SM.test(tx)) { if (!(bal && bal.contains(pe)) && bet === null && vis(pe)) bet = tx; }
      else if (BW.test(tx)) { if (badge === null && vis(pe)) badge = tx.toUpperCase(); }
      else if (SW.test(tx)) { if (vis(pe)) status = status ? status + ' ' + tx : tx; }
      else if (/^[1-9]$/.test(tx) && num === null) num = +tx;
    }
    const sr = s.getBoundingClientRect();
    return {
      seat: +s.getAttribute('data-qa').split('-')[1],
      num, me: !!s.querySelector("[data-qa='myPlayerTag']"),
      // the seat's own status words (SITTING OUT / I AM BACK / waiting for BB)
      // and its box, so a word can be attributed to the seat that shows it
      status,
      box: {x: Math.round(fb.x + sr.x), y: Math.round(fb.y + sr.y),
            w: Math.round(sr.width), h: Math.round(sr.height)},
      empty: !!s.querySelector("[data-qa^='player-empty-seat']"),
      stack: bal ? bal.textContent.trim() : null,
      bet, badge,
      // VISIBLE hole-card slots only. The client keeps a folded seat's
      // holeCards hooks in the DOM and merely hides them, so counting hooks
      // reported two cards for a seat that mucked and never dropped: across a
      // recorded session, 99 seats kept "holding" cards after the feed said
      // they folded, for a median of 20 ticks and up to 145 — not the muck
      // animation, which is one or two. Card presence IS the fold signal, so
      // that left folded players live in every downstream read. The same
      // filter the bet and badge already use fixes it.
      nHole: [...s.querySelectorAll("[data-qa='holeCards']")].filter(vis).length,
      // The dealer button. It has NO text node (it is drawn, not written), so
      // the geometric pass can never see it and no capture has ever carried
      // it — the one seat fact the review queue confirmed missing on every
      // path. The asset harvested from the client's own DOM is dealer-d.svg,
      // so an <img> under the seat container whose src names the dealer is
      // the client's marker; data-qa is checked too in case a build swaps the
      // img for a hooked element.
      dealer: !!([...s.querySelectorAll("img")].some(i => /dealer/i.test(i.src || ""))
                 || s.querySelector("[data-qa*='dealer' i]")),
    };
  });
  // The client scales its fixed-size table with CSS `zoom`. Every coordinate
  // above is viewport pixels, so design units = (viewport - frame origin) /
  // zoom. The factor cannot be recovered from the coordinates afterwards and
  // the frame rect is the iframe (not the felt), so it is read here or not at
  // all. Walk up from a card: the factor is only ever set on the container,
  // and Chrome computes unset `zoom` to "1" (not "normal") on every ancestor,
  // so the walk must skip 1 and keep climbing rather than stop at the first
  // parsable value. Verified: from a card 54.24px deep under a 1.4275 host the
  // walk returns 1.4275 and 54.24/1.4275 lands back on the declared 38du.
  const zoomOf = el => {
    for (let e = el; e; e = e.parentElement) {
      const z = parseFloat(doc.defaultView.getComputedStyle(e).zoom);
      if (z && z !== 1) return z;
    }
    return 1;
  };
  // Any tagged element will do as a starting point, not a card specifically:
  // between hands there are no cards, and defaulting to 1 there would be
  // indistinguishable from a genuinely unzoomed table. null means "no
  // reference element" so a consumer normalising coordinates can refuse rather
  // than quietly divide by the wrong factor.
  const zoomRef = doc.querySelector('svg[data-qa], [data-qa]');
  return {seated: true, practice: (tf.src || '').includes('playMode=fun'),
          frame: {x: Math.round(fb.x), y: Math.round(fb.y),
                  w: Math.round(fb.width), h: Math.round(fb.height)},
          zoom: zoomRef ? zoomOf(zoomRef) : null,
          nodes: out, buttons: btns, cards: cardEls, allCards, heroMini, seatQa,
          canvases: doc.querySelectorAll('canvas').length};
})()