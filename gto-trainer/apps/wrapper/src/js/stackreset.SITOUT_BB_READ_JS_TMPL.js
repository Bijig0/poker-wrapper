(() => {__FRAME__
  // "Sit out next big blind" (deep-stack reset, 2026-10-03) - its own box, beside "Sit out next hand" 20 px above it.
  // FOUND BY ITS TEXT, SHOWN BY STYLE (2026-10-09, session_20261009_052537: five resets aborted on "no 'Sit out next
  // big blind' box" while the reader's own capture of the same frame listed the label at 90 x 13 px in 5,474 of 5,474
  // captures). The old read looked only at LEAF elements (no element children) whose text matched and whose box
  // measured non-zero; the client's label is not such a leaf (its text sits beside an element - the box - or in an
  // element that measures 0 x 0, e.g. display: contents), so it never matched, live or practice, drawn or not. Now:
  // the deepest element whose whole text is the label, shown when nothing up its chain is display: none / [hidden] /
  // opacity ~0 and it is not visibility: hidden - never by its measured size. A frame Chrome has stopped drawing
  // still lays out (getBoundingClientRect measures layout, not paint); the coordinates come from the element's box,
  // else its contents' (a Range), else none (x/y null: the caller presses it through the DOM).
  // __CLICK__ = true: after the read, click the box (or the label when no box is ours) through the DOM.
  const CLICK = __CLICK__;
  const f = __frame(__SLOT__);
  if (!f) return { ok: false, reason: 'no table frame' };
  let doc = null; try { doc = f.contentDocument; } catch (e) {}
  if (!doc || !doc.body) return { ok: false, reason: 'table frame not readable' };
  const view = doc.defaultView;
  const fb = f.getBoundingClientRect();
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const all = [...doc.body.querySelectorAll('*')];
  // the deepest elements whose whole text matches (a label split over several text nodes or elements still matches)
  const holders = re => all.filter(e => {
    const t = e.textContent || '';
    if (t.length > 60 || !re.test(norm(t))) return false;
    return ![...e.children].some(c => re.test(norm(c.textContent)));
  });
  const shown = el => {
    for (let e = el; e && e !== doc.documentElement; e = e.parentElement) {
      if (e.hidden) return false;
      const cs = view.getComputedStyle(e);
      if (cs.display === 'none' || +cs.opacity < 0.1) return false;
    }
    const v = view.getComputedStyle(el).visibility;
    return v !== 'hidden' && v !== 'collapse';
  };
  const rectOf = el => {
    let r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) {
      try { const g = doc.createRange(); g.selectNodeContents(el); r = g.getBoundingClientRect(); } catch (e) {}
    }
    return r;
  };
  const sized = r => !!r && r.width > 0 && r.height > 0;
  let idleMs = null;
  try { const w = f.contentWindow, hb = w.__wrapperDraw; if (hb) idleMs = Math.round(w.performance.now() - hb.t); } catch (e) {}
  const back = holders(/^i('?m| am) back$/).some(shown);
  const seated = !!doc.querySelector("[data-qa='myPlayerTag']");
  const cands = holders(/^sit out next big blind$/);
  const labs = cands.filter(shown);
  if (!labs.length) return { ok: true, found: false, hidden: cands.length, back, seated, idleMs };
  const lab = labs[0];
  // the tick state: the box tied to the label (<label for>), else the nearest box walking up from the label - but
  // ONLY a container that holds exactly one box and not the "Sit out next hand" label too (a shared row would answer
  // for the other box: `shared`). Anything else is unknown (null), never "unticked".
  let checked = null, via = null, box = null, shared = false, c = lab;
  const ctl = lab.control;
  if (ctl && ctl.type === 'checkbox') { box = ctl; checked = !!ctl.checked; via = 'label-for'; }
  for (let i = 0; !box && i < 5 && c && c !== doc.body; i++) {
    if (norm(c.textContent).includes('sit out next hand')) { shared = true; c = null; break; }
    const boxes = [...c.querySelectorAll('input[type=checkbox]')];
    if (boxes.length > 1) break;
    if (boxes.length === 1) { box = boxes[0]; checked = !!box.checked; via = 'input'; break; }
    const self = c.hasAttribute && c.hasAttribute('aria-checked') ? [c] : [];
    const ars = self.concat([...c.querySelectorAll('[aria-checked]')]);
    if (ars.length > 1) break;
    if (ars.length === 1) { box = ars[0]; checked = box.getAttribute('aria-checked') === 'true'; via = 'aria'; break; }
    c = c.parentElement;
  }
  // where a pointer press goes: the box itself when it is shown and measures, else the label (a click on a label
  // ticks its box; on a row, the row's handler takes it)
  const lr = rectOf(lab);
  const br = box && shown(box) ? rectOf(box) : null;
  const pt = sized(br) ? br : sized(lr) ? lr : null;
  const out = { ok: true, found: true, checked, via, shared, back, seated, idleMs,
                on: pt === br && pt ? 'box' : pt ? 'label' : null,
                w: Math.round(lr.width || 0), h: Math.round(lr.height || 0),
                x: pt ? fb.x + pt.x + pt.width / 2 : null, y: pt ? fb.y + pt.y + pt.height / 2 : null,
                html: ((c || lab.parentElement || lab).outerHTML || '').slice(0, 600) };
  if (CLICK) {
    const target = box || lab;
    try { target.click(); out.domClicked = String(target.tagName || '').toLowerCase() + (box ? ' (the box)' : ' (the label)'); }
    catch (e) { out.domClickError = String((e && e.message) || e); }
  }
  return out;
})()
