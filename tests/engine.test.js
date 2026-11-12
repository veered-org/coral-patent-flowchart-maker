// node tests/engine.test.js
const C = require("../engine.js");
const measure = (t, font, size) => t.length * size * (font === "mono" ? 0.6 : 0.5);
let fails = 0;
const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };

const OUT = "Start\n102: Receive a sign-in request\n104: Is the password correct?\n    Yes:\n        106: Create a session token\n    No:\n        108: Count the failed attempt\n        110: More than three failed attempts?\n            Yes:\n                112: Lock the account\n                End\n            No: -> 102\n114: Send the response\nEnd";
const rows = C.parseOutline(OUT);
ok(rows.length === 14 && rows[1].num === "102" && rows[1].text === "Receive a sign-in request", "outline parsed");
ok(C.toOutline(rows) === OUT, "outline round-trips");
ok(C.rowKind(rows, 2) === "decision" && C.rowKind(rows, 3) === "label" && C.rowKind(rows, 11) === "label", "decisions and branch labels recognised");

const L = C.layout({ label: "3", rows, style: C.usptoStyle() }, measure);
ok(L.pages.length === 1 && !L.issues.some((i) => i.sev === "violation"), "sample is one clean sheet");
const texts = L.pages[0].ops.filter((o) => o.t === "text").map((o) => o.s);
ok(texts.includes("FIG. 3") && texts.includes("102") && texts.includes("Yes") && texts.includes("No"), "caption, numerals and branch labels drawn");
ok(!texts.some((s) => /sheet/i.test(s)), "no sheet numbering");
ok(L.pages[0].ops.every((o) => (o.t === "text" ? o.color === "#000000" && o.size >= C.minFontSize("sans") : (o.stroke === "#000000" || o.stroke === "none") && /^(none|#000000|#ffffff)$/.test(o.fill))), "black and white, lettering at least 0.32 cm");
const bb = L.pages[0].bbox, u = L.pages[0].use;
ok(bb.x0 >= u.x - 0.5 && bb.x1 <= u.x + u.w + 0.5 && bb.y0 >= u.y - 0.5 && bb.y1 <= u.y + u.h + 0.5, "drawing stays inside the margins");

ok(C.minFontSize("sans") === 13.5 && C.minFontSize("serif") === 14 && C.minFontSize("lexend") === 13, "minimum sizes follow each typeface's capital height");
const small = C.layout({ label: "3", rows, style: Object.assign(C.usptoStyle(), { fontSize: 8, margins: { top: 1, left: 2.5, right: 1.5, bottom: 1 }, stroke: "#ff0000" }) }, measure);
ok(small.style.fontSize === 13.5 && small.style.stroke === "#000000", "compliance mode clamps size and color");
ok(["top margin", "0.32 cm", "black and white"].every((k) => small.issues.some((i) => i.sev === "violation" && i.msg.includes(k))), "checker flags margin, lettering and color");
const off = C.layout({ label: "", rows, style: Object.assign(C.webStyle(), { fontSize: 8 }) }, measure);
ok(off.style.fontSize === 8 && !off.issues.some((i) => i.sev === "violation"), "override: no limits, no violations");

const dup = C.parseOutline("102: One\n102: Two\n-> 999");
const D = C.layout({ label: "1", rows: dup, style: C.usptoStyle() }, measure);
ok(D.issues.some((i) => /Numeral 102 is used/.test(i.msg)) && D.issues.some((i) => /was not found/.test(i.msg)), "duplicate numeral and missing loop target flagged");
ok(dup.every((r, i) => r.num === ["102", "102", ""][i]), "numerals are never assigned or changed");

const long = C.parseOutline(Array.from({ length: 18 }, (_, i) => (100 + 2 * i) + ": Step " + (i + 1)).join("\n"));
const P = C.layout({ label: "5", rows: long, style: C.usptoStyle() }, measure);
const letters = (pg) => pg.ops.filter((o) => o.t === "text" && /^[A-Z]$/.test(o.s)).map((o) => o.s);
ok(P.pages.length >= 2 && letters(P.pages[0]).includes("A") && letters(P.pages[1]).includes("A"), "long chart continues on the next sheet through connector A");
ok(P.pages[0].label === "5A" && P.pages[1].label === "5B", "partial views labelled 5A, 5B");
const man = C.layout({ label: "6", rows: C.parseOutline("10: One\n(K)\n20: Two"), style: C.usptoStyle() }, measure);
ok(man.pages.length === 2 && letters(man.pages[0]).includes("K") && letters(man.pages[1]).includes("K"), "a typed (K) connector breaks the sheet");

const multi = C.layout({ label: "7", rows: C.parseOutline("10: Which?\n    A:\n        12: One\n    B:\n        14: Two\n    C:\n        16: Three\n    D: -> 10\n18: Done"), style: Object.assign(C.usptoStyle(), { boxWidth: 3.5 }) }, measure);
const mt = multi.pages[0].ops.filter((o) => o.t === "text").map((o) => o.s);
ok(["A", "B", "C", "D"].every((l) => mt.includes(l)) && !multi.issues.some((i) => /crossing/.test(i.msg)), "four-way decision with a loop, no crossings");

for (const line of ["straight", "elbow", "curved"]) for (const head of Object.keys(C.HEADS)) {
  const X = C.layout({ label: "8", rows, style: Object.assign(C.usptoStyle(), { line, head, dash: "dashed" }) }, measure);
  if (!X.pages[0].ops.length || /NaN/.test(C.toSVG(X.pages[0], X.style))) { ok(false, "render " + line + "/" + head); }
}
ok(true, "every line type and arrowhead renders");

const claim = C.parseClaim("1. A method of brewing, comprising the steps of: (a) heating water to a set temperature; (b) steeping leaves in the water, wherein the leaves are held in a basket; and (c) pouring the water into a cup.");
ok(claim.length === 4 && claim[0].text === "Heating water to a set temperature" && claim[2].level === 1 && /^wherein the leaves/.test(claim[2].text) && claim.every((r) => !r.num), "claim split into steps, wherein nested, numerals left blank");
const text = C.describe({ label: "3", rows, style: C.usptoStyle() });
ok(/^FIG\. 3 is a flowchart/.test(text) && /At step 102, the method receives a sign-in request\./.test(text) && /If not, the method returns to step 102\./.test(text), "description text uses the chosen numerals");

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
