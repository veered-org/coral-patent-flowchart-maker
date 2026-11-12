// Coral exports: the page display list drawn to a PDF (pdf-lib, fonts embedded) or a
// canvas (PNG). Runs in the browser and in Node (tests/export.test.js).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./engine.js"));
  else root.CoralExport = factory(root.Coral);
})(typeof self !== "undefined" ? self : this, function (Coral) {
  "use strict";

  function hex(c) {
    let h = String(c || "#000").replace("#", "");
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    const n = parseInt(h, 16) || 0;
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  // pages: layout(...).pages; fontBytes: the TTF for style.font. Returns Uint8Array.
  async function toPDF(pages, style, PDFLib, fontkit, fontBytes, title) {
    const doc = await PDFLib.PDFDocument.create();
    doc.registerFontkit(fontkit);
    doc.setTitle(title || "Flowchart"); doc.setCreator("Coral patent flowchart maker");
    const font = await doc.embedFont(fontBytes, { subset: true });
    const rgb = (c) => { const v = hex(c); return PDFLib.rgb(v[0], v[1], v[2]); };
    for (const pg of pages) {
      const page = doc.addPage([pg.w, pg.h]);
      for (const o of pg.ops) {
        if (o.t === "path") {
          const opt = { x: 0, y: pg.h };
          if (o.stroke && o.stroke !== "none" && o.sw) { opt.borderColor = rgb(o.stroke); opt.borderWidth = o.sw; }
          else opt.borderWidth = 0;
          if (o.fill && o.fill !== "none") opt.color = rgb(o.fill);
          if (o.dash) opt.borderDashArray = o.dash;
          page.drawSvgPath(Coral.pathD(o.d), opt);
        } else {
          const w = font.widthOfTextAtSize(o.s, o.size);
          const x = o.anchor === "middle" ? o.x - w / 2 : o.anchor === "end" ? o.x - w : o.x;
          page.drawText(o.s, { x, y: pg.h - o.y, size: o.size, font, color: rgb(o.color) });
        }
      }
    }
    return doc.save();
  }

  // Draws one page on a 2D canvas context at `scale` pixels per point.
  function toCanvas(ctx, pg, style, scale) {
    const f = Coral.FONTS[style.font];
    ctx.save(); ctx.scale(scale, scale);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, pg.w, pg.h);
    ctx.lineJoin = "miter"; ctx.lineCap = "butt";
    for (const o of pg.ops) {
      if (o.t === "path") {
        ctx.beginPath();
        for (const c of o.d) {
          if (c[0] === "M") ctx.moveTo(c[1], c[2]); else if (c[0] === "L") ctx.lineTo(c[1], c[2]);
          else if (c[0] === "C") ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
          else if (c[0] === "Q") ctx.quadraticCurveTo(c[1], c[2], c[3], c[4]); else if (c[0] === "Z") ctx.closePath();
        }
        if (o.fill && o.fill !== "none") { ctx.fillStyle = o.fill; ctx.fill(); }
        if (o.stroke && o.stroke !== "none" && o.sw) { ctx.strokeStyle = o.stroke; ctx.lineWidth = o.sw; ctx.setLineDash(o.dash || []); ctx.stroke(); ctx.setLineDash([]); }
      } else {
        ctx.font = o.size + "px '" + f.family + "', " + f.fallback;
        ctx.fillStyle = o.color; ctx.textAlign = o.anchor === "middle" ? "center" : o.anchor === "end" ? "right" : "left"; ctx.textBaseline = "alphabetic";
        ctx.fillText(o.s, o.x, o.y);
      }
    }
    ctx.restore();
  }

  return { toPDF, toCanvas };
});
