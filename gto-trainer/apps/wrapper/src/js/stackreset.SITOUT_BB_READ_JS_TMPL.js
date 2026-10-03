(() => {__FRAME__
  const f = __frame(__SLOT__);
  if (!f) return { ok: false, reason: 'no table frame' };
  let doc = null; try { doc = f.contentDocument; } catch (e) {}
  if (!doc || !doc.body) return { ok: false, reason: 'table frame not readable' };
  const fb = f.getBoundingClientRect();
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const leaves = [...doc.querySelectorAll('*')].filter(e => e.children.length === 0);
  const back = leaves.some(e => /^\s*i'?m back\s*$/i.test(e.textContent || '') && vis(e));
  const seated = !!doc.querySelector("[data-qa='myPlayerTag']");
  // "Sit out next big blind" (deep-stack reset, 2026-10-03) - its own box, beside "Sit out next hand" 20 px above it
  const lab = leaves.find(e => /^\s*sit out next big blind\s*$/i.test(e.textContent || '') && vis(e));
  if (!lab) return { ok: true, found: false, back, seated };
  // the tick state: the nearest box walking up from the label - but ONLY a container that holds exactly one box
  // and not the "Sit out next hand" label too (a shared row would answer for the other box). Anything else is
  // unknown (null), never "unticked".
  const other = e => [...e.querySelectorAll('*')].some(x => x.children.length === 0 && /^\s*sit out next hand\s*$/i.test(x.textContent || ''));
  let checked = null, via = null, c = lab;
  for (let i = 0; i < 5 && c && c !== doc.body; i++) {
    if (c !== lab && c.querySelectorAll && other(c)) { c = null; break; }
    const boxes = c.querySelectorAll ? c.querySelectorAll('input[type=checkbox]') : [];
    if (boxes.length > 1) break;
    if (boxes.length === 1) { checked = !!boxes[0].checked; via = 'input'; break; }
    const self = c.hasAttribute && c.hasAttribute('aria-checked') ? [c] : [];
    const ars = self.concat(c.querySelectorAll ? [...c.querySelectorAll('[aria-checked]')] : []);
    if (ars.length > 1) break;
    if (ars.length === 1) { checked = ars[0].getAttribute('aria-checked') === 'true'; via = 'aria'; break; }
    c = c.parentElement;
  }
  const r = lab.getBoundingClientRect();
  return { ok: true, found: true, checked, via, back, seated,
           x: fb.x + r.x + r.width / 2, y: fb.y + r.y + r.height / 2,
           html: ((c || lab.parentElement || lab).outerHTML || '').slice(0, 600) };
})()
