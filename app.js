// Coral: the page. State is a project {figures:[{label, rows, style, pageLabels}], cur};
// the engine lays the current figure out on every change. Nothing leaves the browser.
(function () {
  "use strict";
  const C = window.Coral, X = window.CoralExport;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const KEY = "coral-project", PKEY = "coral-presets";
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const SAMPLE = "Start\n102: Receive a sign-in request\n104: Is the password correct?\n    Yes:\n        106: Create a session token\n    No:\n        108: Count the failed attempt\n        110: More than three failed attempts?\n            Yes:\n                112: Lock the account\n                End\n            No: -> 102\n114: Send the response\nEnd";
  const newFigure = (label, rows) => ({ label: label || "", rows: rows || [], style: C.usptoStyle(), pageLabels: [] });

  let state, hist = [], hi = -1, sel = -1, tab = "steps", L = null, pendingExport = null;
  try { state = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { state = null; }
  if (!state || !Array.isArray(state.figures) || !state.figures.length) state = { app: "coral", version: 1, figures: [newFigure("1", C.parseOutline(SAMPLE))], cur: 0 };
  const fig = () => state.figures[Math.min(state.cur, state.figures.length - 1)];

  // ---------------------------------------------------------------- text measuring
  const mctx = document.createElement("canvas").getContext("2d");
  function measure(t, font, size) {
    const f = C.FONTS[font] || C.FONTS.sans;
    mctx.font = "100px '" + f.family + "', " + f.fallback;
    return mctx.measureText(t).width * size / 100;
  }
  const fontBytes = {};
  async function fontFile(font) {
    if (!fontBytes[font]) fontBytes[font] = await fetch("fonts/" + C.FONTS[font].file).then((r) => { if (!r.ok) throw new Error("font"); return r.arrayBuffer(); });
    return fontBytes[font];
  }

  // ---------------------------------------------------------------- history
  let commitTimer = null;
  function commit() {
    clearTimeout(commitTimer); commitTimer = null;
    const j = JSON.stringify(state);
    if (j === hist[hi]) return;
    hist = hist.slice(0, hi + 1); hist.push(j); if (hist.length > 200) hist.shift(); hi = hist.length - 1;
    try { localStorage.setItem(KEY, j); } catch (e) { /* private mode */ }
    histButtons();
  }
  const commitSoon = () => { clearTimeout(commitTimer); commitTimer = setTimeout(commit, 500); };
  function histButtons() { $("undo").disabled = hi <= 0; $("redo").disabled = hi >= hist.length - 1; }
  function travel(d) {
    if (commitTimer) commit();
    if (hi + d < 0 || hi + d >= hist.length) return;
    hi += d; state = JSON.parse(hist[hi]); sel = -1;
    try { localStorage.setItem(KEY, hist[hi]); } catch (e) { /* ignore */ }
    renderAll(); histButtons();
  }

  // ---------------------------------------------------------------- rows
  const rows = () => fig().rows;
  const kind = (i) => C.rowKind(rows(), i);
  function span(i) { const r = rows(); let j = i + 1; while (j < r.length && r[j].level > r[i].level) j++; return j; }
  function prevSibling(i) { const r = rows(); for (let j = i - 1; j >= 0; j--) { if (r[j].level === r[i].level) return j; if (r[j].level < r[i].level) return -1; } return -1; }
  const blank = (level, text) => ({ level, text: text || "", num: "", shape: "" });

  function act(i, what) {
    const r = rows(), e = span(i);
    if (what === "del") { r.splice(i, e - i); sel = Math.min(i, r.length - 1); }
    else if (what === "add") { r.splice(e, 0, blank(r[i].level)); sel = e; }
    else if (what === "in") { if (i > 0 && r[i].level <= r[i - 1].level) for (let j = i; j < e; j++) r[j].level++; }
    else if (what === "out") { if (r[i].level > 0) for (let j = i; j < e; j++) r[j].level--; }
    else if (what === "up") { const p = prevSibling(i); if (p >= 0) { const blk = r.splice(i, e - i); r.splice(p, 0, ...blk); sel = p; } }
    else if (what === "down") {
      if (e < r.length && r[e].level === r[i].level) { const e2 = span(e), blk = r.splice(i, e - i); r.splice(i + (e2 - e), 0, ...blk); sel = i + (e2 - e); }
    }
    commit(); renderAll(what === "add");
  }
  function moveBlock(from, to) {
    const r = rows(), e = span(from);
    if (to >= from && to < e) return;
    const lvl = to < r.length ? r[to].level : 0, blk = r.splice(from, e - from), d = lvl - blk[0].level;
    blk.forEach((x) => { x.level += d; });
    const at = to > from ? to - blk.length : to;
    r.splice(at, 0, ...blk); sel = at; commit(); renderAll();
  }
  function quickAdd(what) {
    const r = rows();
    let at = r.length, level = 0;
    if (sel >= 0 && sel < r.length) { at = span(sel); level = r[sel].level; }
    let add;
    if (what === "decision") add = [blank(level, "Condition?"), blank(level + 1, "Yes:"), blank(level + 1, "No:")];
    else if (what === "loop") add = [blank(level, "-> ")];
    else if (what === "start") add = [blank(level, "Start")];
    else if (what === "end") add = [blank(level, "End")];
    else if (what === "conn") {
      const used = new Set(r.map((x) => (x.text.match(/^\(\s*([A-Za-z0-9]{1,2})\s*\)$/) || [])[1]).filter(Boolean).map((x) => x.toUpperCase()));
      let l = "A"; for (let c = 65; c < 91; c++) { l = String.fromCharCode(c); if (!used.has(l)) break; }
      add = [blank(level, "(" + l + ")")];
    } else if (what === "branch" || what === "sub") {
      if (sel < 0 || sel >= r.length) return;
      let host = sel;
      if (what === "branch") { while (host >= 0 && !C.isDecisionRow(r[host])) host = C.parentOf(r, host); if (host < 0) return; }
      else if (kind(host) !== "step" && kind(host) !== "sub") return;
      if (what === "sub" && kind(host) === "sub") host = C.parentOf(r, host);
      at = span(host); add = [blank(r[host].level + 1, what === "branch" ? "Other:" : "wherein ")];
    } else add = [blank(level, "")];
    r.splice(at, 0, ...add); sel = at; commit(); renderAll(true);
  }

  const SHAPE_OPTS = '<option value="">Auto</option>' + Object.keys(C.SHAPES).map((k) => '<option value="' + k + '">' + esc(C.SHAPES[k]) + "</option>").join("");
  function renderRows(focusSel) {
    const r = rows(), box = $("rows");
    box.innerHTML = r.map((row, i) => {
      const k = kind(i), has = k === "step" || k === "decision" || k === "term" || k === "sub";
      const tag = k === "label" ? "Branch" : k === "goto" ? "Loop" : k === "conn" ? "Off-page" : "";
      return '<div class="r' + (i === sel ? " sel" : "") + '" data-i="' + i + '" style="margin-left:' + row.level * 18 + 'px">' +
        '<span class="grip" draggable="true" title="Drag to reorder">⋮⋮</span>' +
        (has ? '<input class="num" data-f="num" value="' + esc(row.num) + '" placeholder="No." title="Reference numeral" autocomplete="off">' : '<span class="k">' + tag + "</span>") +
        '<input class="txt" data-f="text" value="' + esc(row.text) + '" placeholder="' + (k === "label" ? "Yes:" : k === "goto" ? "-> 102" : "Step text") + '" autocomplete="off">' +
        (has && k !== "sub" ? '<select data-f="shape" title="Shape">' + SHAPE_OPTS.replace('value="' + row.shape + '"', 'value="' + row.shape + '" selected') + "</select>" : "") +
        '<button class="ib" data-a="out" title="Outdent">◂</button><button class="ib" data-a="in" title="Indent">▸</button>' +
        '<button class="ib" data-a="up" title="Move up">↑</button><button class="ib" data-a="down" title="Move down">↓</button>' +
        '<button class="ib" data-a="add" title="Add a step below">＋</button><button class="ib" data-a="del" title="Delete">✕</button></div>';
    }).join("") || '<p class="hint">No steps yet.</p>';
    if (focusSel && sel >= 0) { const el = box.querySelector('.r[data-i="' + sel + '"] input.txt'); if (el) { el.focus(); el.select(); } }
  }
  const rowsBox = $("rows");
  rowsBox.addEventListener("input", (e) => {
    const el = e.target.closest("[data-f]"), row = e.target.closest(".r"); if (!el || !row) return;
    const i = +row.dataset.i; rows()[i][el.dataset.f] = el.value;
    commitSoon(); renderPreview();
  });
  rowsBox.addEventListener("change", (e) => { if (e.target.closest("[data-f]")) { commit(); const a = document.activeElement; renderRows(false); if (a && a.dataset && a.dataset.f) { const r = a.closest(".r"); if (r) { const n = rowsBox.querySelector('.r[data-i="' + r.dataset.i + '"] [data-f="' + a.dataset.f + '"]'); if (n) n.focus(); } } } });
  rowsBox.addEventListener("focusin", (e) => { const row = e.target.closest(".r"); if (!row) return; sel = +row.dataset.i; rowsBox.querySelectorAll(".r.sel").forEach((x) => x.classList.remove("sel")); row.classList.add("sel"); });
  rowsBox.addEventListener("click", (e) => { const b = e.target.closest("[data-a]"); if (b) act(+b.closest(".r").dataset.i, b.dataset.a); });
  rowsBox.addEventListener("keydown", (e) => {
    const row = e.target.closest(".r"); if (!row || !e.target.matches("input.txt")) return;
    const i = +row.dataset.i;
    if (e.key === "Enter") { e.preventDefault(); rows()[i].text = e.target.value; act(i, "add"); }
    else if (e.key === "Tab" && !e.ctrlKey && !e.altKey && e.target.selectionStart === 0 && e.target.selectionEnd === 0) { e.preventDefault(); rows()[i].text = e.target.value; sel = i; act(i, e.shiftKey ? "out" : "in"); renderRows(true); }
  });
  let dragFrom = -1;
  rowsBox.addEventListener("dragstart", (e) => { const row = e.target.closest(".r"); if (!row) return; dragFrom = +row.dataset.i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(dragFrom)); });
  rowsBox.addEventListener("dragover", (e) => { if (dragFrom < 0) return; const row = e.target.closest(".r"); e.preventDefault(); rowsBox.querySelectorAll(".r.over").forEach((x) => x.classList.remove("over")); if (row) row.classList.add("over"); });
  rowsBox.addEventListener("drop", (e) => { if (dragFrom < 0) return; e.preventDefault(); const row = e.target.closest(".r"); const to = row ? +row.dataset.i : rows().length; const f = dragFrom; dragFrom = -1; moveBlock(f, to); });
  rowsBox.addEventListener("dragend", () => { dragFrom = -1; rowsBox.querySelectorAll(".r.over").forEach((x) => x.classList.remove("over")); });
  document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => quickAdd(b.dataset.add)));

  // ---------------------------------------------------------------- tabs, outline, claim
  function showTab(t) {
    tab = t;
    document.querySelectorAll("#tabs .tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    for (const k of ["steps", "outline", "claim"]) $("pane-" + k).hidden = k !== t;
    if (t === "outline") $("outline").value = C.toOutline(rows());
    if (t === "steps") renderRows(false);
  }
  $("tabs").addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) showTab(b.dataset.tab); });
  let olTimer = null;
  $("outline").addEventListener("input", () => { clearTimeout(olTimer); olTimer = setTimeout(() => { fig().rows = C.parseOutline($("outline").value); sel = -1; commitSoon(); renderPreview(); }, 200); });
  $("outline").addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return; e.preventDefault();
    const t = e.target, s = t.selectionStart;
    t.setRangeText("    ", s, t.selectionEnd, "end"); t.dispatchEvent(new Event("input"));
  });
  // Describe or paste: a description, one claim or a whole claim set becomes the chart.
  // By rule in the browser; or, with the visitor's own Anthropic API key, drafted by Claude.
  const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.132.1/+esm";
  const DRAFT_MODEL = "claude-opus-5-5";
  const DRAFT_SCHEMA = { type: "object", additionalProperties: false, required: ["figures"], properties: { figures: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["title", "outline"], properties: { title: { type: "string" }, outline: { type: "string" } } } } } };
  const DRAFT_PROMPT = [
    "You turn a description of a process, a patent method claim, or a full patent claim set into flowchart outlines for a patent-drawing tool.",
    "Return one figure per independent method (or process) claim. For a plain description, return one figure. If the claim set has no method claim, chart the first independent claim's operations.",
    "",
    "Outline format: one step per line; indentation is 4 spaces per level.",
    "- A step is a line of text.",
    "- A decision is a line ending in \"?\". The lines indented under it are its branches: each is a label ending in \":\" (Yes:, No:, or any other outcome), and the steps of that branch are indented under the label. A branch with nothing under it continues to the step after the decision.",
    "- \"-> \" followed by the exact text of another step sends the flow to that step (a loop back, or a jump ahead). It is the last line of its branch.",
    "- Lines indented under an ordinary step (not a decision) are its sub-steps.",
    "- \"Start\" and \"End\" on their own lines are terminators.",
    "",
    "Rules:",
    "- Never add reference numerals: the user assigns them. Keep a numeral only when the user's text already gives one for that step, written as \"102: step text\".",
    "- From claims: keep each step in the claim's own words (drop the preamble, enumerators and a trailing \"and\"), in the order recited. Fold each dependent claim into its independent claim's figure: steps a dependent claim adds (\"further comprising\") go where they belong in the flow; a \"wherein\" clause becomes a sub-step under the step it limits, keeping its wording. A wherein clause that limits a decision goes under the step just before that decision. Turn conditional language (\"determining whether\", \"in response to determining that\") into a decision with labelled branches. Do not add steps the claims do not recite, and do not add Start or End.",
    "- From a description: step text of about twelve words at most, in the imperative; decisions phrased as questions; begin with Start and finish with End.",
    "- title: a few words, such as \"Claim 1: signing in a user\".",
  ].join("\n");
  const leftStatus = (t) => { $("leftstatus").textContent = t || ""; };
  const hooks = { loadSdk: () => import(SDK_URL) };
  function readKey() { try { return localStorage.getItem("coral.apikey") || ""; } catch (e) { return ""; } }
  $("apikey").value = readKey(); $("rememberkey").checked = !!readKey();
  // Hosted inside another site (an office's own private page): index.html?embed=1 drops the outside links, and
  // &keyurl=<a URL on the same site> names a page that answers {"key": "sk-ant-…"} to a signed-in visitor. That
  // key is used for Claude drafting, held in memory only, and sent nowhere but Anthropic.
  const QS = new URLSearchParams(location.search);
  let hostKey = "";
  if (QS.get("embed") === "1") document.querySelectorAll("header.bar a").forEach((a) => { a.hidden = true; });
  const keyUrl = QS.get("keyurl") || "";
  if (keyUrl && !/^[a-z][a-z0-9+.-]*:|^\/\/|\\/i.test(keyUrl)) {
    fetch(keyUrl, { credentials: "same-origin", cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (!j || typeof j.key !== "string" || !j.key) return;
      hostKey = j.key; $("useclaude").checked = true; $("claudebox").hidden = true;
      $("useclaude").parentNode.lastChild.textContent = " Have Claude draft it";
    }).catch(() => { /* no key from the host: the visitor's own key still works */ });
  }
  $("useclaude").addEventListener("change", () => { $("claudebox").hidden = !$("useclaude").checked || !!hostKey; if ($("useclaude").checked && !hostKey && !$("apikey").value) $("apikey").focus(); });

  function applyFigures(figs, note) {
    figs = figs.filter((f) => f.rows && f.rows.length);
    if (!figs.length) { leftStatus("Nothing to chart in that text."); return; }
    const f0 = fig(); f0.rows = figs[0].rows; f0.pageLabels = [];
    figs.slice(1).forEach((x, i) => { const nf = newFigure("", x.rows); nf.style = clone(f0.style); state.figures.splice(state.cur + 1 + i, 0, nf); });
    sel = -1; commit(); showTab("steps"); renderAll();
    leftStatus(note + (figs.length > 1 ? " " + figs.length + " figures: the new ones need a figure number." : ""));
  }
  const list = (a) => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
  function makeByRule(text) {
    const r = C.textToFigures(text);
    if (r.kind === "claims") {
      const folded = r.figures.reduce((n, f) => n + (f.folded || 0), 0);
      applyFigures(r.figures, "Charted claim" + (r.figures.length > 1 ? "s " : " ") + list(r.figures.map((f) => String(f.claim))) + (folded ? ", with " + folded + " dependent claim" + (folded > 1 ? "s" : "") + " folded in." : "."));
    } else applyFigures(r.figures, "Charted your description.");
  }
  let drafting = null;
  async function makeWithClaude(text) {
    const key = hostKey || $("apikey").value.trim();
    if (!key) { leftStatus("Paste your Anthropic API key first."); $("apikey").focus(); return; }
    if (!hostKey) { try { if ($("rememberkey").checked) localStorage.setItem("coral.apikey", key); else localStorage.removeItem("coral.apikey"); } catch (e) { /* storage unavailable */ } }
    const t0 = Date.now(), tick = setInterval(() => leftStatus("Claude is drafting the chart… " + Math.round((Date.now() - t0) / 1000) + " s"), 500);
    $("claimgo").disabled = true;
    let Anthropic = null;
    try {
      ({ default: Anthropic } = await hooks.loadSdk());
      const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
      drafting = client.beta.messages.stream({
        model: DRAFT_MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: DRAFT_SCHEMA } },
        system: DRAFT_PROMPT,
        messages: [{ role: "user", content: text }],
      });
      const msg = await drafting.finalMessage();
      if (msg.stop_reason === "refusal") throw new Error("Claude declined this request.");
      if (msg.stop_reason === "max_tokens") throw new Error("the answer was cut off; try one claim at a time.");
      const out = JSON.parse(msg.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
      const figs = (out.figures || []).map((f) => ({ rows: C.parseOutline(f.outline), title: f.title }));
      clearInterval(tick);
      applyFigures(figs, "Claude drafted " + (figs.length > 1 ? list(figs.map((f) => "“" + f.title + "”")) + "." : "the chart.") + " Check it against your text.");
    } catch (err) {
      clearInterval(tick); console.error(err);
      let m = err && err.message ? err.message : String(err);
      if (Anthropic && err instanceof Anthropic.AuthenticationError) m = "That API key was not accepted.";
      else if (Anthropic && err instanceof Anthropic.PermissionDeniedError) m = "That API key is not allowed to do this (check its workspace and billing).";
      else if (Anthropic && err instanceof Anthropic.RateLimitError) m = "Too many requests just now; wait a minute and try again.";
      else if (Anthropic && err instanceof Anthropic.APIConnectionError) m = "Could not reach Anthropic (offline, or blocked by the network).";
      else if (!Anthropic) m = "Could not load the Claude library: " + m;
      leftStatus("Claude could not draft it: " + m);
    } finally { drafting = null; $("claimgo").disabled = false; }
  }
  $("claimgo").addEventListener("click", () => {
    const text = $("claim").value.trim();
    if (!text) { leftStatus("Type a description or paste claims first."); return; }
    if ($("useclaude").checked) makeWithClaude(text); else makeByRule(text);
  });

  // ---------------------------------------------------------------- style controls
  const getK = (o, k) => k.split(".").reduce((a, p) => (a == null ? a : a[p]), o);
  function setK(o, k, v) { const p = k.split("."); let a = o; for (let i = 0; i < p.length - 1; i++) a = a[p[i]] = a[p[i]] || {}; a[p[p.length - 1]] = v; }
  $("paper").innerHTML = Object.keys(C.PAPERS).map((k) => '<option value="' + k + '">' + esc(C.PAPERS[k].label) + "</option>").join("");
  $("font").innerHTML = Object.keys(C.FONTS).map((k) => '<option value="' + k + '">' + esc(C.FONTS[k].label) + "</option>").join("");
  $("head").innerHTML = Object.keys(C.HEADS).map((k) => '<option value="' + k + '">' + esc(C.HEADS[k]) + "</option>").join("");
  document.querySelectorAll(".shapesel").forEach((s) => { s.innerHTML = Object.keys(C.SHAPES).filter((k) => k !== "circle").map((k) => '<option value="' + k + '">' + esc(C.SHAPES[k]) + "</option>").join(""); });
  const ctrls = Array.from(document.querySelectorAll("[data-k]"));
  function onCtrl(el, final) {
    const st = fig().style, k = el.dataset.k;
    let v = el.type === "checkbox" ? el.checked : el.type === "number" ? parseFloat(el.value) : el.value;
    if (el.type === "number" && !isFinite(v)) { if (!final) return; v = getK(C.normStyle(st), k); }
    setK(st, k, v);
    if (k === "compliance" && v) { const n = C.normStyle(st); st.paper = n.paper; st.fontSize = n.fontSize; st.stroke = "#000000"; st.fill = "none"; st.textColor = "#000000"; st.borderWeight = n.borderWeight; st.arrowWeight = n.arrowWeight; }
    if ((k === "font" || k === "fontSize") && st.compliance && final) st.fontSize = Math.max(parseFloat(st.fontSize) || 0, C.minFontSize(st.font));
    if (k === "fill") $("nofill").checked = false;
    if (final) { commit(); syncControls(); } else commitSoon();
    renderPreview();
  }
  ctrls.forEach((el) => { el.addEventListener("input", () => onCtrl(el, el.tagName === "SELECT" || el.type === "checkbox" || el.type === "color")); el.addEventListener("change", () => onCtrl(el, true)); });
  $("nofill").addEventListener("change", () => { fig().style.fill = $("nofill").checked ? "none" : "#ffffff"; commit(); syncControls(); renderPreview(); });
  $("usptomargins").addEventListener("click", () => { fig().style.margins = Object.assign({}, C.USPTO_MARGINS); commit(); syncControls(); renderPreview(); });
  function syncControls() {
    const raw = fig().style, st = C.normStyle(raw), comp = !!st.compliance;
    for (const el of ctrls) {
      if (el === document.activeElement && el.type === "number") continue;
      const v = getK(st, el.dataset.k);
      if (el.type === "checkbox") el.checked = !!v;
      else if (el.type === "color") el.value = /^#[0-9a-f]{6}$/i.test(v) ? v : "#ffffff";
      else el.value = v;
    }
    Array.from($("paper").options).forEach((o) => { o.disabled = comp && !C.PAPERS[o.value].uspto; o.hidden = o.disabled; });
    const min = C.minFontSize(st.font);
    $("fontsize").min = comp ? min : 5;
    $("fslabel").textContent = comp ? "Size pt (min " + min + ")" : "Size pt";
    $("colors").hidden = comp;
    $("nofill").checked = st.fill === "none";
    $("figlabel").value = fig().label || "";
    syncPreset();
  }
  $("figlabel").addEventListener("input", () => { fig().label = $("figlabel").value; commitSoon(); renderPreview(); renderFigs(); });

  // presets
  const userPresets = () => { try { return JSON.parse(localStorage.getItem(PKEY) || "{}") || {}; } catch (e) { return {}; } };
  const same = (a, b) => JSON.stringify(C.normStyle(a)) === JSON.stringify(C.normStyle(b));
  function syncPreset() {
    const up = userPresets(), st = fig().style; let cur = "";
    let h = "";
    for (const n of Object.keys(C.PRESETS)) { if (!cur && same(st, C.PRESETS[n]())) cur = "b:" + n; h += '<option value="b:' + esc(n) + '">' + esc(n) + "</option>"; }
    for (const n of Object.keys(up)) { if (!cur && same(st, up[n])) cur = "u:" + n; h += '<option value="u:' + esc(n) + '">' + esc(n) + "</option>"; }
    $("preset").innerHTML = '<option value="">Custom</option>' + h; $("preset").value = cur;
    $("presetdel").hidden = cur.slice(0, 2) !== "u:";
  }
  $("preset").addEventListener("change", () => {
    const v = $("preset").value; if (!v) return;
    const st = v.slice(0, 2) === "b:" ? C.PRESETS[v.slice(2)]() : clone(userPresets()[v.slice(2)]);
    if (!st) return; fig().style = st; commit(); syncControls(); renderPreview();
  });
  $("presetsave").addEventListener("click", () => { $("presetname").hidden = false; $("presetnm").focus(); });
  $("presetok").addEventListener("click", () => {
    const n = $("presetnm").value.trim(); if (!n) return;
    const up = userPresets(); up[n] = clone(fig().style);
    try { localStorage.setItem(PKEY, JSON.stringify(up)); } catch (e) { /* ignore */ }
    $("presetname").hidden = true; $("presetnm").value = ""; syncPreset();
  });
  $("presetnm").addEventListener("keydown", (e) => { if (e.key === "Enter") $("presetok").click(); });
  $("presetdel").addEventListener("click", () => {
    const v = $("preset").value; if (v.slice(0, 2) !== "u:") return;
    const up = userPresets(); delete up[v.slice(2)];
    try { localStorage.setItem(PKEY, JSON.stringify(up)); } catch (e) { /* ignore */ }
    syncPreset();
  });

  // ---------------------------------------------------------------- figures
  function renderFigs() {
    const word = (f) => (C.normStyle(f.style).caption === "Fig." ? "Fig. " : "FIG. ");
    $("figs").innerHTML = state.figures.map((f, i) => '<button class="tab' + (i === state.cur ? " on" : "") + '" data-fig="' + i + '">' + esc(word(f) + (f.label || "?")) + "</button>").join("") +
      '<button class="btn alt sm" data-figact="new">+ New figure</button><button class="btn alt sm" data-figact="dup">Duplicate figure</button>' +
      (state.figures.length > 1 ? '<button class="btn alt sm" data-figact="del">Delete figure</button>' : "");
  }
  $("figs").addEventListener("click", (e) => {
    const t = e.target.closest("[data-fig]"), a = e.target.closest("[data-figact]");
    if (t) { state.cur = +t.dataset.fig; sel = -1; commit(); renderAll(); return; }
    if (!a) return;
    if (a.dataset.figact === "new") { const f = newFigure(""); f.style = clone(fig().style); state.figures.push(f); state.cur = state.figures.length - 1; }
    else if (a.dataset.figact === "dup") { const f = clone(fig()); f.label = ""; f.pageLabels = []; state.figures.splice(state.cur + 1, 0, f); state.cur++; }
    else if (a.dataset.figact === "del") { state.figures.splice(state.cur, 1); state.cur = Math.max(0, state.cur - 1); }
    sel = -1; commit(); renderAll();
    if (a.dataset.figact !== "del") { $("figlabel").placeholder = "New figure number"; $("figlabel").focus(); }
  });

  // ---------------------------------------------------------------- preview and checks
  function renderPreview() {
    L = C.layout(fig(), measure);
    $("sheets").innerHTML = L.pages.map((p) => '<div class="sheet">' + C.toSVG(p, L.style, { guides: true }) + "</div>").join("");
    const viol = L.issues.filter((i) => i.sev === "violation"), notes = L.issues.filter((i) => i.sev !== "violation");
    const line = (i) => '<div class="iss' + (i.sev === "violation" ? "" : " note") + '"' + (i.ri != null && i.ri >= 0 ? ' data-ri="' + i.ri + '"' : "") + ">" + esc(i.msg) + "</div>";
    $("issues").innerHTML = (L.style.compliance ? (viol.length ? "" : '<div class="okline">✓ No violations found.</div>') : '<div class="iss note">Compliance mode is off.</div>') + viol.map(line).join("") + notes.map(line).join("");
    // per-sheet labels when the chart runs over several sheets
    const pl = $("pagelabels"), f = fig();
    if (L.pages.length > 1) {
      if (pl.children.length !== L.pages.length) {
        pl.innerHTML = L.pages.map((p, i) => '<label class="f">Sheet ' + (i + 1) + ' label<input data-pl="' + i + '" autocomplete="off"></label>').join("");
        pl.querySelectorAll("input").forEach((inp) => { inp.value = (f.pageLabels && f.pageLabels[+inp.dataset.pl]) || ""; });
      }
      pl.querySelectorAll("input").forEach((inp) => { inp.placeholder = L.pages[+inp.dataset.pl].defLabel; });
    } else pl.innerHTML = "";
    $("desc").value = C.describe(f);
    $("confirm").hidden = true; pendingExport = null;
  }
  $("pagelabels").addEventListener("input", (e) => { const i = e.target.dataset.pl; if (i == null) return; const f = fig(); f.pageLabels = f.pageLabels || []; f.pageLabels[+i] = e.target.value; commitSoon(); renderPreview(); });
  function selectRow(ri) {
    if (ri == null || ri < 0 || ri >= rows().length) return;
    sel = ri; if (tab !== "steps") showTab("steps"); renderRows(true);
    const el = rowsBox.querySelector('.r[data-i="' + ri + '"]'); if (el) el.scrollIntoView({ block: "nearest" });
  }
  $("sheets").addEventListener("click", (e) => { const t = e.target.closest("[data-ri]"); if (t) selectRow(+t.dataset.ri); });
  $("issues").addEventListener("click", (e) => { const t = e.target.closest("[data-ri]"); if (t) selectRow(+t.dataset.ri); });

  function renderAll(focusSel) {
    if (state.cur >= state.figures.length) state.cur = state.figures.length - 1;
    renderFigs(); syncControls(); $("pagelabels").innerHTML = "";
    if (tab === "steps") renderRows(!!focusSel); else if (tab === "outline") $("outline").value = C.toOutline(rows());
    renderPreview();
  }

  // ---------------------------------------------------------------- export
  const status = (t) => { $("status").textContent = t; };
  function download(blob, name) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const baseName = () => "fig-" + (String(fig().label || "x").replace(/[^A-Za-z0-9_-]+/g, "") || "x");
  async function doExport(type) {
    commit(); L = C.layout(fig(), measure);
    const name = baseName(), many = L.pages.length > 1;
    try {
      if (type === "pdf") {
        status("Building the PDF…");
        const bytes = await X.toPDF(L.pages, L.style, window.PDFLib, window.fontkit, await fontFile(L.style.font), (L.style.caption === "Fig." ? "Fig. " : "FIG. ") + (fig().label || ""));
        download(new Blob([bytes], { type: "application/pdf" }), name + ".pdf");
      } else if (type === "svg") {
        L.pages.forEach((p, i) => download(new Blob([C.toSVG(p, L.style)], { type: "image/svg+xml" }), name + (many ? "-sheet" + (i + 1) : "") + ".svg"));
      } else {
        const dpi = +$("dpi").value || 300, f = C.FONTS[L.style.font];
        if (document.fonts && document.fonts.load) await document.fonts.load("20px '" + f.family + "'");
        for (let i = 0; i < L.pages.length; i++) {
          const p = L.pages[i], sc = dpi / 72, cv = document.createElement("canvas");
          cv.width = Math.round(p.w * sc); cv.height = Math.round(p.h * sc);
          X.toCanvas(cv.getContext("2d"), p, L.style, sc);
          const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
          download(await withDpi(blob, dpi), name + (many ? "-sheet" + (i + 1) : "") + ".png");
        }
      }
      status("Saved " + name + "." + type + (many && type !== "pdf" ? " (" + L.pages.length + " sheets)" : "") + ".");
    } catch (err) { console.error(err); status("Export failed: " + (err && err.message ? err.message : err)); }
  }
  // Writes the resolution into the PNG (a pHYs chunk) so it opens at the right physical size.
  async function withDpi(blob, dpi) {
    const b = new Uint8Array(await blob.arrayBuffer()), ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21), dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9); chunk.set([112, 72, 89, 115], 4); dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
    let c, crc = 0xffffffff;
    for (let i = 4; i < 17; i++) { c = (crc ^ chunk[i]) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
    dv.setUint32(17, (crc ^ 0xffffffff) >>> 0);
    const out = new Uint8Array(b.length + 21); out.set(b.subarray(0, 33)); out.set(chunk, 33); out.set(b.subarray(33), 54);
    return new Blob([out], { type: "image/png" });
  }
  document.querySelectorAll("[data-exp]").forEach((b) => b.addEventListener("click", () => {
    const type = b.dataset.exp, viol = L ? L.issues.filter((i) => i.sev === "violation") : [];
    if (L && L.style.compliance && viol.length) {
      pendingExport = type;
      $("confirm").innerHTML = "<b>" + viol.length + " violation" + (viol.length > 1 ? "s" : "") + " of the drawing rules:</b>" + viol.map((v) => "<div>• " + esc(v.msg) + "</div>").join("") +
        '<div class="adds" style="margin-top:6px"><button class="btn sm" id="expyes">Export anyway</button><button class="btn alt sm" id="expno">Go back</button></div>';
      $("confirm").hidden = false;
      $("expyes").onclick = () => { const t = pendingExport; $("confirm").hidden = true; pendingExport = null; doExport(t); };
      $("expno").onclick = () => { $("confirm").hidden = true; pendingExport = null; };
      return;
    }
    doExport(type);
  }));
  $("desccopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("desc").value); } catch (e) { $("desc").select(); document.execCommand("copy"); }
    $("copied").textContent = "Copied."; setTimeout(() => { $("copied").textContent = ""; }, 1500);
  });

  // ---------------------------------------------------------------- project file, keys
  $("save").addEventListener("click", () => { commit(); download(new Blob([JSON.stringify(state, null, 1)], { type: "application/json" }), "flowchart-project.json"); });
  $("open").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", async () => {
    const f = $("file").files[0]; if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      if (!p || !Array.isArray(p.figures) || !p.figures.length) throw new Error("not a project file");
      p.figures.forEach((x) => { x.rows = (x.rows || []).map((r) => ({ level: Math.max(0, r.level | 0), text: String(r.text || ""), num: String(r.num || ""), shape: C.SHAPES[r.shape] ? r.shape : "" })); x.style = x.style || C.usptoStyle(); x.label = String(x.label || ""); });
      state = { app: "coral", version: 1, figures: p.figures, cur: Math.min(p.cur | 0, p.figures.length - 1) };
      sel = -1; commit(); renderAll(); status("Opened " + f.name + ".");
    } catch (err) { status("Could not open that file: " + err.message); }
    $("file").value = "";
  });
  $("undo").addEventListener("click", () => travel(-1));
  $("redo").addEventListener("click", () => travel(1));
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); travel(-1); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); travel(1); }
    else if (k === "s") { e.preventDefault(); $("save").click(); }
  });

  // ---------------------------------------------------------------- start
  commit(); renderAll();
  // text is measured with the embedded fonts, so lay out again once they have loaded
  if (document.fonts && document.fonts.load) {
    Promise.all(Object.keys(C.FONTS).map((k) => document.fonts.load("20px '" + C.FONTS[k].family + "'").catch(() => null))).then(() => renderPreview());
  }
  window.CoralApp = { get state() { return state; }, layout: () => L, doExport, hooks };
})();
