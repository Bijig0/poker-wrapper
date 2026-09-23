((cents) => {__FRAME__
  const f = __frame(__SLOT__);
  let doc = null; try { doc = f && f.contentDocument; } catch (e) {}
  if (!doc || !doc.body) return { ok: false, reason: 'no table frame' };
  let input = null;
  for (const inp of doc.querySelectorAll('input')) {
    if (inp.type === 'checkbox' || inp.type === 'radio' || inp.type === 'hidden') continue;
    const b = inp.getBoundingClientRect(); if (!(b.width > 0 && b.height > 0)) continue;
    let c = inp.parentElement, hit = false;
    for (let i = 0; i < 6 && c && c !== doc.body; i++) { if (/Max\.?\s*\$|Playable balance/i.test(c.textContent || '')) { hit = true; break; } c = c.parentElement; }
    if (hit) { input = inp; break; }
  }
  if (!input) return { ok: false, reason: 'no amount field in the Buy-chips panel' };
  const v = (cents / 100).toFixed(2);
  const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
  input.focus();
  if (d && d.set) d.set.call(input, v); else input.value = v;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: input.value };
})