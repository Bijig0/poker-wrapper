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
  const lab = leaves.find(e => /^\s*sit out next hand\s*$/i.test(e.textContent || '') && vis(e));
  if (!lab) return { ok: true, found: false, back, seated };
  // the tick state: a real checkbox, an aria-checked control, or a class that says so -
  // whichever the client uses, found by walking up from the label
  let checked = null, via = null, c = lab;
  for (let i = 0; i < 5 && c && c !== doc.body; i++) {
    const inp = c.querySelector && c.querySelector('input[type=checkbox]');
    if (inp) { checked = !!inp.checked; via = 'input'; break; }
    const ar = (c.hasAttribute && c.hasAttribute('aria-checked')) ? c : (c.querySelector && c.querySelector('[aria-checked]'));
    if (ar) { checked = ar.getAttribute('aria-checked') === 'true'; via = 'aria'; break; }
    c = c.parentElement;
  }
  const r = lab.getBoundingClientRect();
  return { ok: true, found: true, checked, via, back, seated,
           x: fb.x + r.x + r.width / 2, y: fb.y + r.y + r.height / 2,
           html: ((c || lab.parentElement || lab).outerHTML || '').slice(0, 600) };
})()