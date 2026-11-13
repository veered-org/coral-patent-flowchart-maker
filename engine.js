// Coral engine: outline parsing, claim splitting, auto-layout, line routing, the
// 37 CFR 1.84 checks and the description text. No DOM here, so it runs in Node too
// (node tests/engine.test.js). All lengths are PDF points (1/72 inch) unless noted.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Coral = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PT_CM = 72 / 2.54;
  const PAPERS = {
    letter: { w: 612, h: 792, label: "Letter (21.6 × 27.9 cm)", uspto: true },
    a4: { w: 595.28, h: 841.89, label: "A4 (21.0 × 29.7 cm)", uspto: true },
    legal: { w: 612, h: 1008, label: "Legal (21.6 × 35.6 cm)" },
    tabloid: { w: 792, h: 1224, label: "Tabloid (27.9 × 43.2 cm)" },
    a3: { w: 841.89, h: 1190.55, label: "A3 (29.7 × 42.0 cm)" },
    slide: { w: 960, h: 540, label: "Slide 16:9 (33.9 × 19.1 cm)" },
    square: { w: 720, h: 720, label: "Square (25.4 × 25.4 cm)" },
  };
  // 37 CFR 1.84(g): minimum margins, in cm.
  const USPTO_MARGINS = { top: 2.5, left: 2.5, right: 1.5, bottom: 1.0 };
  // 37 CFR 1.84(p)(3): numbers and letters at least 0.32 cm (1/8 inch) high.
  const MIN_LETTER_CM = 0.32;
  const MIN_LINE_PT = 0.5;
  // cap = capital-letter height as a fraction of the font size (from each font's OS/2 table)
  const FONTS = {
    sans: { label: "Sans (Liberation Sans)", family: "Liberation Sans", fallback: "Arial, Helvetica, sans-serif", file: "LiberationSans-Regular.ttf", cap: 0.688 },
    serif: { label: "Serif (Liberation Serif)", family: "Liberation Serif", fallback: "'Times New Roman', Times, serif", file: "LiberationSerif-Regular.ttf", cap: 0.6548 },
    mono: { label: "Typewriter (Liberation Mono)", family: "Liberation Mono", fallback: "'Courier New', Courier, monospace", file: "LiberationMono-Regular.ttf", cap: 0.6587 },
    lexend: { label: "Lexend", family: "Lexend", fallback: "Arial, sans-serif", file: "Lexend-Regular.ttf", cap: 0.7 },
  };
  const SHAPES = {
    rect: "Rectangle", rounded: "Rounded rectangle", diamond: "Diamond", oval: "Oval",
    stadium: "Terminator (pill)", parallelogram: "Parallelogram", hexagon: "Hexagon", circle: "Circle",
  };
  const HEADS = { filled: "Filled triangle", open: "Open arrow", barbed: "Barbed", hollow: "Hollow triangle", none: "None" };

  function minFontSize(font) {
    const cap = (FONTS[font] || FONTS.sans).cap;
    return Math.ceil((MIN_LETTER_CM * PT_CM / cap) * 2 - 1e-9) / 2;
  }

  function usptoStyle() {
    return {
      compliance: true, paper: "letter",
      margins: { top: 2.5, left: 2.5, right: 1.5, bottom: 1.0 },
      font: "sans", fontSize: minFontSize("sans"), align: "center",
      shape: "rect", decisionShape: "diamond", termShape: "stadium",
      borderWeight: 1.25, arrowWeight: 1.25,
      line: "elbow", dash: "solid", head: "filled", headSize: 8,
      padding: 6, boxWidth: 6.5, gapY: 26, gapX: 26,
      numeralPos: "right", caption: "FIG.", wrap: "auto",
      stroke: "#000000", fill: "none", textColor: "#000000",
    };
  }
  function webStyle() {
    return Object.assign(usptoStyle(), {
      compliance: false, margins: { top: 1.5, left: 1.5, right: 1.5, bottom: 1.5 },
      font: "lexend", fontSize: 11, shape: "rounded", line: "curved",
      borderWeight: 1.5, arrowWeight: 1.5, headSize: 7, padding: 9, boxWidth: 6, gapY: 26,
      stroke: "#B5402B", fill: "#FFF1EC", textColor: "#3B0A14",
    });
  }
  const PRESETS = { "USPTO formal": usptoStyle, "Website/presentation": webStyle };

  // Brings a style into a usable state; in compliance mode the 1.84 limits that the
  // controls enforce (paper, black and white, letter height, line weight) are applied.
  function normStyle(s) {
    const d = usptoStyle(), o = Object.assign({}, d, s || {});
    o.margins = Object.assign({}, d.margins, (s && s.margins) || {});
    const num = (k, lo, hi) => { let v = parseFloat(o[k]); if (!isFinite(v)) v = d[k]; o[k] = Math.min(hi, Math.max(lo, v)); };
    num("fontSize", 5, 72); num("borderWeight", 0.1, 12); num("arrowWeight", 0.1, 12);
    num("headSize", 2, 40); num("padding", 0, 60); num("boxWidth", 2, 30); num("gapY", 12, 200); num("gapX", 10, 200);
    for (const k of ["top", "left", "right", "bottom"]) { let v = parseFloat(o.margins[k]); o.margins[k] = isFinite(v) ? Math.max(0, v) : d.margins[k]; }
    if (!FONTS[o.font]) o.font = "sans";
    if (!PAPERS[o.paper]) o.paper = "letter";
    if (!SHAPES[o.shape]) o.shape = "rect";
    if (!SHAPES[o.decisionShape]) o.decisionShape = "diamond";
    if (!SHAPES[o.termShape]) o.termShape = "stadium";
    if (!HEADS[o.head]) o.head = "filled";
    o.wrap = o.wrap === "off" || o.wrap === false ? "off" : "auto";
    if (o.compliance) {
      if (!PAPERS[o.paper].uspto) o.paper = "letter";
      o.stroke = "#000000"; o.fill = "none"; o.textColor = "#000000";
      o.fontSize = Math.max(o.fontSize, minFontSize(o.font));
      o.borderWeight = Math.max(o.borderWeight, MIN_LINE_PT); o.arrowWeight = Math.max(o.arrowWeight, MIN_LINE_PT);
    }
    return o;
  }

  // ------------------------------------------------------------------ outline
  // A row is {level, text, num, shape}. The outline is the same rows as indented text:
  //     102: Receive a request
  //     104: Is the user signed in?
  //         Yes:
  //             106: Load the profile
  //         No: -> 102
  //     End
  const RE_GOTO = /^(?:->|=>|→|go ?to:?|loop(?: back)? to:?|back to:?|return to:?)\s*(.+)$/i;
  const RE_CONN = /^\(\s*([A-Za-z0-9]{1,2})\s*\)$/;
  const RE_TERM = /^(start|begin|end|stop|finish|done|exit)$/i;
  const RE_END = /^(end|stop|finish|done|exit)$/i;
  const RE_NUM = /^([A-Za-z]{0,2}\d+[A-Za-z]?)\s*[:.)]\s+(.*)$/;
  const RE_SHAPE = /\s*\{\s*([a-z]+)\s*\}\s*$/i;

  function isDecisionRow(r) { return !!r && (r.shape === "diamond" || /\?\s*$/.test(r.text || "")) && !RE_GOTO.test((r.text || "").trim()); }
  function parentOf(rows, i) { for (let j = i - 1; j >= 0; j--) if (rows[j].level < rows[i].level) return j; return -1; }
  function rowKind(rows, i) {
    const r = rows[i], t = (r.text || "").trim(), p = parentOf(rows, i);
    if (p >= 0 && isDecisionRow(rows[p])) return "label";
    if (RE_CONN.test(t)) return "conn";
    if (RE_GOTO.test(t)) return "goto";
    if (isDecisionRow(r)) return "decision";
    if (RE_TERM.test(t)) return "term";
    if (p >= 0) return "sub";
    return "step";
  }

  function parseOutline(text) {
    const rows = [], stack = [];
    for (const raw of String(text || "").replace(/\t/g, "    ").split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const indent = raw.match(/^ */)[0].length;
      while (stack.length && stack[stack.length - 1] >= indent) stack.pop();
      stack.push(indent);
      const row = { level: stack.length - 1, text: raw.trim(), num: "", shape: "" };
      const sm = row.text.match(RE_SHAPE);
      if (sm && SHAPES[sm[1].toLowerCase()]) { row.shape = sm[1].toLowerCase(); row.text = row.text.replace(RE_SHAPE, ""); }
      rows.push(row);
      if (rowKind(rows, rows.length - 1) !== "label") {
        const nm = row.text.match(RE_NUM);
        if (nm) { row.num = nm[1]; row.text = nm[2]; }
      }
    }
    return rows;
  }
  function toOutline(rows) {
    return rows.map((r) => "    ".repeat(r.level) + (r.num ? r.num + ": " : "") + r.text + (r.shape ? " {" + r.shape + "}" : "")).join("\n");
  }

  // Splits a pasted method claim into steps; "wherein" clauses become sub-steps.
  // opt.body: the text is already the body (no preamble or "comprising" to skip).
  const upFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const cleanClause = (s) => s.replace(/^\s*(?:and\/or|and|or)\b[\s,]*/i, "").replace(/^\(?[a-z0-9]{1,3}[).]\s+/i, "")
    .replace(/[\s,;]*\b(?:and|or)\s*$/i, "").replace(/[\s.,;:]+$/, "").trim();
  function parseClaim(text, opt) {
    let t = String(text || "").replace(/\r/g, "").trim().replace(/^\s*(?:claim\s*)?\d+\s*[.)]\s*/i, "");
    if (!(opt && opt.body)) {
      const m = t.match(/\b(?:compris(?:ing|es)|includ(?:ing|es)|consist(?:ing|s)(?:\s+essentially)?\s+of)(?:\s+the\s+(?:steps|acts|operations)(?:\s+of)?)?\s*[:,—-]?\s*/i);
      if (m) t = t.slice(m.index + m[0].length);
    }
    // text copied from a PDF is wrapped at arbitrary places: when the claim has
    // semicolons they mark the steps and the line breaks mean nothing
    const segs = /;/.test(t) ? t.replace(/\s*\n\s*/g, " ").split(";") : t.split(/\n+/);
    const rows = [];
    for (const seg of segs) {
      const lm = seg.match(/^\s*(?:(?:and\/or|and|or)\b[\s,]*)?\(?([a-z]{1,2}|[ivx]{1,5}|\d{1,2})[).]\s+/i);
      let s = cleanClause(seg);
      if (!s) continue;
      if (!rows.length && /^(?:the|a|an)\s+(?:method|process)\b[^,]*$/i.test(s)) continue;
      s = s.replace(/^(?:the|a|an)\s+(?:method|process)\s+(?:of|according to|as (?:claimed|recited) in)\s+claim\s+\d+\s*,?\s*/i, "");
      const parts = s.split(/,?\s+(?=(?:and\s+)?where(?:in|by)\b)/i).map(cleanClause).filter(Boolean);
      parts.forEach((p, k) => {
        const sub = /^where(?:in|by)\b/i.test(p) && rows.length > 0;
        rows.push({ level: sub ? 1 : 0, text: sub ? p : upFirst(p), num: "", shape: "" });
        if (k === 0 && !sub) { rows[rows.length - 1].level = 0; if (lm) rows[rows.length - 1]._lab = lm[1].toLowerCase(); }
      });
    }
    return rows;
  }

  // ------------------------------------------------------------------ claim sets and descriptions
  const STOPW = new Set("the a an of to in on at by for from with and or said wherein whereby where method process claim claims further comprising comprises comprise including includes include step steps one more least plurality first second third each that which is are be being been as its it into based using via when if then than such at least".split(" "));
  const stems = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((w) => w.length > 2 && !STOPW.has(w)).map((w) => (w.length > 4 ? w.replace(/(?:ies)$/, "y").replace(/(?:ing|ed|es|s)$/, "") : w));
  const NEG = /\b(?:not|fails?|failed|invalid|incorrect|unable|cannot|absent|unsuccessful|no longer)\b|n't\b/i;

  // A pasted claim set -> [{n, text, parent}] (parent = the claim a dependent claim refers to).
  function splitClaims(text) {
    const t = String(text || "").replace(/\r/g, "");
    const re = /(?:^|\n)[ \t]*(?:claim\s+)?(\d{1,3})\s*[.):][ \t]+(?=\S)/gi, marks = [];
    let m;
    while ((m = re.exec(t))) { const n = +m[1]; if (!marks.length || n === marks[marks.length - 1].n + 1) marks.push({ n, start: m.index, body: m.index + m[0].length }); }
    if (!marks.length) return [{ n: 1, text: t.trim(), parent: null }];
    return marks.map((k, i) => {
      const body = t.slice(k.body, i + 1 < marks.length ? marks[i + 1].start : t.length).trim();
      const pm = body.slice(0, 220).match(/\bclaims?\s+(\d{1,3})/i);
      return { n: k.n, text: body, parent: pm && +pm[1] !== k.n ? +pm[1] : null };
    });
  }

  // "determining whether ..." becomes a diamond, and a following "in response to
  // determining that X, doing Y" becomes its Yes or No branch. The wording is kept.
  function claimDecisions(rows) {
    const out = [];
    let dec = -1, used = {}, pending = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.level > 0) { out.push(Object.assign({}, r, { level: r.level + (r._shift || 0) })); continue; }
      if (pending) { out.push(pending); dec = out.length - 1; used = {}; pending = null; }
      let j = i + 1; while (j < rows.length && rows[j].level > 0) j++;
      const m = r.text.match(/^(?:in response to|responsive to|upon|based on)\s+(?:a\s+)?determin(?:ing|ation)\s+(?:that\s+|whether\s+)?(.+?),\s*(.+)$/i)
        || r.text.match(/^(?:if|when)\s+(.+?),\s*(?:then\s+)?(.+)$/i);
      if (m && dec >= 0) {
        let label = NEG.test(m[1]) ? "No" : "Yes";
        if (used[label]) label = label === "Yes" ? "No" : "Yes";
        if (used[label]) label = upFirst(m[1]).slice(0, 28);
        used[label] = 1;
        out.push({ level: 1, text: label + ":", num: "", shape: "" }, { level: 2, text: upFirst(m[2]), num: "", shape: "" });
        for (let k = i + 1; k < j; k++) rows[k]._shift = 2;
        continue;
      }
      const dm = r.text.match(/^(?:determin(?:ing|e)|check(?:ing)?|verify(?:ing)?|detect(?:ing)?|decid(?:ing|e)|evaluat(?:ing|e)|test(?:ing)?)\s+(?:whether|if)\s+(.+)$/i);
      if (dm && j > i + 1) {
        // a diamond cannot hold "wherein" sub-steps: the step keeps them and a
        // short diamond follows it
        out.push(Object.assign({}, r)); dec = -1;
        pending = { level: 0, text: askForm(dm[1]), num: "", shape: "" };
        continue;
      }
      out.push(Object.assign({}, r, dm ? { shape: "diamond" } : {}));
      if (dm) { dec = out.length - 1; used = {}; } else dec = -1;
    }
    if (pending) out.push(pending);
    out.forEach((r) => { delete r._shift; });
    return out;
  }

  // "repeating steps (c) to (g) for multiple sample locations" becomes a decision whose
  // branch loops back to step (c). The steps are found by their claim letters (a), (b), …
  function claimLoops(rows) {
    const tops = rows.filter((r) => !r.level);
    const RE = /^(?:repeating|reiterating|iterating|performing\s+again)\s+(?:the\s+)?(?:steps?|acts?|operations?)\s+(?:of\s+)?\(?([a-z]{1,2}|[ivx]{1,5}|\d{1,2})\)?(?:\s*(?:,|to|through|thru|-|–|and)\s*\(?(?:[a-z]{1,2}|[ivx]{1,5}|\d{1,2})\)?)*\s*,?\s*(.*)$/i;
    const out = [];
    for (const r of rows) {
      const m = !r.level && String(r.text).match(RE);
      let target = null;
      if (m) {
        const lab = m[1].toLowerCase();
        target = tops.find((t) => t._lab === lab && t !== r) || null;
        if (!target && /^[a-z]$/.test(lab)) { const c = tops[lab.charCodeAt(0) - 97]; if (c && c !== r) target = c; }
      }
      if (!target) { out.push(r); continue; }
      const rest = m[2].split(",")[0].trim();
      let q = "Repeat?", loopOn = "Yes", mm;
      if ((mm = rest.match(/^until\s+(.+)$/i))) { q = askForm(mm[1]); loopOn = "No"; }
      else if ((mm = rest.match(/^(?:for|at|on|in)\s+(?:each\s+of\s+|all\s+)?(?:each|every|all|multiple|several|a\s+plurality\s+of|plural|additional|other|further|more|one\s+or\s+more|remaining|subsequent)\s+(?:(?:other|additional|further|remaining)\s+)?(.+?)(?:\s+(?:in|of|within|across|on|along|at|throughout|over)\b.*)?$/i))) q = "More " + plural(mm[1]) + "?";
      else if ((mm = rest.match(/\b(\w+)\s+times\b/i))) { q = "Repeated " + mm[1] + " times?"; loopOn = "No"; }
      const back = "-> " + (target.num || target.text);
      out.push({ level: 0, text: q, num: "", shape: "" });
      if (loopOn === "Yes") out.push({ level: 1, text: "Yes: " + back, num: "", shape: "" }, { level: 1, text: "No:", num: "", shape: "" });
      else out.push({ level: 1, text: "Yes:", num: "", shape: "" }, { level: 1, text: "No: " + back, num: "", shape: "" });
    }
    return out;
  }

  // A long claim step -> a box label of about a dozen words, in the claim's own words:
  // drops "using X, …" lead-ins, trailing "the wave being …" clauses and adverbs, writes an
  // acronym in place of its spelled-out form, then trims prepositional phrases from the
  // end of the longest part until the label is short enough.
  const PREPS = new Set("of in at for through from between on into within across along over under by with based using via among per during after before throughout".split(" "));
  const ARTS = new Set(["a", "an", "the", "said", "each", "and", "or", "at"]);
  function shortLabel(text, cap) {
    cap = cap || 12;
    let t = String(text || "").replace(/\s+/g, " ").trim();
    const words = (x) => x.split(/\s+/).filter(Boolean).length;
    if (words(t) <= cap) return t;
    const orig = t;
    t = t.replace(/,\s+(?:the|each|said|a|an)\s+(?:[\w%()\/-]+\s+){0,8}?(?:being|having been|is|are|was|were|comprising|including|\w+ing)\b.*$/i, "");
    t = t.replace(/^(?:using|with|by|via|based on|by means of|employing)\s+[^,]+(?:,[^,]+)*?,\s+(?=\w+ing\b)/i, "");
    t = t.replace(/^using\s+(?:the|a|an|said)\s+(?:[\w-]+\s+){0,3}?(?:system|device|apparatus|unit|module|processor|sensor|tool|machine|antenna|controller|computer|circuit|instrument|probe|camera|scanner|detector)\s+(?=\w+ing\b)/i, "");
    t = t.replace(/^\w+ly\s+(?=\w+ing\b)/i, "");
    t = t.replace(/(\b(?:a|an|the|said)\s+)((?:[^\s(]+\s+){1,7}?)\(([A-Z0-9][A-Z0-9-]{1,9})\)/g, "$1$3");
    t = t.replace(/\b(\w+ing)\b([^,]*?)\s+and\s+\1\s+/gi, "$1$2 and ");
    t = t.replace(/\s*,\s*$/, "").trim();
    // protect "between A and B" so it is cut as one phrase
    t = t.replace(/\bbetween\s+([^,]+?)\s+and\s+/gi, "between $1 \u0001 ");
    let parts = t.split(/\s+and\s+(?=(?:a|an|the|said)\s|\w+ing\b)/i).map((x) => x.split(" "));
    const total = () => parts.reduce((n, p) => n + p.filter((w) => w !== "\u0001").length, 0);
    let guard = 0;
    while (total() > cap && guard++ < 40) {
      let best = -1, bestAt = -1;
      parts.forEach((p, k) => {
        for (let i = p.length - 1; i >= 3; i--) {
          const w = p[i].toLowerCase().replace(/[^a-z]/g, ""), prev = (p[i - 1] || "").toLowerCase();
          const prep = PREPS.has(w) || (w === "to" && !VERBS.has((p[i + 1] || "").toLowerCase()));
          const ger = /ing$/.test(w) && w.length > 5 && !ARTS.has(prev) && !/ing$/.test(prev) && !/^(?:housing|bearing|coating|opening|building|ceiling|clothing|packaging|wiring|padding|setting|string|spring|lining|fitting|casing|ring|thing|during|including)$/.test(w);
          if (prep || ger) { if (best < 0 || p.length > parts[best].length) { best = k; bestAt = i; } break; }
        }
      });
      if (best < 0) break;
      parts[best] = parts[best].slice(0, bestAt);
      while (parts[best].length > 2 && /^(?:based|according|due|relative|corresponding|and|or|the|a|an|said)$/i.test(parts[best][parts[best].length - 1])) parts[best].pop();
    }
    t = parts.map((p) => p.join(" ")).join(" and ").replace(/\s*\u0001\s*/g, " and ").replace(/[\s,;:]+$/, "").trim();
    return t ? upFirst(t) : orig;
  }

  // "calculating" -> "calculate", "transmitting" -> "transmit", "generating" -> "generate"
  function gerundBase(w) {
    const l = String(w).toLowerCase();
    if (!/ing$/.test(l) || l.length < 6) return null;
    const b = l.slice(0, -3), known = (x) => VERBS.has(x) || MORE_VERBS.has(x);
    if (known(b)) return b;
    if (known(b + "e")) return b + "e";
    if (/([bcdfgklmnprstvz])\1$/.test(b) && !/(?:ll|ss|ff|zz)$/.test(b)) return b.slice(0, -1);
    if (/(?:at|iz|ys|iv|ur|uc|ag|rg|lv|rv|ov|ac|bl|pl|tl|dl|gl|ut|id|ud|in|ar|or|os|ag|om|um)$/.test(b) && !/(?:ain|ein|oin|ear|oor)$/.test(b)) return b + "e";
    return b;
  }
  // A claim step -> a short command of about seven words ("Calculate transmission angle and
  // reference reflection coefficient"), the way flowchart boxes are usually written.
  const KEEP_OF = /^(?:change|changes|amount|number|level|degree|rate|percent|percentage|value|values|ratio|portion|part|type|set|series|pair|plurality|map|plot)$/i;
  function commandLabel(text, cap) {
    cap = cap || 7;
    let t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return t;
    const orig = t;
    // "a map of X, the map indicating Y" -> "a map indicating Y"
    t = t.replace(/^(.*?\b(\w{3,}))\b([^,]*),\s+(?:the|said)\s+(?:[\w-]+\s+){0,4}?\2\s+(indicating|showing|representing|depicting|identifying|illustrating)\s+(.+)$/i, "$1 $4 $5");
    t = t.replace(/,\s+(?:the|each|said|a|an)\s+(?:[\w%()\/-]+\s+){0,8}?(?:being|having been|is|are|was|were|comprising|including|\w+ing)\b.*$/i, "");
    t = t.replace(/^(?:using|with|by|via|based on|by means of|employing)\s+[^,]+(?:,[^,]+)*?,\s+(?=\w+ing\b)/i, "");
    t = t.replace(/^using\s+(?:the|a|an|said)\s+(?:[\w-]+\s+){0,3}?(?:system|device|apparatus|unit|module|processor|sensor|tool|machine|antenna|controller|computer|circuit|instrument|probe|camera|scanner|detector)\s+(?=\w+ing\b)/i, "");
    t = t.replace(/^\w+ly\s+(?=\w+ing\b)/i, "");
    t = t.replace(/(\b(?:a|an|the|said)\s+)((?:[^\s(]+\s+){1,7}?)\(([A-Z0-9][A-Z0-9-]{1,9})\)/g, "$1$3");
    t = t.replace(/\b(\w+ing)\b([^,]*?)\s+and\s+\1\s+/gi, "$1$2 and ");
    t = t.replace(/\b(\w+ing)\s+(?:from|in|into|on|onto|with)\s+(?:the|said)\s+[\w-]+\s+(?=(?:a|an|the|said)\b)/gi, "$1 ");
    // "transmitting and receiving a wave to obtain a measurement" -> "obtain a measurement"
    const pm = t.match(/^[^,]*?\s+to\s+(obtain|determine|produce|generate|form|create|acquire|measure|compute|calculate|identify|detect|provide|establish)\s+(.+)$/i);
    if (pm) t = pm[1] + " " + pm[2];
    t = t.replace(/\s*,\s*$/, "").trim();
    // commands, not gerunds; no articles
    t = t.split(" ").map((w, i, a) => { const g = (i === 0 || /^(?:and|or|then)$/i.test(a[i - 1])) && gerundBase(w); return g || w; }).join(" ");
    t = t.replace(/\bat least one\s+/gi, "").replace(/\b(?:a|an|the|said)\s+/gi, "").replace(/\s+/g, " ").trim();
    t = t.replace(/\bbetween\s+([^,]+?)\s+and\s+/gi, "between $1 \u0001 ");
    let parts = t.split(/\s+and\s+(?=\S)/i).map((x) => x.split(" "));
    // keep "transmit and receive" together: a part of one word joins the next
    for (let k = 0; k < parts.length - 1; k++) if (parts[k].length === 1) { parts[k + 1] = parts[k].concat(["and"], parts[k + 1]); parts.splice(k, 1); k--; }
    const total = () => parts.reduce((n, p) => n + p.filter((w) => w !== "\u0001" && w.toLowerCase() !== "and").length, 0);
    let guard = 0;
    while (total() > cap && guard++ < 40) {
      let best = -1, bestAt = -1;
      parts.forEach((p, k) => {
        for (let i = p.length - 1; i >= 2; i--) {
          const w = p[i].toLowerCase().replace(/[^a-z]/g, ""), prev = (p[i - 1] || "");
          if (KEEP_OF.test(prev) && /^(?:of|in)$/.test(w)) continue;
          const prep = PREPS.has(w) || (w === "to" && !VERBS.has((p[i + 1] || "").toLowerCase()));
          const ger = /ing$/.test(w) && w.length > 5 && !/^(?:and|or)$/i.test(prev) && !/^(?:housing|bearing|coating|opening|building|ceiling|clothing|packaging|wiring|padding|setting|string|spring|lining|fitting|casing|thing|during|including)$/.test(w);
          if (prep || ger) { if (best < 0 || p.length > parts[best].length) { best = k; bestAt = i; } break; }
        }
      });
      if (best < 0) break;
      const removed = parts[best].length - bestAt;
      if (total() <= cap + 2 && removed * 2 > total()) break;
      parts[best] = parts[best].slice(0, bestAt);
      while (parts[best].length > 2 && (/^(?:based|according|due|relative|corresponding|and|or|to)$/i.test(parts[best][parts[best].length - 1]) || PREPS.has(parts[best][parts[best].length - 1].toLowerCase()))) parts[best].pop();
    }
    t = parts.map((p) => p.join(" ")).join(" and ").replace(/\s*\u0001\s*/g, " and ").replace(/[\s,;:]+$/, "").trim();
    return t ? upFirst(t) : orig;
  }

  // A claim set -> one figure per independent method claim. Dependent claims are folded
  // in: "further comprising" adds steps, "wherein" becomes a sub-step of the step it is about.
  function claimsToFigures(text, opt) {
    const claims = splitClaims(text), byN = {};
    claims.forEach((c) => { byN[c.n] = c; });
    const rootOf = (c) => { let g = 0; while (c.parent != null && byN[c.parent] && g++ < 60) c = byN[c.parent]; return c; };
    const indep = claims.filter((c) => c.parent == null || !byN[c.parent]);
    let heads = indep.filter((c) => /^(?:an?|the|one or more)?\s*(?:[\w-]+[\s,]+){0,6}?(?:method|process)\b/i.test(c.text));
    if (!heads.length) heads = indep.slice(0, 1);
    return heads.map((h) => {
      const rows = parseClaim(h.text), owner = rows.map(() => h.n);
      let folded = 0;
      for (const d of claims) {
        if (d === h || d.parent == null || rootOf(d) !== h) continue;
        folded++;
        const body = d.text.replace(/\s*\n\s*/g, " ").replace(/^.*?\bclaims?\s+\d{1,3}(?:\s*(?:,|or|and|to|-|through)\s*\d{1,3})*\s*,?\s*/i, "");
        const fm = body.match(/^(?:and\s+)?(?:further\s+(?:compris(?:ing|es)|includ(?:ing|es))|(?:compris(?:ing|es)|includ(?:ing|es))\s+the\s+further\s+steps?\s+of)\s*:?\s*/i);
        if (fm) { for (const r of parseClaim(body.slice(fm[0].length), { body: true })) { rows.push(r); owner.push(d.n); } continue; }
        const sub = cleanClause(body); if (!sub) continue;
        const want = stems(sub); let best = -1, bestScore = 0;
        rows.forEach((r, i) => {
          if (r.level) return;
          const have = new Set(stems(r.text));
          const sc = want.filter((w) => have.has(w)).length + (owner[i] === d.parent ? 0.5 : 0);
          if (sc > bestScore) { bestScore = sc; best = i; }
        });
        if (best < 0 || bestScore < 1) { for (let i = rows.length - 1; i >= 0; i--) if (!rows[i].level) { best = i; break; } }
        if (best < 0) { rows.push({ level: 0, text: upFirst(sub), num: "", shape: "" }); owner.push(d.n); continue; }
        let at = best + 1; while (at < rows.length && rows[at].level > 0) at++;
        rows.splice(at, 0, { level: 1, text: sub, num: "", shape: "" }); owner.splice(at, 0, d.n);
      }
      let out = claimDecisions(rows);
      if (!(opt && opt.short === false)) out.forEach((r, i) => {
        const k = rowKind(out, i), dm = r.text.match(/^(?:determin(?:ing|e)|check(?:ing)?|verify(?:ing)?|detect(?:ing)?|decid(?:ing|e)|evaluat(?:ing|e)|test(?:ing)?)\s+(?:whether|if)\s+(.+)$/i);
        if (k === "decision" && dm) { r.text = askForm(dm[1]); r.shape = ""; return; }
        if ((k === "step" || k === "sub") && !/^where(?:in|by)\b/i.test(r.text) && !/^(?:repeat|reiterat|iterat|performing\s+again)/i.test(r.text)) r.text = commandLabel(r.text);
      });
      out = claimLoops(out);
      out.forEach((r) => { delete r._lab; });
      return { claim: h.n, rows: out, folded };
    });
  }

  // "The water has reached the set temperature" -> "Has the water reached the set temperature?"
  function askForm(t) {
    t = String(t).trim().replace(/\?\s*$/, "");
    const m = t.match(/^((?:the|a|an|this|that|each|any|it|they|there)\b.*?)\s+(is|are|was|were|has|have|can|will|does|do)\s+(.+)$/i);
    const subj = (x) => (/^(?:it|they|there)$/i.test(x) ? x.toLowerCase() : x.charAt(0).toLowerCase() + x.slice(1));
    if (m && /^ha(?:s|ve)$/i.test(m[2]) && !/^(?:\w+(?:ed|en)|been|done|gone|made|sent|met|run|set|got|found|held|kept|left|lost|paid|read|built|bought|caught|taught|won)\b/i.test(m[3]) && m[1].split(/\s+/).length <= 6)
      return (/^has$/i.test(m[2]) ? "Does " : "Do ") + subj(m[1]) + " have " + m[3] + "?";
    if (m && m[1].split(/\s+/).length <= 6) return upFirst(m[2].toLowerCase()) + " " + (/^(?:it|they|there)$/i.test(m[1]) ? m[1].toLowerCase() : m[1].charAt(0).toLowerCase() + m[1].slice(1)) + " " + m[3] + "?";
    const w = t.split(/\s+/);
    if (/^(?:the|a|an|this|that|each|any|it)$/i.test(w[0])) for (let i = /^it$/i.test(w[0]) ? 1 : 2; i <= Math.min(4, w.length - 1); i++) {
      const bv = baseVerb(w[i]);
      if (bv && (VERBS.has(bv) || MORE_VERBS.has(bv))) return "Does " + subj(w.slice(0, i).join(" ")) + " " + bv + (w.length > i + 1 ? " " + w.slice(i + 1).join(" ") : "") + "?";
    }
    return upFirst(t) + "?";
  }
  const plural = (n) => (/s$/i.test(n) ? n : /[^aeiou]y$/i.test(n) ? n.slice(0, -1) + "ies" : /(?:x|ch|sh|z)$/i.test(n) ? n + "es" : n + "s");
  // "It turns the heater on" / "The thermostat reads the temperature" -> "Turn the heater on" / "Read the temperature"
  const MORE_VERBS = new Set("turn wait go sound raise lower switch keep call pass give take make ask tell use try leave hold push pull press release pump flow warn beep ring lift drop pour steep brew boil stir add show print email text log ping sleep pause resume reboot restart refresh notify fail succeed exceed exist contain equal remain need want work".split(" "));
  function baseVerb(w) {
    const l = w.toLowerCase();
    if (/[^aeiou]ies$/.test(l)) return l.slice(0, -3) + "y";
    if (/(?:sh|ch|x|ss|zz|o)es$/.test(l)) return l.slice(0, -2);
    if (/[^s]s$/.test(l)) return l.slice(0, -1);
    return null;
  }
  function imperative(t) {
    const r = imperative0(t);
    return RE_GOTO.test(r) || RE_TERM.test(r) ? t : r;
  }
  function imperative0(t) {
    const w = String(t).split(/\s+/);
    const pron = /^(?:it|they|he|she|we|you|i)$/i.test(w[0]);
    if (w.length > 1) {
      const b0 = baseVerb(w[0]);
      if (b0 && (VERBS.has(b0) || MORE_VERBS.has(b0)) && !/^(?:is|are|was|were|of|and)$/i.test(w[1])) return upFirst(b0 + " " + w.slice(1).join(" "));
      if (pron && !baseVerb(w[1]) && !/^(?:is|are|was|were|has|have|can|will|must|should|may)$/i.test(w[1])) return upFirst(w.slice(1).join(" "));
    }
    for (let i = pron ? 1 : 2; i <= Math.min(pron ? 1 : 4, w.length - 1); i++) {
      if (!pron && !/^(?:the|a|an|this|our|my|your|its)$/i.test(w[0])) break;
      const b = baseVerb(w[i] || "");
      if (b && (pron || VERBS.has(b) || MORE_VERBS.has(b))) return upFirst(b + (w.slice(i + 1).length ? " " + w.slice(i + 1).join(" ") : ""));
    }
    return t;
  }

  // A plain description ("First the user signs in. If the password is wrong, ...") -> rows.
  function parseDescription(text, opt) {
    const t = String(text || "").replace(/\r/g, "").trim();
    if (!t) return [];
    const BUL = /^(?:[-*•–]|\d+[.)]|step\s+\d+[:.)]?)\s+/i;
    let items = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (!(items.length > 1 && items.filter((s) => BUL.test(s)).length >= items.length * 0.6)) items = t.replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/);
    const LEAD = /^(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|then|next|after that|afterwards?|finally|lastly|and|also|once (?:that is )?done|to (?:start|begin))\s*,?\s+/i;
    const tidy = (s) => { s = s.replace(BUL, ""); let g = 0; while (LEAD.test(s) && g++ < 4) s = s.replace(LEAD, ""); return s.replace(/[\s.;:,!]+$/, "").trim(); };
    const rows = [], row = (level, text) => rows.push({ level, text, num: "", shape: "" });
    const steps = (level, s) => {
      for (let p of String(s).split(/\s*[;,]?\s+(?:and\s+)?then,?\s+|;\s+|,?\s+and\s+(?=(?:go(?:es)?|return(?:s)?|loops?|jumps?)\s+back\b|(?:repeat|start(?:s)?\s+over)\b)/i)) {
        p = tidy(p); if (!p) continue;
        const g = p.match(/^(?:go(?:es)?|return(?:s)?|loops?|jumps?)\s+back\s+to\s+(?:the\s+)?(.+)$/i) || p.match(/^(?:repeat|start(?:s)? over)\s*(?:from\s+)?(?:the\s+)?(.*)$/i);
        if (g) rows.push({ level, text: "-> ", num: "", shape: "", _to: g[1].trim() }); else row(level, imperative(upFirst(p)));
      }
    };
    let lastDec = -1;
    for (const item of items) {
      const s = tidy(item); if (!s) continue;
      const other = s.match(/^(?:otherwise|else|if not)\b,?\s*(.+)$/i);
      if (other && lastDec >= 0) { row(1, "No:"); steps(2, other[1]); lastDec = -1; continue; }
      const m = s.match(/^(if|in case|unless)\s+(.+?),\s*(?:then\s+)?(.+)$/i);
      if (m) {
        const parts = m[3].split(/\s*[;,.]\s*(?:otherwise|else|if not),?\s+/i), flip = /^unless$/i.test(m[1]);
        row(0, askForm(m[2])); row(1, flip ? "No:" : "Yes:"); steps(2, parts[0]);
        if (parts[1]) { row(1, flip ? "Yes:" : "No:"); steps(2, parts.slice(1).join(", ")); lastDec = -1; } else lastDec = flip ? -1 : rows.length;
        continue;
      }
      lastDec = -1; steps(0, s);
    }
    // "go back to step 2" / "go back to the sign-in": point the loop at a step by its text
    const tops = rows.filter((r) => r.level === 0 && r._to == null);
    for (const r of rows) {
      if (r._to == null) continue;
      const to = r._to.replace(/^step\s+/i, ""); let target = null;
      if (/^\d+$/.test(to)) target = tops[+to - 1];
      else if (!to || /^(?:start|beginning|top)$/i.test(to)) target = tops[0];
      else { const want = stems(to); let bs = 0; for (const c of rows) { if (c._to != null || /:$/.test(c.text)) continue; const have = new Set(stems(c.text)); const sc = want.filter((w) => have.has(w)).length; if (sc > bs) { bs = sc; target = c; } } }
      r.text = "-> " + (target ? target.text : to); delete r._to;
    }
    if (!(opt && opt.terminators === false) && rows.length) {
      rows.unshift({ level: 0, text: "Start", num: "", shape: "" });
      const lastTop = rows.filter((r) => r.level === 0).pop();
      if (!RE_GOTO.test(lastTop.text) && !RE_END.test(lastTop.text)) row(0, "End");
    }
    return rows;
  }

  // Description, one claim, or a claim set -> { kind, figures: [{rows, claim, folded}] }
  function textToFigures(text, opt) {
    const t = String(text || "").trim();
    if (!t) return { kind: "empty", figures: [] };
    const claimy = /^\s*(?:claim\s+)?\d{1,3}\s*[.)]\s+(?:An?|The|One)\b/im.test(t)
      || (/\b(?:compris(?:ing|es)|consist(?:ing|s) of)\b/i.test(t) && /;/.test(t)) || /\b(?:of|in|to)\s+claim\s+\d/i.test(t);
    if (claimy) return { kind: "claims", figures: claimsToFigures(t, opt).filter((f) => f.rows.length) };
    const rows = parseDescription(t, opt);
    return { kind: "description", figures: rows.length ? [{ rows }] : [] };
  }

  // ------------------------------------------------------------------ tree
  function buildTree(rows) {
    const nodes = rows.map((r, i) => ({ r, i, kids: [] })), top = [], st = [];
    for (const n of nodes) {
      while (st.length && st[st.length - 1].r.level >= n.r.level) st.pop();
      (st.length ? st[st.length - 1].kids : top).push(n);
      st.push(n);
    }
    const seq = (list) => list.map(item);
    function item(n) {
      const t = (n.r.text || "").trim();
      let m;
      if ((m = t.match(RE_CONN))) return { kind: "conn", ri: n.i, letter: m[1].toUpperCase(), text: m[1].toUpperCase(), num: "" };
      if ((m = t.match(RE_GOTO))) return { kind: "goto", ri: n.i, target: m[1].trim() };
      if (isDecisionRow(n.r)) {
        return {
          kind: "decision", ri: n.i, text: t, num: n.r.num, shape: n.r.shape,
          branches: n.kids.map((c) => {
            const ct = (c.r.text || "").trim(), k = ct.indexOf(":");
            const label = (k < 0 ? ct : ct.slice(0, k)).trim(), rest = k < 0 ? "" : ct.slice(k + 1).trim();
            let items = [];
            if (rest) {
              const g = rest.match(RE_GOTO);
              items.push(g ? { kind: "goto", ri: c.i, target: g[1].trim() } : { kind: "step", ri: c.i, text: rest, num: "", shape: "", subs: [] });
            }
            return { label, ri: c.i, items: items.concat(seq(c.kids)) };
          }),
        };
      }
      if (RE_TERM.test(t)) return { kind: "term", ri: n.i, text: t, num: n.r.num, shape: n.r.shape, isEnd: RE_END.test(t), subs: [] };
      const subs = [];
      (function flat(list) { for (const c of list) { subs.push({ ri: c.i, text: (c.r.text || "").trim(), num: c.r.num, shape: c.r.shape }); flat(c.kids); } })(n.kids);
      return { kind: "step", ri: n.i, text: t, num: n.r.num, shape: n.r.shape, subs };
    }
    return seq(top);
  }

  // ------------------------------------------------------------------ geometry
  function wrap(text, maxW, m) {
    const lines = [];
    for (const para of String(text).split(/\n/)) {
      let cur = "";
      for (const w of para.split(/\s+/).filter(Boolean)) {
        const t = cur ? cur + " " + w : w;
        if (!cur || m(t) <= maxW) cur = t; else { lines.push(cur); cur = w; }
      }
      lines.push(cur);
    }
    return lines.length ? lines : [""];
  }

  function shapeGeom(shape, text, S, m, widthScale) {
    const fs = S.fontSize, lh = fs * 1.25, p = S.padding, bw = S.boxWidth * PT_CM * (widthScale || 1);
    const size = (maxW) => { const lines = wrap(text, Math.max(maxW, fs * 2), m); return { lines, tw: Math.max.apply(null, lines.map(m)), th: lines.length * lh }; };
    let g, w, h, inset = 0;
    if (shape === "diamond") {
      g = size(bw * 0.6 - 2 * p); w = Math.max(bw, (g.tw + 2 * p) / 0.72);
      h = (g.th + 2 * p) / (1 - (g.tw + 2 * p) / w); h = Math.max(h, lh + 2 * p + 8);
    } else if (shape === "oval") {
      g = size(bw * 0.78 - 2 * p); w = Math.max(bw, (g.tw + 2 * p) / 0.88);
      h = (g.th + 2 * p) / Math.sqrt(1 - Math.pow((g.tw + 2 * p) / w, 2));
    } else if (shape === "circle") {
      g = size(bw * 0.5); w = h = Math.sqrt(g.tw * g.tw + g.th * g.th) + 2 * Math.max(p * 0.6, 3);
    } else if (shape === "stadium") {
      g = size(bw - 2 * p - lh); h = g.th + 2 * p; w = Math.max(g.tw + 2 * p + h * 0.7, bw * 0.45);
    } else {
      inset = shape === "parallelogram" ? Math.min(14, bw * 0.1) : shape === "hexagon" ? 13 : 0;
      g = size(bw - 2 * p - 2 * inset); w = bw; h = g.th + 2 * p;
    }
    return { shape, w, h, lines: g.lines, tw: g.tw, th: g.th, inset, over: g.tw > w - (shape === "diamond" || shape === "oval" ? 0 : 2 * inset) + 0.5 };
  }

  const K = 0.5522847498;
  function shapePath(shape, cx, cy, w, h, inset) {
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    const rr = (r) => [["M", x0 + r, y0], ["L", x1 - r, y0], ["C", x1 - r + r * K, y0, x1, y0 + r - r * K, x1, y0 + r], ["L", x1, y1 - r],
      ["C", x1, y1 - r + r * K, x1 - r + r * K, y1, x1 - r, y1], ["L", x0 + r, y1], ["C", x0 + r - r * K, y1, x0, y1 - r + r * K, x0, y1 - r],
      ["L", x0, y0 + r], ["C", x0, y0 + r - r * K, x0 + r - r * K, y0, x0 + r, y0], ["Z"]];
    switch (shape) {
      case "rounded": return rr(Math.min(9, h / 3, w / 3));
      case "stadium": return rr(Math.min(h, w) / 2);
      case "diamond": return [["M", cx, y0], ["L", x1, cy], ["L", cx, y1], ["L", x0, cy], ["Z"]];
      case "oval": case "circle": {
        const a = w / 2, b = h / 2;
        return [["M", cx, y0], ["C", cx + a * K, y0, x1, cy - b * K, x1, cy], ["C", x1, cy + b * K, cx + a * K, y1, cx, y1],
          ["C", cx - a * K, y1, x0, cy + b * K, x0, cy], ["C", x0, cy - b * K, cx - a * K, y0, cx, y0], ["Z"]];
      }
      case "parallelogram": return [["M", x0 + inset, y0], ["L", x1, y0], ["L", x1 - inset, y1], ["L", x0, y1], ["Z"]];
      case "hexagon": return [["M", x0 + inset, y0], ["L", x1 - inset, y0], ["L", x1, cy], ["L", x1 - inset, y1], ["L", x0 + inset, y1], ["L", x0, cy], ["Z"]];
      default: return [["M", x0, y0], ["L", x1, y0], ["L", x1, y1], ["L", x0, y1], ["Z"]];
    }
  }
  const round2 = (v) => Math.round(v * 100) / 100;
  function pathD(cmds) { return cmds.map((c) => c[0] + c.slice(1).map(round2).join(" ")).join(" "); }

  // Where the numeral's lead line touches the shape, for a numeral on the given side.
  function numeralSpot(sh, side, numW, fs) {
    const s = side === "left" ? -1 : 1, round = sh.shape === "oval" || sh.shape === "circle";
    let ax, ay;
    if (sh.shape === "diamond") { ax = sh.cx + s * sh.w / 4; ay = sh.cy - sh.h / 4; }
    else if (round) { ax = sh.cx + s * sh.w / 2 * 0.7071; ay = sh.cy - sh.h / 2 * 0.7071; }
    else { ax = sh.cx + s * sh.w / 2; ay = sh.cy - sh.h / 2 + Math.min(sh.h * 0.3, 9); if (sh.shape === "parallelogram") ax -= s * 0 + (s > 0 ? 0 : -sh.inset * (1 - Math.min(sh.h * 0.3, 9) / sh.h)); }
    const tx = ax + s * 10, base = ay - 5 + fs * 0.2;
    return { ax, ay, tx, base, x0: s > 0 ? tx : tx - numW, x1: s > 0 ? tx + numW : tx, y0: base - fs * 0.8, y1: base + fs * 0.25 };
  }
  function numeralExtra(g, side, numW, fs) {
    const f = numeralSpot({ shape: g.shape, cx: 0, cy: 0, w: g.w, h: g.h, inset: g.inset }, side, numW, fs);
    return Math.max(0, (side === "left" ? -f.x0 : f.x1) - g.w / 2 + 2);
  }

  // ------------------------------------------------------------------ layout
  function layout(fig, measure) {
    const L = layout1(fig, measure);
    // columns need narrower boxes on a letter sheet: try them before giving up on columns
    if (!L.columns && !fig._narrow && L.style.wrap !== "off") {
      const real = L.tree.filter((it) => it.kind !== "goto" && it.kind !== "conn").length;
      if (real >= 6 && !L.tree.some((it) => it.kind === "conn")) {
        const nv = (x) => x.issues.filter((i) => i.sev === "violation").length;
        for (const bw of [5.5, 5, 4.5]) {
          if (bw >= L.style.boxWidth) continue;
          const N = layout1(Object.assign({}, fig, { _narrow: true, style: Object.assign({}, fig.style, { boxWidth: bw }) }), measure);
          if (N.columns && N.pages.length === 1 && nv(N) <= nv(L)) return N;
        }
      }
    }
    return L;
  }
  function layout1(fig, measure) {
    const S = normStyle(fig.style), fontDef = FONTS[S.font];
    const m = (t, size) => measure(String(t), S.font, size || S.fontSize);
    const paper = PAPERS[S.paper];
    const mg = { top: S.margins.top * PT_CM, left: S.margins.left * PT_CM, right: S.margins.right * PT_CM, bottom: S.margins.bottom * PT_CM };
    const use = { x: mg.left, y: mg.top, w: paper.w - mg.left - mg.right, h: paper.h - mg.top - mg.bottom };
    const issues = [], fs = S.fontSize, lh = fs * 1.25;
    const capSize = Math.max(fs * 1.3, fs + 3), capH = capSize * 1.25, capGap = S.gapY * 0.8;
    const rows = fig.rows || [], tree = buildTree(rows);
    const shapeFor = (it) => it.shape || (it.kind === "decision" ? S.decisionShape : it.kind === "term" ? S.termShape : it.kind === "conn" ? "circle" : S.shape);
    const shown = (it) => (S.numeralPos === "inside" && it.num ? it.num + ": " : "") + it.text;
    const side = S.numeralPos === "left" ? "left" : "right";
    const numExtra = (it, g) => (it.num && S.numeralPos !== "inside") ? numeralExtra(g, side, m(it.num), fs) : 0;
    const connD = shapeGeom("circle", "A", S, m).w;

    // ---- measure
    function measureItem(it) {
      if (it.kind === "goto") { it.wL = it.wR = it.h = 0; return; }
      if (it.kind === "decision") return measureDecision(it);
      const hasSubs = it.subs && it.subs.length, sp = Math.max(S.padding, 4);
      let shp = shapeFor(it); if (hasSubs && shp !== "rounded") shp = "rect";
      const g = it.g = shapeGeom(shp, shown(it), S, m);
      if (hasSubs) {
        // "wherein" sub-steps are boxes nested inside their step's box
        const bw = S.boxWidth * PT_CM, scale = (bw - 2 * sp) / bw;
        g.textH = g.h; let h = g.h - S.padding + sp * 0.4;
        for (const s of it.subs) {
          const ss = s.shape && s.shape !== "diamond" ? s.shape : "rect";
          s.g = shapeGeom(/^(rect|rounded|parallelogram|hexagon)$/.test(ss) ? ss : "rect", (s.num ? s.num + ": " : "") + s.text, S, m, scale);
          s.dy = h; h += s.g.h + sp * 0.7;
        }
        g.h = h - sp * 0.7 + sp;
      }
      const ex = numExtra(it, g);
      it.wL = g.w / 2 + (side === "left" ? ex : 0); it.wR = g.w / 2 + (side === "right" ? ex : 0); it.h = g.h;
    }
    function measureSeq(items) {
      let wL = 0, wR = 0, h = 0;
      items.forEach((it, i) => { measureItem(it); wL = Math.max(wL, it.wL); wR = Math.max(wR, it.wR); h += it.h + (i ? gapBefore(it) : 0); });
      return { wL, wR, h };
    }
    const gapBefore = (it) => (it.kind === "goto" ? S.gapY * 0.5 : S.gapY);
    function measureDecision(d) {
      const g = d.g = shapeGeom(shapeFor(d), shown(d), S, m), ex = numExtra(d, g), hw = g.w / 2;
      d.gotos = []; const cols = [];
      for (const b of d.branches) {
        if (b.items.length === 1 && b.items[0].kind === "goto") d.gotos.push(b);
        else { b.m = measureSeq(b.items); cols.push(b); }
      }
      let down = cols.find((b) => b.items.length) || cols[0];
      const others = cols.filter((b) => b !== down);
      d.down = down; d.right = []; d.left = [];
      others.forEach((b, i) => ((i === 1 && !d.gotos.length) ? d.left : d.right).push(b));
      const dm = down ? down.m : { wL: 0, wR: 0, h: 0 };
      let xr = Math.max(hw + (side === "right" ? ex : 0), dm.wR), xl = Math.max(hw + (side === "left" ? ex : 0), dm.wL);
      for (const b of d.right) { const lab = m(b.label) + 12; b.x = xr + Math.max(S.gapX, b.items.length ? 0 : lab) + b.m.wL; xr = b.x + b.m.wR; if (!b.items.length) xr = Math.max(xr, b.x + 4); }
      for (const b of d.left) { const lab = m(b.label) + 12; b.x = -(xl + Math.max(S.gapX, b.items.length ? 0 : lab) + b.m.wR); xl = -b.x + b.m.wL; }
      if (down) down.x = 0;
      const ch = Math.max(0, ...cols.map((b) => b.m.h));
      d.colTop = g.h + S.gapY; d.wL = xl; d.wR = xr; d.h = cols.length ? d.colTop + ch : g.h;
      if (cols.length && ch === 0) d.h = g.h + S.gapY * 0.4;
    }

    // ---- place
    function newCtx(page) { return { page, shapes: [], edges: [], labels: [], gotos: [], vert: {} }; }
    const P = (x, y) => ({ x, y });
    const last = (a) => a[a.length - 1];
    function joinTo(ports, pt, ctx) {
      if (!ports.length) return { pts: [pt], bare: true };
      const lowest = Math.max(...ports.map((p) => last(p.pts).y));
      const jy = pt.y - Math.min(S.gapY * 0.5, (pt.y - lowest) * 0.5);
      if (ports.length === 1) {
        const e = last(ports[0].pts);
        return { pts: ports[0].pts.concat(Math.abs(e.x - pt.x) < 0.5 ? [pt] : [P(e.x, jy), P(pt.x, jy), pt]) };
      }
      for (const p of ports) { const e = last(p.pts); ctx.edges.push({ pts: p.pts.concat([P(e.x, jy), P(pt.x, jy)]), arrow: false }); }
      return { pts: [P(pt.x, jy), pt] };
    }
    function connect(ports, pt, ctx) { if (ports.length) ctx.edges.push({ pts: joinTo(ports, pt, ctx).pts, arrow: true }); }
    function addShape(ctx, it, g, cx, cy, kind) {
      const sh = { shape: g.shape, cx, cy, w: g.w, h: g.h, inset: g.inset, lines: g.lines, ri: it.ri, num: S.numeralPos === "inside" ? "" : (it.num || ""), kind, over: g.over, numSide: side };
      ctx.shapes.push(sh); return sh;
    }
    function placeItem(it, ax, y, ctx) {
      if (it.kind === "decision") return placeDecision(it, ax, y, ctx);
      const g = it.g, sh = addShape(ctx, it, g, ax, y + g.h / 2, it.kind);
      if (it.kind === "conn") sh.letter = it.letter;
      if (g.textH) {
        sh.textCy = y + g.textH / 2;
        for (const s of it.subs) { const ss = addShape(ctx, s, s.g, ax, y + s.dy + s.g.h / 2, "sub"); ss.num = ""; ss.nested = true; }
      }
      return [{ pts: [P(ax, y + g.h)] }];
    }
    function placeSeq(items, ax, y, ctx, incoming) {
      let ports = incoming || [], yy = y;
      items.forEach((it, i) => {
        if (i) yy += gapBefore(it);
        if (it.kind === "goto") {
          ctx.gotos.push({ from: joinTo(ports, P(ax, yy), ctx), target: it.target, ri: it.ri });
          ports = []; return;
        }
        connect(ports, P(ax, yy), ctx);
        ports = placeItem(it, ax, yy, ctx);
        yy += it.h;
        if ((it.kind === "term" && it.isEnd) || (it.kind === "conn" && i === items.length - 1 && i > 0)) ports = [];
      });
      return ports;
    }
    function placeDecision(d, ax, y, ctx) {
      const g = d.g, cy = y + g.h / 2, sh = addShape(ctx, d, g, ax, cy, "decision");
      const bot = P(ax, y + g.h), L = P(ax - g.w / 2, cy), R = P(ax + g.w / 2, cy);
      if (!d.branches.length) return [{ pts: [bot] }];
      let out = [];
      const col = (b, pre, lab) => {
        if (b.label) ctx.labels.push(Object.assign({ text: b.label, ri: b.ri }, lab));
        if (!b.items.length) { out.push({ pts: pre }); return; }
        out = out.concat(placeSeq(b.items, ax + b.x, y + d.colTop, ctx, [{ pts: pre }]));
      };
      if (d.down) col(d.down, [bot], { x: ax + 6, y: y + g.h + fs * 0.95, anchor: "start" });
      d.right.forEach((b, i) => col(b, [R, P(ax + b.x, cy)], i === 0
        ? { x: R.x + 5, y: cy - 4, anchor: "start" } : { x: ax + b.x + 6, y: y + d.colTop - 7, anchor: "start" }));
      d.left.forEach((b) => col(b, [L, P(ax + b.x, cy)], { x: L.x - 5, y: cy - 4, anchor: "end" }));
      const free = [];
      if (!d.left.length) free.push({ pts: [L], dir: "left" });
      if (!d.right.length) free.push({ pts: [R], dir: "right" });
      for (const b of d.gotos) {
        ctx.gotos.push({ alts: free.length ? free : [{ pts: [L], dir: "left" }], target: b.items[0].target, ri: b.ri, label: b.label, key: d.ri });
      }
      return out;
    }

    // ---- pages
    tree.forEach(measureItem);
    const availH = use.h - capH - capGap, pages = [];
    const usedLetters = new Set();
    (function walk(items) { for (const it of items) { if (it.kind === "conn") usedLetters.add(it.letter); if (it.branches) it.branches.forEach((b) => walk(b.items)); } })(tree);
    const nextLetter = () => { for (let c = 65; c < 91; c++) { const l = String.fromCharCode(c); if (!usedLetters.has(l)) { usedLetters.add(l); return l; } } return "Z"; };
    const rest = (i) => { let r = 0; for (let j = i + 1; j < tree.length; j++) r += tree[j].h + gapBefore(tree[j]); return r; };
    // Long charts wrap into side-by-side columns on one sheet: the flow runs down a column,
    // then an arrow goes up the gutter to the top of the next column.
    const nrm = (x) => String(x || "").trim().replace(/^step\s+/i, "").replace(/^\((.*)\)$/, "$1").toLowerCase();
    function planColumns() {
      const n = tree.length, real = tree.filter((it) => it.kind !== "goto");
      if (S.wrap === "off" || real.length < 6 || tree.some((it) => it.kind === "conn")) return null;
      const hOf = (a, b) => { let h = 0; for (let i = a; i < b; i++) h += tree[i].h + (i > a ? gapBefore(tree[i]) : 0); return h; };
      const wOf = (a, b) => { let wL = 0, wR = 0; for (let i = a; i < b; i++) { wL = Math.max(wL, tree[i].wL); wR = Math.max(wR, tree[i].wR); } return { wL, wR }; };
      const idxOf = (t) => { const k = nrm(t); return tree.findIndex((it) => (it.num && nrm(it.num) === k) || nrm(it.text) === k); };
      const spans = [];
      tree.forEach((it, i) => {
        (function walk(x) {
          if (x.kind === "goto") { const j = idxOf(x.target); if (j >= 0) spans.push([Math.min(i, j), Math.max(i, j)]); }
          if (x.branches) x.branches.forEach((b) => b.items.forEach(walk));
        })(it);
      });
      const totalH = hOf(0, n), gutter = Math.max(S.gapX * 3.2, 56);
      const cuts = []; for (let p = 2; p <= n - 2; p++) if (tree[p].kind !== "goto") cuts.push(p);
      const opts = cuts.map((p) => [p]);
      if (real.length >= 9) for (const p of cuts) for (const q of cuts) if (q >= p + 2) opts.push([p, q]);
      let best = null;
      for (const o of opts) {
        const b = [0].concat(o, [n]), cols = []; for (let k = 0; k < b.length - 1; k++) cols.push([b[k], b[k + 1]]);
        const crossing = spans.filter(([lo, hi]) => o.some((p) => lo < p && p <= hi)).length;
        const w = cols.reduce((t, [a, c]) => { const x = wOf(a, c); return t + x.wL + x.wR; }, 0) + gutter * (cols.length - 1) + (crossing ? S.gapX * 1.4 : 0);
        const maxH = Math.max(...cols.map(([a, c]) => hOf(a, c))) + S.gapY * 0.6 + (crossing ? S.gapY : 0);
        if (w > use.w || maxH > availH) continue;
        const score = maxH + crossing * 0.15 * totalH + (cols.length - 2) * 0.12 * totalH;
        if (!best || score < best.score) best = { cols, score, gutter, wOf };
      }
      return best;
    }
    function placeColumns(plan) {
      const ctx = newCtx(0); let x = 0, ports = [], prev = null;
      plan.cols.forEach(([a, b], k) => {
        const w = plan.wOf(a, b);
        if (prev) {
          x = prev.x + prev.wR + plan.gutter + w.wL;
          if (ports.length) {
            const yb = prev.bottom + S.gapY * 0.5, lane = prev.x + prev.wR + S.gapX * 1.0, top = -S.gapY * 0.6;
            const jn = joinTo(ports, P(prev.x, yb), ctx);
            ports = [{ pts: jn.pts.concat([P(lane, yb), P(lane, top), P(x, top)]) }];
          }
        }
        const before = ctx.shapes.length;
        ports = placeSeq(tree.slice(a, b), x, 0, ctx, ports);
        const bottom = Math.max(0, ...ctx.shapes.slice(before).map((sh) => sh.cy + sh.h / 2));
        prev = { x, wR: w.wR, bottom };
      });
      return ctx;
    }
    const colPlan = planColumns();
    let ctxs;
    if (colPlan) ctxs = [placeColumns(colPlan)];
    else {
      let page = { items: [], entry: null, exit: null }, hh = 0;
      tree.forEach((it, i) => {
        if (it.kind === "conn" && i > 0 && i < tree.length - 1) {
          page.exit = it.letter; page.exitRi = it.ri; pages.push(page);
          page = { items: [], entry: it.letter, entryRi: it.ri, exit: null }; hh = connD; return;
        }
        const started = page.items.length || page.entry;
        let need = (started ? gapBefore(it) : 0) + it.h;
        const fitsAll = hh + need + rest(i) <= availH, reserve = (i < tree.length - 1 && !fitsAll) ? S.gapY + connD : 0;
        if (page.items.length && it.kind !== "goto" && hh + need + reserve > availH) {
          const l = nextLetter();
          page.exit = l; pages.push(page);
          page = { items: [], entry: l, exit: null, auto: true }; hh = connD; need = S.gapY + it.h;
        }
        page.items.push(it); hh += need;
      });
      pages.push(page);

      ctxs = pages.map((pg, pi) => {
        const ctx = newCtx(pi); let ports = [], y = 0;
        const circle = (letter, yy, ri) => { ctx.shapes.push({ shape: "circle", cx: 0, cy: yy + connD / 2, w: connD, h: connD, lines: [letter], ri: ri == null ? -1 : ri, num: "", kind: "conn", letter }); };
        if (pg.entry) { circle(pg.entry, 0, pg.entryRi); ports = [{ pts: [P(0, connD)] }]; y = connD + S.gapY; }
        ports = placeSeq(pg.items, 0, y, ctx, ports);
        if (pg.exit) {
          const bottom = Math.max(0, ...ctx.shapes.map((s) => s.cy + s.h / 2)) + S.gapY;
          if (ports.length) connect(ports, P(0, bottom), ctx);
          circle(pg.exit, bottom, pg.exitRi);
        }
        return ctx;
      });
    }

    // ---- loops and jumps
    const norm = (s) => String(s || "").trim().replace(/^step\s+/i, "").replace(/^\((.*)\)$/, "$1").toLowerCase();
    function findTarget(t) {
      const n = norm(t); if (!n) return null;
      const all = []; ctxs.forEach((c) => c.shapes.forEach((s) => all.push({ s, c })));
      const real = (x) => x.s.ri >= 0 && rows[x.s.ri];
      return all.find((x) => real(x) && x.s.kind !== "conn" && norm(rows[x.s.ri].num) === n && rows[x.s.ri].num)
        || all.find((x) => x.s.kind === "conn" && norm(x.s.letter) === n)
        || all.find((x) => real(x) && x.s.kind === "term" && norm(rows[x.s.ri].text) === n)
        || all.find((x) => real(x) && x.s.kind !== "sub" && norm(rows[x.s.ri].text) === n) || null;
    }
    const segsOf = (pts) => { const o = []; for (let i = 1; i < pts.length; i++) o.push([pts[i - 1], pts[i]]); return o; };
    const cross = (a, b, c, d) => {
      const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
      const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
      return ((d1 > 0.01 && d2 < -0.01) || (d1 < -0.01 && d2 > 0.01)) && ((d3 > 0.01 && d4 < -0.01) || (d3 < -0.01 && d4 > 0.01));
    };
    const boxOf = (s) => ({ x0: s.cx - s.w / 2, x1: s.cx + s.w / 2, y0: s.cy - s.h / 2, y1: s.cy + s.h / 2 });
    const hitsBox = (a, b, bx) => {
      const x0 = bx.x0 + 1.5, x1 = bx.x1 - 1.5, y0 = bx.y0 + 1.5, y1 = bx.y1 - 1.5;
      if (x1 <= x0 || y1 <= y0) return false;
      const inside = (p) => p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1;
      if (inside(a) || inside(b)) return true;
      const c = [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
      for (let i = 0; i < 4; i++) if (cross(a, b, c[i], c[(i + 1) % 4])) return true;
      return false;
    };
    function numBox(s) {
      if (!s.num) return null;
      const f = numeralSpot(s, s.numSide || side, m(s.num), fs);
      return { x0: Math.min(f.x0, f.ax), x1: Math.max(f.x1, f.ax), y0: f.y0, y1: Math.max(f.y1, f.ay) };
    }
    ctxs.forEach((ctx) => {
      const boxes = () => { const b = []; for (const s of ctx.shapes) { if (s.nested) continue; b.push(boxOf(s)); const n = numBox(s); if (n) b.push(n); } return b; };
      const allSegs = () => { const o = []; for (const e of ctx.edges) for (const sg of segsOf(e.pts)) o.push(sg); return o; };
      for (const g of ctx.gotos) {
        const T = findTarget(g.target), srcs = g.alts || [{ pts: g.from.pts }];
        const labelAt = (s) => {
          if (!g.label) return;
          const v = s.pts[0];
          ctx.labels.push({ text: g.label, ri: g.ri, x: v.x + (s.dir === "left" ? -5 : 5), y: v.y - 4, anchor: s.dir === "left" ? "end" : "start" });
        };
        const pick = (s) => { ctx.vert[g.key + s.dir] = (ctx.vert[g.key + s.dir] || 0) + 1; };
        const freeFirst = (list) => list.slice().sort((a, b) => (ctx.vert[g.key + a.dir] || 0) - (ctx.vert[g.key + b.dir] || 0));
        if (!T) {
          issues.push({ sev: "violation", ri: g.ri, msg: "Loop target “" + g.target + "” was not found among the steps." });
          continue;
        }
        if (T.s.kind === "conn" || T.c !== ctx) {
          // leaves the sheet: end on a circled letter (and enter beside the target on its sheet)
          const letter = T.s.kind === "conn" ? T.s.letter : nextLetter(), s = g.alts ? freeFirst(srcs)[0] : srcs[0], e = last(s.pts);
          let c;
          if (s.dir) { const dx = (s.dir === "left" ? -1 : 1) * (S.gapX * 0.7 + connD / 2); c = P(e.x + dx, e.y); ctx.edges.push({ pts: s.pts.concat([P(c.x - Math.sign(dx) * connD / 2, e.y)]), arrow: true }); pick(s); }
          else { c = P(e.x, e.y + connD / 2); if (!g.from.bare) ctx.edges.push({ pts: s.pts, arrow: true }); }
          ctx.shapes.push({ shape: "circle", cx: c.x, cy: c.y, w: connD, h: connD, lines: [letter], ri: g.ri, num: "", kind: "conn", letter });
          labelAt(s);
          if (T.s.kind !== "conn") {
            const tb = boxOf(T.s), ex = T.s.num && (T.s.numSide || side) === "left" ? m(T.s.num) + 14 : 0;
            const cx = tb.x0 - ex - S.gapX * 0.7 - connD / 2;
            T.c.shapes.push({ shape: "circle", cx, cy: T.s.cy, w: connD, h: connD, lines: [letter], ri: -1, num: "", kind: "conn", letter });
            T.c.edges.push({ pts: [P(cx + connD / 2, T.s.cy), P(tb.x0, T.s.cy)], arrow: true });
          }
          continue;
        }
        const bx = boxes(), segs = allSegs(), tb = boxOf(T.s), cands = [];
        for (const s of srcs) for (const sd of (s.dir ? [s.dir] : ["left", "right"])) {
          const st = last(s.pts), ty = T.s.cy, y0 = Math.min(st.y, ty) - 1, y1 = Math.max(st.y, ty) + 1;
          let ext = sd === "left" ? Math.min(st.x, tb.x0) : Math.max(st.x, tb.x1);
          const push = (x) => { ext = sd === "left" ? Math.min(ext, x) : Math.max(ext, x); };
          for (const b of bx) if (b.y1 >= y0 && b.y0 <= y1) push(sd === "left" ? b.x0 : b.x1);
          for (const sg of segs) if (Math.max(sg[0].y, sg[1].y) >= y0 && Math.min(sg[0].y, sg[1].y) <= y1) { push(sg[0].x); push(sg[1].x); }
          let lx = ext + (sd === "left" ? -1 : 1) * S.gapX * 0.6;
          if (s.dir && g.label) { const need = st.x + (sd === "left" ? -1 : 1) * (m(g.label) + 12); lx = sd === "left" ? Math.min(lx, need) : Math.max(lx, need); }
          const pts = s.pts.concat([P(lx, st.y), P(lx, ty), P(sd === "left" ? tb.x0 : tb.x1, ty)]);
          let bad = 0, len = 0;
          for (const ns of segsOf(pts).slice(s.pts.length - 1)) {
            len += Math.abs(ns[0].x - ns[1].x) + Math.abs(ns[0].y - ns[1].y);
            for (const sg of segs) if (cross(ns[0], ns[1], sg[0], sg[1])) bad++;
            for (const b of bx) if (hitsBox(ns[0], ns[1], b)) bad += 3;
          }
          bad += (ctx.vert[g.key + s.dir] || 0) * 2;
          cands.push({ pts, bad, len, s });
        }
        // a loop back can also go around the outside of the chart: down, across underneath,
        // up the far side and into the target (used when the direct way would cross things)
        if (T.s.cy < Math.max(...srcs.map((s) => last(s.pts).y)) + S.gapY) {
          const ys = bx.map((b) => b.y1).concat(segs.map((sg) => Math.max(sg[0].y, sg[1].y)));
          const yLow = Math.max(...ys) + S.gapY * 0.6, ty = T.s.cy;
          for (const s of srcs) for (const sd of ["left", "right"]) {
            const st = last(s.pts), sg = sd === "left" ? -1 : 1, pre = s.pts.slice();
            const xs = bx.map((b) => (sd === "left" ? b.x0 : b.x1)).concat(segs.map((q) => (sd === "left" ? Math.min(q[0].x, q[1].x) : Math.max(q[0].x, q[1].x))));
            const xOut = (sd === "left" ? Math.min(...xs) : Math.max(...xs)) + sg * S.gapX * 0.6;
            if (s.dir) {
              const dsg = s.dir === "left" ? -1 : 1;
              let edge = st.x;
              for (const b of bx) if (b.y1 >= st.y - 1 && b.y0 <= yLow && (dsg < 0 ? b.x1 > st.x - S.gapX * 1.2 && b.x0 < st.x : b.x0 < st.x + S.gapX * 1.2 && b.x1 > st.x)) edge = dsg < 0 ? Math.min(edge, b.x0) : Math.max(edge, b.x1);
              let dx = edge + dsg * S.gapX * 0.6;
              if (g.label) dx = dsg < 0 ? Math.min(dx, st.x - (m(g.label) + 12)) : Math.max(dx, st.x + m(g.label) + 12);
              pre.push(P(dx, st.y), P(dx, yLow));
            } else pre.push(P(st.x, yLow));
            const pts = pre.concat([P(xOut, yLow), P(xOut, ty), P(sd === "left" ? tb.x0 : tb.x1, ty)]);
            let bad = 0, len = 0;
            for (const ns of segsOf(pts).slice(s.pts.length - 1)) {
              len += Math.abs(ns[0].x - ns[1].x) + Math.abs(ns[0].y - ns[1].y);
              for (const q of segs) if (cross(ns[0], ns[1], q[0], q[1])) bad++;
              for (const b of bx) if (hitsBox(ns[0], ns[1], b)) bad += 3;
            }
            bad += (ctx.vert[g.key + s.dir] || 0) * 2;
            cands.push({ pts, bad, len, s });
          }
        }
        cands.sort((a, b) => a.bad - b.bad || a.len - b.len);
        const best = cands[0];
        ctx.edges.push({ pts: best.pts, arrow: true, routed: true });
        if (best.s.dir) pick(best.s);
        labelAt(best.s);
      }
    });

    // ---- finish each page: centre in the sight, build the display list
    const figLabel = String(fig.label == null ? "" : fig.label).trim();
    const defLabel = (i) => (ctxs.length < 2 ? figLabel : /^\d+$/.test(figLabel) ? figLabel + String.fromCharCode(65 + i) : figLabel + (i ? " (cont.)" : ""));
    const out = [];
    ctxs.forEach((ctx, pi) => {
      const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      const grow = (x, y) => { bb.x0 = Math.min(bb.x0, x); bb.x1 = Math.max(bb.x1, x); bb.y0 = Math.min(bb.y0, y); bb.y1 = Math.max(bb.y1, y); };
      const hw = Math.max(S.borderWeight, S.arrowWeight) / 2;
      for (const s of ctx.shapes) { const b = boxOf(s); grow(b.x0 - hw, b.y0 - hw); grow(b.x1 + hw, b.y1 + hw); const n = numBox(s); if (n) { grow(n.x0, n.y0); grow(n.x1, n.y1); } }
      for (const e of ctx.edges) for (const p of e.pts) { grow(p.x - S.headSize * 0.45, p.y); grow(p.x + S.headSize * 0.45, p.y); }
      for (const l of ctx.labels) { const w = m(l.text); grow(l.anchor === "end" ? l.x - w : l.x, l.y - fs * 0.8); grow(l.anchor === "end" ? l.x : l.x + w, l.y + fs * 0.25); }
      if (!isFinite(bb.x0)) { bb.x0 = bb.y0 = bb.x1 = bb.y1 = 0; }
      const cw = bb.x1 - bb.x0, chh = bb.y1 - bb.y0, total = chh + capGap + capH;
      const dx = use.x + (use.w - cw) / 2 - bb.x0;
      const dy = use.y + Math.max(0, (use.h - total) / 2) - bb.y0;
      const label = (fig.pageLabels && fig.pageLabels[pi] != null && fig.pageLabels[pi] !== "") ? String(fig.pageLabels[pi]) : defLabel(pi);
      const ops = [], T = (p) => P(p.x + dx, p.y + dy);
      const boxesT = ctx.shapes.filter((s) => !s.nested).map((s) => { const b = boxOf(s); return { x0: b.x0 + dx, x1: b.x1 + dx, y0: b.y0 + dy, y1: b.y1 + dy }; });
      for (const e of ctx.edges) {
        let pts = tidy(e.pts.map(T));
        if (pts.length < 2) continue;
        if (S.line === "straight" && !e.routed) pts = straighten(pts, boxesT);
        const head = e.arrow ? S.head : "none", a = pts[pts.length - 2], b = pts[pts.length - 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
        const hs = Math.min(S.headSize, Math.max(3, len * 0.9));
        const cut = head === "filled" || head === "barbed" ? hs * 0.6 : head === "hollow" ? hs : 0;
        const linePts = pts.slice(0, -1).concat([P(b.x - ux * cut, b.y - uy * cut)]);
        ops.push({ t: "path", d: polyPath(linePts, S.line === "curved" ? Math.min(S.gapY * 0.45, 14) : 0), stroke: S.stroke, sw: S.arrowWeight, fill: "none", dash: S.dash === "dashed" ? [S.arrowWeight * 4, S.arrowWeight * 3] : null, cls: "edge" });
        if (head !== "none") {
          const px = -uy, py = ux, bw2 = hs * 0.36, bx2 = b.x - ux * hs, by2 = b.y - uy * hs;
          const l = [bx2 + px * bw2, by2 + py * bw2], r = [bx2 - px * bw2, by2 - py * bw2];
          if (head === "open") ops.push({ t: "path", d: [["M", l[0], l[1]], ["L", b.x, b.y], ["L", r[0], r[1]]], stroke: S.stroke, sw: S.arrowWeight, fill: "none", cls: "head" });
          else if (head === "barbed") ops.push({ t: "path", d: [["M", b.x, b.y], ["L", l[0], l[1]], ["L", b.x - ux * hs * 0.62, b.y - uy * hs * 0.62], ["L", r[0], r[1]], ["Z"]], stroke: "none", sw: 0, fill: S.stroke, cls: "head" });
          else ops.push({ t: "path", d: [["M", b.x, b.y], ["L", l[0], l[1]], ["L", r[0], r[1]], ["Z"]], stroke: head === "hollow" ? S.stroke : "none", sw: head === "hollow" ? S.arrowWeight : 0, fill: head === "hollow" ? "#ffffff" : S.stroke, cls: "head" });
        }
      }
      for (const s of ctx.shapes) {
        const cx = s.cx + dx, cy = s.cy + dy;
        ops.push({ t: "path", d: shapePath(s.shape, cx, cy, s.w, s.h, s.inset), stroke: S.stroke, sw: S.borderWeight, fill: S.fill, ri: s.ri, cls: "shape" });
        const th = s.lines.length * lh, rectish = !/^(diamond|oval|circle|stadium)$/.test(s.shape);
        const align = rectish ? S.align : "center", inner = s.w / 2 - S.padding - (s.inset || 0);
        const tx = align === "left" ? cx - inner : align === "right" ? cx + inner : cx;
        const tcy = s.textCy != null ? s.textCy + dy : cy;
        s.lines.forEach((ln, k) => ops.push({ t: "text", x: tx, y: tcy - th / 2 + k * lh + (lh + fontDef.cap * fs) / 2, s: ln, size: fs, color: S.textColor, anchor: align === "left" ? "start" : align === "right" ? "end" : "middle", ri: s.ri }));
        if (s.num) {
          const f = numeralSpot(Object.assign({}, s, { cx, cy }), s.numSide || side, m(s.num), fs), sg = (s.numSide || side) === "left" ? -1 : 1;
          ops.push({ t: "path", d: [["M", f.ax, f.ay], ["Q", f.ax + sg * 7, f.ay - 1, f.tx - sg * 2.5, f.base - fs * 0.3]], stroke: S.stroke, sw: Math.max(MIN_LINE_PT, S.borderWeight * 0.7), fill: "none", cls: "lead" });
          ops.push({ t: "text", x: f.tx, y: f.base, s: s.num, size: fs, color: S.textColor, anchor: sg < 0 ? "end" : "start", ri: s.ri });
        }
      }
      for (const l of ctx.labels) ops.push({ t: "text", x: l.x + dx, y: l.y + dy, s: l.text, size: fs, color: S.textColor, anchor: l.anchor, ri: l.ri });
      const capWord = S.caption === "Fig." ? "Fig." : "FIG.";
      if (label) ops.push({ t: "text", x: use.x + use.w / 2, y: bb.y1 + dy + capGap + capSize, s: capWord + " " + label, size: capSize, color: S.textColor, anchor: "middle", cls: "caption" });
      const bbT = { x0: bb.x0 + dx, x1: bb.x1 + dx, y0: bb.y0 + dy, y1: bb.y1 + dy + capGap + capH };
      const sheet = ctxs.length > 1 ? " (sheet " + (pi + 1) + ")" : "";
      if (cw > use.w + 0.5) issues.push({ sev: "violation", msg: "The chart is wider than the space inside the margins" + sheet + ": narrow the boxes or reduce the branches." });
      if (total > use.h + 0.5) issues.push({ sev: "violation", msg: "The chart is taller than the space inside the margins" + sheet + "." });
      let crossings = 0; const sg = []; ctx.edges.forEach((e, k) => segsOf(e.pts).forEach((x) => sg.push([x[0], x[1], k])));
      for (let i = 0; i < sg.length; i++) for (let j = i + 1; j < sg.length; j++) if (sg[i][2] !== sg[j][2] && cross(sg[i][0], sg[i][1], sg[j][0], sg[j][1])) crossings++;
      if (crossings) issues.push({ sev: "note", msg: crossings + " line crossing" + (crossings > 1 ? "s" : "") + sheet + "." });
      for (const s of ctx.shapes) if (s.over) issues.push({ sev: "violation", ri: s.ri, msg: "A word is wider than its box" + (s.num ? " (" + s.num + ")" : "") + "." });
      out.push({ ops, w: paper.w, h: paper.h, use, bbox: bbT, label, defLabel: defLabel(pi) });
    });

    // ---- 37 CFR 1.84 checks
    const V = (msg, ri) => issues.push({ sev: S.compliance ? "violation" : "note", msg, ri });
    const raw = fig.style || {};
    if (S.compliance) {
      for (const k of ["top", "left", "right", "bottom"]) if (S.margins[k] + 1e-6 < USPTO_MARGINS[k]) V("The " + k + " margin is " + S.margins[k] + " cm; 37 CFR 1.84(g) requires at least " + USPTO_MARGINS[k] + " cm.");
      if (raw.paper && PAPERS[raw.paper] && !PAPERS[raw.paper].uspto) V("Paper must be Letter or A4 (37 CFR 1.84(f)).");
      if (parseFloat(raw.fontSize) + 1e-6 < minFontSize(S.font)) V("Lettering is under 0.32 cm high (37 CFR 1.84(p)(3)); " + minFontSize(S.font) + " pt is the smallest size for this typeface.");
      if ((raw.stroke && !/^#?0{3,6}$/.test(raw.stroke)) || (raw.fill && raw.fill !== "none" && !/^#?f{3,6}$/i.test(raw.fill)) || (raw.textColor && !/^#?0{3,6}$/.test(raw.textColor))) V("Color or shading is set; drawings must be black and white (37 CFR 1.84(a)(1), (m)).");
      if (parseFloat(raw.borderWeight) < MIN_LINE_PT || parseFloat(raw.arrowWeight) < MIN_LINE_PT) V("Lines thinner than " + MIN_LINE_PT + " pt do not reproduce well (37 CFR 1.84(l)).");
      if (!figLabel) V("The figure label is empty (37 CFR 1.84(u)).");
    }
    const seen = {};
    rows.forEach((r, i) => {
      const k = rowKind(rows, i), n = (r.num || "").trim();
      if (k === "label" || k === "goto" || k === "conn") return;
      if (n) { if (seen[n.toLowerCase()] != null) V("Numeral " + n + " is used on more than one step (37 CFR 1.84(p)(4)).", i); else seen[n.toLowerCase()] = i; }
      else if (k !== "term") issues.push({ sev: "note", ri: i, msg: "No reference numeral: “" + (r.text || "").slice(0, 40) + "”." });
    });
    if (!rows.length) issues.push({ sev: "note", msg: "No steps yet." });
    issues.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === "violation" ? -1 : 1));
    return { pages: out, issues, style: S, tree, columns: colPlan ? colPlan.cols.length : 0 };
  }

  function tidy(pts) {
    const o = [];
    for (const p of pts) {
      const n = o.length;
      if (n && Math.abs(o[n - 1].x - p.x) < 0.05 && Math.abs(o[n - 1].y - p.y) < 0.05) continue;
      if (n > 1) { const a = o[n - 2], b = o[n - 1]; if (Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < 0.05 && (p.x - b.x) * (b.x - a.x) + (p.y - b.y) * (b.y - a.y) >= 0) { o[n - 1] = p; continue; } }
      o.push(p);
    }
    return o;
  }
  // "Straight" lines: drop every corner that can be cut without running through a box.
  function straighten(pts, boxes) {
    const hit = (a, b) => boxes.some((bx) => {
      const x0 = bx.x0 + 2, x1 = bx.x1 - 2, y0 = bx.y0 + 2, y1 = bx.y1 - 2;
      for (let i = 1; i < 12; i++) { const x = a.x + (b.x - a.x) * i / 12, y = a.y + (b.y - a.y) * i / 12; if (x > x0 && x < x1 && y > y0 && y < y1) return true; }
      return false;
    });
    const o = [pts[0]]; let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && hit(pts[i], pts[j])) j--;
      o.push(pts[j]); i = j;
    }
    return o;
  }
  function polyPath(pts, r) {
    const d = [["M", pts[0].x, pts[0].y]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (r && i < pts.length - 1) {
        const a = pts[i - 1], n = pts[i + 1], l1 = Math.hypot(p.x - a.x, p.y - a.y), l2 = Math.hypot(n.x - p.x, n.y - p.y), rr = Math.min(r, l1 / 2, l2 / 2);
        if (rr > 0.5) {
          d.push(["L", p.x - (p.x - a.x) / l1 * rr, p.y - (p.y - a.y) / l1 * rr]);
          d.push(["Q", p.x, p.y, p.x + (n.x - p.x) / l2 * rr, p.y + (n.y - p.y) / l2 * rr]);
          continue;
        }
      }
      d.push(["L", p.x, p.y]);
    }
    return d;
  }

  // ------------------------------------------------------------------ output
  const escX = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function toSVG(pg, style, opt) {
    opt = opt || {}; const f = FONTS[style.font], fam = "'" + f.family + "', " + f.fallback;
    let s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + round2(pg.w) + 'pt" height="' + round2(pg.h) + 'pt" viewBox="0 0 ' + round2(pg.w) + " " + round2(pg.h) + '">';
    s += '<rect width="100%" height="100%" fill="#ffffff"/>';
    if (opt.guides) s += '<rect class="guide" x="' + round2(pg.use.x) + '" y="' + round2(pg.use.y) + '" width="' + round2(pg.use.w) + '" height="' + round2(pg.use.h) + '" fill="none" stroke="#7AA7D9" stroke-width="0.6" stroke-dasharray="4 3"/>';
    for (const o of pg.ops) {
      const ri = opt.guides && o.ri != null && o.ri >= 0 ? ' data-ri="' + o.ri + '"' : "";
      if (o.t === "path") {
        s += '<path d="' + pathD(o.d) + '" fill="' + o.fill + '" stroke="' + o.stroke + '"' + (o.sw ? ' stroke-width="' + round2(o.sw) + '"' : "") + (o.dash ? ' stroke-dasharray="' + o.dash.map(round2).join(" ") + '"' : "") + ' stroke-linejoin="miter" stroke-linecap="butt"' + ri + "/>";
      } else {
        s += '<text x="' + round2(o.x) + '" y="' + round2(o.y) + '" font-family="' + escX(fam) + '" font-size="' + round2(o.size) + '" fill="' + o.color + '" text-anchor="' + o.anchor + '"' + ri + ">" + escX(o.s) + "</text>";
      }
    }
    return s + "</svg>";
  }

  // Wider boxes and tighter rows until the chart fits one sheet. Returns the style that
  // fits (keeping the drawing rules), or null when nothing does.
  function fitOneSheet(fig, measure) {
    const base = layout(fig, measure);
    if (base.pages.length < 2) return null;
    const st = normStyle(fig.style), nv = (L) => L.issues.filter((i) => i.sev === "violation").length, v0 = nv(base);
    const tries = [];
    for (const bw of [st.boxWidth, 8, 9, 10, 11]) for (const gy of [Math.min(st.gapY, 20), 16, 13]) if (bw >= st.boxWidth) tries.push({ boxWidth: bw, gapY: gy });
    tries.push({ boxWidth: Math.max(st.boxWidth, 10), gapY: 12, padding: Math.min(st.padding, 4) });
    for (const t of tries) {
      const style = Object.assign({}, fig.style, t), L = layout(Object.assign({}, fig, { style }), measure);
      if (L.pages.length === 1 && nv(L) <= v0) return style;
    }
    return null;
  }

  // ------------------------------------------------------------------ description text
  const VERBS = new Set(("receive send transmit determine store display generate compute calculate compare select identify detect obtain provide apply update create load save read write check verify validate encrypt decrypt output input process parse render request respond return retrieve fetch measure monitor record log notify alert prompt authenticate authorize connect disconnect initialize start stop begin end set reset increment decrement add remove delete insert sort filter map merge split encode decode compress scan capture convert transform translate assign allocate schedule execute run perform launch open close lock unlock show hide wait repeat heat cool mix attach place position move rotate cut form fill seal deposit coat dry cure wash rinse administer collect acquire sense analyze classify extract combine build train predict rank score route forward publish subscribe queue present enable disable activate deactivate adjust control drive cause instruct query search match look find get put issue submit confirm reject accept deny grant revoke register sign upload download print charge pay bill order ship deliver").split(" "));
  function third(v) { return /(s|sh|ch|x|z|o)$/.test(v) ? v + "es" : /[^aeiou]y$/.test(v) ? v.slice(0, -1) + "ies" : v + "s"; }
  function describe(fig) {
    const S = normStyle(fig.style), tree = buildTree(fig.rows || []), cap = (S.caption === "Fig." ? "Fig. " : "FIG. ") + String(fig.label || "X").trim();
    const lc = (s) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s), strip = (s) => String(s).trim().replace(/[.;,:]+$/, "");
    const out = [cap + " is a flowchart of a method according to an embodiment."];
    const at = (it) => (it.num ? "At step " + it.num + ", " : "Next, ");
    const ref = (it) => (it && it.kind === "goto" ? "step " + it.target.replace(/^step\s+/i, "") : it && it.num ? "step " + it.num : it && it.kind === "term" && it.isEnd ? "the end of the method" : it && it.kind === "conn" ? "connector " + it.letter : "the next step");
    function sentence(it) {
      const t = strip(it.text), w = t.split(/\s+/)[0].toLowerCase();
      if (/ing$/.test(w) && w.length > 4) return at(it) + "the method includes " + lc(t) + ".";
      if (VERBS.has(w)) return at(it) + "the method " + third(w) + t.slice(w.length) + ".";
      return at(it) + "the following is performed: " + lc(t) + ".";
    }
    function seq(items, after) {
      items.forEach((it, i) => {
        const next = items[i + 1] || after;
        if (it.kind === "term") out.push(it.isEnd ? "The method then ends." : "The method begins.");
        else if (it.kind === "goto") out.push("The method then returns to step " + it.target.replace(/^step\s+/i, "") + ".");
        else if (it.kind === "conn") out.push(i === items.length - 1 && i > 0 ? "The method continues at connector " + it.letter + "." : "");
        else if (it.kind === "step") {
          out.push(sentence(it));
          for (const s of it.subs) out.push((it.num ? "In step " + it.num + ", " : "Here, ") + lc(strip(s.text).replace(/^where(?:in|by)\s+/i, "")) + (s.num ? " (" + s.num + ")" : "") + ".");
        } else if (it.kind === "decision") {
          const t = strip(it.text.replace(/\?\s*$/, "")), w = t.split(/\s+/)[0].toLowerCase();
          if (w === "whether") out.push(at(it) + "the method determines " + lc(t) + ".");
          else if (/ing$/.test(w)) out.push(at(it) + "the method includes " + lc(t) + ".");
          else if (VERBS.has(w)) out.push(at(it) + "the method " + third(w) + t.slice(w.length) + ".");
          else out.push(at(it) + "the method determines the following: " + lc(t) + "?");
          for (const b of it.branches) {
            const first = b.items[0], lab = /^(yes|y|true)$/i.test(b.label) ? "If so" : /^(no|n|false)$/i.test(b.label) ? "If not" : "If the result is “" + b.label + "”";
            if (first && first.kind === "goto") { out.push(lab + ", the method returns to " + ref(first) + "."); continue; }
            out.push(lab + ", the method proceeds to " + ref(first || next) + ".");
            if (b.items.length) seq(b.items, next);
          }
        }
      });
    }
    seq(tree, null);
    return out.filter(Boolean).join(" ");
  }

  return { PT_CM, PAPERS, USPTO_MARGINS, MIN_LETTER_CM, FONTS, SHAPES, HEADS, PRESETS, minFontSize, usptoStyle, webStyle, normStyle,
    parseOutline, toOutline, parseClaim, shortLabel, commandLabel, splitClaims, claimsToFigures, parseDescription, textToFigures, rowKind, isDecisionRow, parentOf, buildTree, layout, fitOneSheet, toSVG, pathD, describe };
});
