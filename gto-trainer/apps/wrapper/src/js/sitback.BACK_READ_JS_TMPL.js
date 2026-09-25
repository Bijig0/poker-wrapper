(() => {__FRAME__
  const f = __frame(__SLOT__);
  if (!f) return { ok: false, reason: 'no table frame' };
  let doc = null; try { doc = f.contentDocument; } catch (e) {}
  if (!doc || !doc.body) return { ok: false, reason: 'table frame not readable' };
  const fb = f.getBoundingClientRect();
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const leaves = [...doc.querySelectorAll('*')].filter(e => e.children.length === 0);
  // the client labels it "I AM BACK" (older builds "I'm back")
  const el = leaves.find(e => /^\s*i('?m| am) back\s*$/i.test(e.textContent || '') && vis(e));
  const seated = !!doc.querySelector("[data-qa='myPlayerTag']");
  if (!el) return { ok: true, back: false, seated };
  const r = el.getBoundingClientRect();
  return { ok: true, back: true, seated, x: fb.x + r.x + r.width / 2, y: fb.y + r.y + r.height / 2 };
})()
