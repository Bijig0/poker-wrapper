(() => {__FRAME__
  const tf = __frame(__SLOT__);
  if (!tf || !tf.contentDocument) return {practice: false, inputs: [], anchor: null};
  const d = tf.contentDocument, fb = tf.getBoundingClientRect();
  const inputs = [...d.querySelectorAll('input, [contenteditable=true]')].map(el => {
    const r = el.getBoundingClientRect();
    return {r, value: el.value ?? el.textContent, type: el.type || 'editable'};
  // EVERY visible input. This used to keep only the lower 40% of the frame, on
  // the assumption that the action strip lives there — which is true only while
  // the frame is about as tall as the table it renders. When the external screen
  // moved from 200% to 100% scaling the frame became 1513 px tall around the same
  // ~756 px of table, the bet field landed at 39% of the frame, and every relayed
  // raise was refused as "not a raise spot" (2026-09-20). Frame-relative geometry
  // was never the right discriminator; the RAISE/BET button beside the field is
  // (see _pick_bet_input), and it does not care how tall the frame is.
  }).filter(i => i.r.width > 0 && i.r.height > 0)
    .map(i => ({x: Math.round(fb.x + i.r.x + i.r.width / 2),
                y: Math.round(fb.y + i.r.y + i.r.height / 2),
                h: Math.round(i.r.height),
                value: String(i.value), type: i.type}));
  // the action button this raise will be confirmed on — the bet field is the one
  // beside it, never the one beside some other panel's button
  const ab = [...d.querySelectorAll('[data-qa=raiseButton], [data-qa=betButton]')]
    .map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0)[0];
  const anchor = ab ? {x: Math.round(fb.x + ab.x + ab.width / 2),
                       y: Math.round(fb.y + ab.y + ab.height / 2)} : null;
  // any OTHER panel with a field of its own that could pose as the bet box
  const buy = !!d.querySelector('[data-qa=buyInButton]');
  return {practice: (tf.src || '').includes('playMode=fun'), inputs, anchor, buyPanel: buy,
          frameW: Math.round(fb.width)};
})()