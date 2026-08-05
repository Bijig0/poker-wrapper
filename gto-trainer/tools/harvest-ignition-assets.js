/*
 * Ignition asset harvester — paste into the poker client's DevTools console
 * (or run via Claude-in-Chrome) while a table is open.
 *
 * Collects, read-only:
 *  - every distinct inline <svg> in the table frame (deduped by content),
 *    tagged with its nearest data-qa ancestor and rendered size, so the chip
 *    icon, card backs/faces, dealer button and watermark all come along
 *  - every CSS background that embeds a data: URI (action-panel shapes, the
 *    felt noise tile)
 *  - @font-face rules, to identify the icon font behind glyphs like the
 *    vacant-seat icon, which is not an SVG
 *
 * Output: one JSON blob, copied to the clipboard when possible and always
 * printed. Hand it back and the assets get dropped into
 * gto-trainer/apps/dashboard/public/ign/ and wired into the replica.
 */
(() => {
  let td = null;
  for (let i = 0; i < window.frames.length; i++) {
    try {
      const d = window.frames[i].document;
      if (d.querySelector("[data-qa^='playerContainer-']")) { td = d; break; }
    } catch (_) {}
  }
  if (!td && document.querySelector("[data-qa^='playerContainer-']")) td = document;
  if (!td) return "no table frame — open a table first";

  const out = { svgs: [], cssDataUris: [], fontFaces: [], collectedAt: new Date().toISOString() };

  // ---- inline SVGs, deduped by markup ------------------------------------
  const seen = new Map();
  for (const svg of td.querySelectorAll("svg")) {
    const html = svg.outerHTML;
    if (seen.has(html)) { seen.get(html).count++; continue; }
    const b = svg.getBoundingClientRect();
    const qaAnc = svg.closest("[data-qa]");
    const entry = {
      count: 1,
      bytes: html.length,
      renderedPx: [Math.round(b.width), Math.round(b.height)],
      viewBox: svg.getAttribute("viewBox"),
      nearestQa: qaAnc ? qaAnc.getAttribute("data-qa") : null,
      ancestorClasses: svg.parentElement
        ? String(svg.parentElement.className).slice(0, 60)
        : null,
      markup: html,
    };
    seen.set(html, entry);
    out.svgs.push(entry);
  }

  // ---- CSS data-URI backgrounds + font faces -----------------------------
  for (const sheet of td.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (_) { continue; }
    for (const r of rules) {
      if (r.style && /url\("?data:/.test(r.style.backgroundImage || "")) {
        out.cssDataUris.push({
          selector: r.selectorText,
          backgroundImage: r.style.backgroundImage,
        });
      }
      if (r instanceof CSSFontFaceRule) {
        out.fontFaces.push({
          family: r.style.getPropertyValue("font-family"),
          src: r.style.getPropertyValue("src").slice(0, 300),
        });
      }
    }
  }

  const json = JSON.stringify(out);
  console.log(`harvested: ${out.svgs.length} distinct svgs, ${out.cssDataUris.length} css data-uris, ${out.fontFaces.length} font faces — ${(json.length / 1024).toFixed(0)} KB`);
  try { copy(json); console.log("%ccopied to clipboard", "color:#0c9"); } catch (_) {}
  console.log(json.slice(0, 200) + "…");
  return out.svgs.map((s) => `${s.nearestQa ?? s.ancestorClasses} ${s.renderedPx.join("x")} vb=${s.viewBox} (${s.bytes}b x${s.count})`);
})();
