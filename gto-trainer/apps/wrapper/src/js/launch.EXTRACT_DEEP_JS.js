(() => {
  const out = [];
  const walk = (doc, ox, oy) => {
    if (!doc || !doc.body) return;
    const wk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = wk.nextNode())) {
      const s = (n.nodeValue || '').trim();
      if (!s || s.length > 24) continue;
      const r = doc.createRange(); r.selectNodeContents(n);
      const b = r.getBoundingClientRect();
      if (b.width > 0 && b.height > 0)
        out.push({text: s, x: Math.round(b.x + ox), y: Math.round(b.y + oy),
                  w: Math.round(b.width), h: Math.round(b.height)});
    }
    for (const f of doc.querySelectorAll('iframe')) {
      try {
        const fb = f.getBoundingClientRect();
        walk(f.contentDocument, ox + fb.x, oy + fb.y);
      } catch (e) { /* cross-origin — separate CDP target */ }
    }
  };
  const count = (doc, sel) => {
    if (!doc) return 0;
    let c = doc.querySelectorAll(sel).length;
    for (const f of doc.querySelectorAll('iframe')) {
      try { c += count(f.contentDocument, sel); } catch (e) {}
    }
    return c;
  };
  walk(document, 0, 0);
  return {nodes: out, canvases: count(document, 'canvas'),
          iframes: count(document, 'iframe'),
          vw: innerWidth, vh: innerHeight, url: location.href, title: document.title};
})()