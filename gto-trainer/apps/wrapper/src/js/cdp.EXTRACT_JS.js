(() => {
  const out = [];
  const wk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = wk.nextNode())) {
    const s = (n.nodeValue || '').trim();
    if (!s || s.length > 24) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    const b = r.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight)
      out.push({text: s, x: Math.round(b.x), y: Math.round(b.y),
                w: Math.round(b.width), h: Math.round(b.height)});
  }
  return {nodes: out, canvases: document.querySelectorAll('canvas').length,
          vw: innerWidth, vh: innerHeight, url: location.href, title: document.title};
})()