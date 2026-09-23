(() => {
  // The Lobby control lives in the top strip of the TOP document — above every
  // table frame, outside all of them. Take the SMALLEST element whose own text
  // is exactly "Lobby": the strip nests, and the outer boxes span the whole bar.
  const hits = [...document.querySelectorAll('*')].filter(e => {
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || r.top > 70) return false;
    const own = [...e.childNodes].filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim()).join(' ').trim();
    return /^lobby$/i.test(own);
  });
  if (!hits.length) return null;
  hits.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (ra.width * ra.height) - (rb.width * rb.height);
  });
  const r = hits[0].getBoundingClientRect();
  return JSON.stringify({x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                         w: Math.round(r.width), h: Math.round(r.height)});
})()