// Weights — Open Weight Watch, read as paint.
// Renders /weights/data/watch.json (rebuilt by CI every few hours) as a
// pigment index (weight sets) and a mosaic gallery (software built on them).
(function () {
  "use strict";

  var root = document.getElementById("oww");
  if (!root) return;

  /* ================================================================
   * Constants
   * ================================================================ */
  var TILE_GRID = 12;                 // 12 × 12 = 144 tesserae per mosaic
  var OTHER_KEY = "__other__";
  var OTHER_HEX = "#b8b2a7";          // uncatalogued models
  var GROUT_HEX = "#d9d3c7";          // setting bed
  var STORE_KEY = "oww.weights.v1";
  var TIER_TEXT = { "I": "fully open", "II": "OSI licence", "III": "conditional licence", "IV": "restricted licence", "—": "unverified" };
  var TR_TEXT = { "T": "transparent: training data released", "ST": "semi-transparent: data partly released or documented", "O": "opaque: training data undisclosed", "?": "transparency unknown" };
  var TR_ALPHA = { "T": 0.6, "ST": 0.8, "O": 0.97, "?": 0.9 };
  var CLASS_TEXT = { osi: "L-A", cond: "L-B", restr: "L-C", unk: "L-?" };
  var STRENGTH = ["Low", "Moderate", "High", "Very high"];
  var FORMAT_LABEL = {
    gguf: "GGUF", mlx: "MLX", awq: "AWQ", gptq: "GPTQ", fp8: "FP8", "compressed-tensors": "compressed-tensors",
    exl2: "EXL2", exl3: "EXL3", onnx: "ONNX", openvino: "OpenVINO", bitsandbytes: "bitsandbytes"
  };
  var RELATION_LABEL = { quantized: "quantisations", finetune: "fine-tunes", adapter: "adapters", merge: "merges" };

  /* ================================================================
   * Small utilities
   * ================================================================ */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  var compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  var whole = new Intl.NumberFormat("en");
  function fmtN(n) { return n == null || !isFinite(n) ? "—" : compact.format(n); }
  function fmtInt(n) { return n == null || !isFinite(n) ? "—" : whole.format(n); }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDay(s) {
    if (!s) return "—";
    var p = String(s).slice(0, 10).split("-");
    if (p.length < 2) return esc(s);
    return (p[2] ? +p[2] + " " : "") + MONTHS[+p[1] - 1] + " " + p[0];
  }
  function relTime(iso, now) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "unknown";
    var mins = Math.max(0, Math.round(((now || Date.now()) - t) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h < 24) return h + " h" + (m ? " " + m + " min" : "") + " ago";
    var d = Math.round(h / 24);
    return d === 1 ? "1 day ago" : d + " days ago";
  }
  function fmtParams(b) {
    if (b == null) return "—";
    return b >= 1000 ? +(b / 1000).toFixed(2) + "T" : +b.toFixed(b < 10 ? 1 : 0) + "B";
  }
  function pct(x) { return x > 0 && x < 0.005 ? "<1%" : Math.round(x * 100) + "%"; }
  function fmtCtx(k) { return k == null ? "—" : k >= 1024 ? +(k / 1024).toFixed(1) + "M" : k + "K"; }
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967295;
  }

  /* ---------- colour ---------- */
  function hexToRgb(hex) {
    var h = String(hex).replace("#", "");
    if (h.length === 3) h = h.replace(/./g, "$&$&");
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r) {
    return "#" + r.map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"); }).join("");
  }
  function mix(hex, other, t) {
    var a = hexToRgb(hex), b = hexToRgb(other);
    return rgbToHex([0, 1, 2].map(function (i) { return a[i] + (b[i] - a[i]) * t; }));
  }
  /** Shift lightness by `d` (−1…1) toward white or black — hand-cut tile variation. */
  function shade(hex, d) { return d >= 0 ? mix(hex, "#ffffff", d) : mix(hex, "#000000", -d); }

  /* ---------- largest-remainder apportionment (mirrors scripts/openweightwatch/lib.mjs) ---------- */
  function apportion(parts, n) {
    var live = parts.filter(function (p) { return isFinite(p.weight) && p.weight > 0; });
    var total = live.reduce(function (s, p) { return s + p.weight; }, 0);
    if (!total || n <= 0) return [];
    var rows = live.map(function (p, i) {
      var exact = p.weight / total * n;
      return { key: p.key, i: i, tiles: Math.floor(exact), rem: exact - Math.floor(exact) };
    });
    var left = n - rows.reduce(function (s, r) { return s + r.tiles; }, 0);
    rows.slice().sort(function (a, b) { return b.rem - a.rem || a.i - b.i; })
      .forEach(function (r) { if (left > 0) { r.tiles += 1; left -= 1; } });
    return rows.filter(function (r) { return r.tiles > 0; })
      .sort(function (a, b) { return b.tiles - a.tiles || a.i - b.i; });
  }

  /* ---------- storage (per-viewer convenience only) ---------- */
  function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } }
  function save(v) { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ } }

  /* ================================================================
   * State
   * ================================================================ */
  var DATA = null;
  var LAB = {};
  var PIG = {};
  var quartiles = [];
  var ui = Object.assign({ q: "", lab: "", tier: "", tr: "", sort: "strength" }, load());

  /* ================================================================
   * Renderers: swatch, sparkline, mosaic
   * ================================================================ */
  function labOf(p) { return LAB[p.lab] || { name: p.lab, pigment: "Unassigned", hex: "#8a8578" }; }

  function swatchHTML(p, big) {
    var lab = labOf(p);
    var hex = lab.hex;
    var alpha = TR_ALPHA[p.transparency] != null ? TR_ALPHA[p.transparency] : 0.9;
    var grad = "linear-gradient(90deg," + hex + " 0%," + hex + " 38%," + mix(hex, "#ffffff", 0.45) + " 70%," + mix(hex, "#ffffff", 0.88) + " 100%)";
    return '<div class="oww-swatch' + (big ? " big" : "") + (p.arch === "moe" ? " granulating" : "") + '" aria-hidden="true">' +
      '<span class="oww-bar"></span>' +
      '<span class="oww-paint" style="background:' + grad + ";opacity:" + alpha + '"></span>' +
      "</div>";
  }

  function sparkline(series, key, label) {
    var pts = (series || []).filter(function (p) { return isFinite(p[key]); });
    if (pts.length < 2) return "";
    var w = 56, h = 18, pad = 2;
    var vals = pts.map(function (p) { return p[key]; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var span = hi - lo || 1;
    var xy = pts.map(function (p, i) {
      return [pad + i / (pts.length - 1) * (w - 2 * pad), h - pad - (p[key] - lo) / span * (h - 2 * pad)];
    });
    var last = xy[xy.length - 1];
    var delta = vals[vals.length - 1] - vals[0];
    return '<span class="oww-spark" title="' + esc(label + ": " + fmtInt(vals[0]) + " → " + fmtInt(vals[vals.length - 1]) + " over " + pts.length + " builds") + '">' +
      '<svg viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">' +
      '<polyline fill="none" stroke="#333" stroke-width="1.25" points="' + xy.map(function (q) { return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ") + '"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2" fill="#333"/></svg>' +
      '<span class="oww-delta">' + (delta >= 0 ? "+" : "−") + fmtN(Math.abs(delta)) + "</span></span>";
  }

  /** Grid cells ordered from the centre outward, ring by ring, clockwise. */
  var SPIRAL = (function () {
    var c = (TILE_GRID - 1) / 2, cells = [];
    for (var r = 0; r < TILE_GRID; r++) for (var col = 0; col < TILE_GRID; col++) {
      cells.push({ r: r, c: col, ring: Math.max(Math.abs(r - c), Math.abs(col - c)), ang: Math.atan2(r - c, col - c) });
    }
    return cells.sort(function (a, b) { return a.ring - b.ring || a.ang - b.ang; });
  })();

  /**
   * Mosaic SVG from weighted parts: [{key, weight}] where key is a pigment id or OTHER_KEY.
   * Dominant pigments sit at the centre; tiles get small seeded shifts in tone, size and angle.
   */
  function mosaicSVG(parts, seed, label) {
    var cell = 12, tile = 10.4, size = TILE_GRID * cell + 2;
    var alloc = apportion(parts, TILE_GRID * TILE_GRID);
    var out = ['<svg class="oww-mosaic" viewBox="0 0 ' + size + " " + size + '" role="img" aria-label="' + esc(label) + '">',
      '<rect width="' + size + '" height="' + size + '" fill="' + GROUT_HEX + '"/>'];
    if (!alloc.length) {
      out.push('<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-size="9" fill="#6b665c">no evidence yet</text></svg>');
      return out.join("");
    }
    var k = 0;
    alloc.forEach(function (a) {
      var base = a.key === OTHER_KEY ? OTHER_HEX : labOf(PIG[a.key] || {}).hex;
      for (var t = 0; t < a.tiles; t++, k++) {
        var cellPos = SPIRAL[k];
        var r1 = hash(seed + ":" + k), r2 = hash(k + ":" + seed), r3 = hash(seed + k);
        var s = tile + (r2 - 0.5) * 0.8;
        var x = 1 + cellPos.c * cell + (cell - s) / 2, y = 1 + cellPos.r * cell + (cell - s) / 2;
        var rot = ((r3 - 0.5) * 7).toFixed(1);
        out.push('<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + s.toFixed(2) + '" height="' + s.toFixed(2) +
          '" rx="1.2" fill="' + shade(base, (r1 - 0.5) * 0.16) + '" transform="rotate(' + rot + " " + (x + s / 2).toFixed(2) + " " + (y + s / 2).toFixed(2) + ')"/>');
      }
    });
    out.push("</svg>");
    return out.join("");
  }

  function legendHTML(parts, limit) {
    var total = parts.reduce(function (s, p) { return s + p.weight; }, 0) || 1;
    return '<ul class="oww-legend">' + parts.slice(0, limit).map(function (p) {
      var name = p.key === OTHER_KEY ? "uncatalogued" : (PIG[p.key] ? PIG[p.key].name : p.key);
      var hex = p.key === OTHER_KEY ? OTHER_HEX : labOf(PIG[p.key] || {}).hex;
      return '<li><i style="background:' + hex + '"></i>' + esc(name) + ' <span>' + pct(p.weight / total) + "</span></li>";
    }).join("") + (parts.length > limit ? '<li class="more">+' + (parts.length - limit) + " more</li>" : "") + "</ul>";
  }

  /* ================================================================
   * Derived values
   * ================================================================ */
  function computeQuartiles(pigs) {
    var d = pigs.map(function (p) { return p.hub && p.hub.downloads; }).filter(isFinite).sort(function (a, b) { return a - b; });
    if (d.length < 4) return [];
    return [0.25, 0.5, 0.75].map(function (q) { return d[Math.min(d.length - 1, Math.floor(q * d.length))]; });
  }
  function strengthOf(p) {
    var d = p.hub && p.hub.downloads;
    if (!isFinite(d) || !quartiles.length) return -1;
    var b = 0;
    while (b < 3 && d >= quartiles[b]) b++;
    return b;
  }
  function derivTotal(p) {
    var der = p.hub && p.hub.derivatives;
    if (!der) return 0;
    return ["quantized", "finetune", "adapter", "merge"].reduce(function (s, k) { return s + ((der[k] && der[k].count) || 0); }, 0);
  }
  function anyCapped(p) {
    var der = p.hub && p.hub.derivatives;
    return !!der && ["quantized", "finetune", "adapter", "merge"].some(function (k) { return der[k] && der[k].capped; });
  }
  function runtimeParts(rt) { return (rt.composition || []).map(function (c) { return { key: c.pigment, weight: c.weight }; }); }
  function spaceParts(sp) {
    var parts = (sp.pigments || []).map(function (id) { return { key: id, weight: 1 }; });
    var other = Math.max(0, (sp.modelCount || 0) - parts.length);
    if (other) parts.push({ key: OTHER_KEY, weight: other });
    return parts;
  }
  function evidenceUnit(rt) {
    var ev = rt.evidence || {};
    var bits = (ev.formats || []).map(function (f) { return FORMAT_LABEL[f] || f; });
    var rels = (ev.relations || []).map(function (r) { return RELATION_LABEL[r] || r; });
    return bits.length ? "Hub repos in " + bits.join(", ") : "Hub " + rels.join(", ");
  }

  /* ================================================================
   * Freshness
   * ================================================================ */
  function renderFreshness() {
    var el = $("oww-fresh");
    var gen = Date.parse(DATA.generatedAt);
    var age = (Date.now() - gen) / 3600000;
    var limit = (DATA.refreshHours || 3) * 2.5;
    var s = DATA.stats || {};
    var parts = [
      '<span class="oww-dot ' + (age > limit ? "stale" : "live") + '" aria-hidden="true"></span>',
      "Live data built <strong>" + esc(relTime(DATA.generatedAt)) + "</strong>",
      '<span class="oww-muted">(' + esc(new Date(gen).toUTCString().replace(" GMT", " UTC")) + ")</span>",
      "· rebuilt about every " + esc(DATA.refreshHours || 3) + " h from the Hugging Face Hub and GitHub",
      "· " + fmtInt(s.pigmentsLive) + " of " + fmtInt(s.pigmentsTotal) + " weight sets reachable"
    ];
    if (age > limit) parts.push('· <span class="oww-warn">older than expected; the next scheduled build will refresh it</span>');
    if (DATA.lastAttempt) parts.push('· <span class="oww-warn">the build at ' + esc(fmtDay(DATA.lastAttempt.at)) + " could not reach the sources, so this is the last good data</span>");
    el.innerHTML = parts.join(" ");
  }

  /* ================================================================
   * Pigments view
   * ================================================================ */
  var SORTS = {
    strength: function (a, b) { return ((b.hub && b.hub.downloads) || -1) - ((a.hub && a.hub.downloads) || -1); },
    likes: function (a, b) { return ((b.hub && b.hub.likes) || -1) - ((a.hub && a.hub.likes) || -1); },
    derivatives: function (a, b) { return derivTotal(b) - derivTotal(a); },
    date: function (a, b) { return String(b.date).localeCompare(String(a.date)); },
    size: function (a, b) { return (b.total || -1) - (a.total || -1); },
    openness: function (a, b) { return b.score - a.score; }
  };

  function matches(p) {
    if (ui.lab && p.lab !== ui.lab) return false;
    if (ui.tier && p.tier !== ui.tier) return false;
    if (ui.tr && p.transparency !== ui.tr) return false;
    if (ui.q) {
      var lab = labOf(p);
      var hay = [p.name, lab.name, lab.pigment, p.licenseName, p.hub && p.hub.id, p.arch === "moe" ? "moe mixture of experts granulating" : "dense"].join(" ").toLowerCase();
      return ui.q.toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) !== -1; });
    }
    return true;
  }

  function pigmentCard(p) {
    var lab = labOf(p);
    var h = p.hub || {};
    var st = strengthOf(p);
    var flags = (p.checks || []).filter(function (c) { return c.kind !== "missing"; }).length;
    var tube = [
      '<abbr title="Lightfastness ' + esc(p.tier) + ": " + esc(TIER_TEXT[p.tier]) + '">LF ' + esc(p.tier) + "</abbr>",
      '<abbr title="' + esc(TR_TEXT[p.transparency]) + '">' + esc(p.transparency) + "</abbr>",
      p.arch === "moe" ? '<abbr title="Mixture of experts">granulating</abbr>' : p.arch === "dense" ? "smooth" : "texture ?"
    ].join(" · ");
    var stats = h.found
      ? '<dl class="oww-stats">' +
          "<dt>Tinting</dt><dd>" + (st >= 0 ? '<span class="oww-meter" aria-hidden="true">' + [0, 1, 2, 3].map(function (i) { return "<i" + (i <= st ? ' class="on"' : "") + "></i>"; }).join("") + "</span>" + STRENGTH[st] : "—") + "</dd>" +
          "<dt>30-day</dt><dd>" + fmtN(h.downloads) + " ↓ " + sparkline(p.history, "d", "30-day downloads") + "</dd>" +
          "<dt>Likes</dt><dd>" + fmtN(h.likes) + " " + sparkline(p.history, "l", "likes") + "</dd>" +
          "<dt>Mixtures</dt><dd>" + fmtN(derivTotal(p)) + (anyCapped(p) ? "+" : "") + " derivatives</dd>" +
        "</dl>"
      : '<p class="oww-muted oww-small">Not located on the Hub yet.</p>';
    return '<article class="swatch-card oww-card' + (h.stale ? " is-stale" : "") + '">' +
      swatchHTML(p) +
      '<h4 class="swatch-name"><button type="button" class="oww-open" data-kind="pigment" data-id="' + esc(p.id) + '">' + esc(p.name) + "</button></h4>" +
      '<div class="swatch-source">' + esc(lab.name) + " · " + esc(lab.pigment) + "</div>" +
      '<div class="swatch-formula">' + tube + " · " + fmtParams(p.total) + "</div>" +
      stats +
      '<div class="oww-chips">' +
        (p.status === "reported" ? '<span class="oww-chip warn">reported</span>' : "") +
        (flags ? '<span class="oww-chip warn" title="Hub metadata disagrees with the catalogue">' + flags + " Hub check" + (flags > 1 ? "s" : "") + "</span>" : "") +
        (h.stale ? '<span class="oww-chip">last good data</span>' : "") +
      "</div>" +
      "</article>";
  }

  function renderPigments() {
    var rows = DATA.pigments.filter(matches).sort(function (a, b) {
      return SORTS[ui.sort](a, b) || a.name.localeCompare(b.name);
    });
    $("pf-count").textContent = rows.length === DATA.pigments.length
      ? "All " + rows.length + " catalogued weight sets."
      : rows.length + " of " + DATA.pigments.length + " weight sets match.";
    $("oww-pgrid").innerHTML = rows.length
      ? rows.map(pigmentCard).join("")
      : '<p class="empty-note">No weight sets match these filters.</p>';
  }

  /* ================================================================
   * Mosaics view
   * ================================================================ */
  function runtimeCard(rt) {
    var g = rt.github || {};
    var parts = runtimeParts(rt);
    return '<article class="swatch-card oww-card oww-mcard' + (g.stale ? " is-stale" : "") + '">' +
      mosaicSVG(parts, rt.repo, rt.name + " mosaic") +
      '<h4 class="swatch-name"><button type="button" class="oww-open" data-kind="runtime" data-id="' + esc(rt.repo) + '">' + esc(rt.name) + "</button></h4>" +
      '<div class="swatch-source">' + esc(rt.role) + "</div>" +
      '<div class="swatch-formula">★ ' + fmtN(g.stars) + " " + sparkline(rt.history, "s", "GitHub stars") +
        (g.release ? " · " + esc(g.release.tag) + ' <span class="oww-muted">(' + esc(relTime(g.release.publishedAt)) + ")</span>" : "") + "</div>" +
      legendHTML(parts, 4) +
      '<div class="oww-small oww-muted">Tessera = ' + esc(evidenceUnit(rt)) + "</div>" +
      "</article>";
  }

  function spaceCard(sp) {
    var parts = spaceParts(sp);
    var stage = sp.stage ? String(sp.stage).toLowerCase().replace(/_/g, " ") : null;
    return '<article class="swatch-card oww-card oww-mcard' + (sp.stale ? " is-stale" : "") + '">' +
      mosaicSVG(parts, sp.id, sp.title + " mosaic") +
      '<h4 class="swatch-name"><button type="button" class="oww-open" data-kind="space" data-id="' + esc(sp.id) + '">' + (sp.emoji ? esc(sp.emoji) + " " : "") + esc(sp.title) + "</button></h4>" +
      '<div class="swatch-source">' + esc(sp.id) + "</div>" +
      '<div class="swatch-formula">♥ ' + fmtN(sp.likes) + (sp.sdk ? " · " + esc(sp.sdk) : "") +
        (stage ? ' · <span class="oww-stage ' + (stage === "running" ? "on" : "") + '">' + esc(stage) + "</span>" : "") + "</div>" +
      legendHTML(parts, 4) +
      "</article>";
  }

  function renderMosaics() {
    var rts = (DATA.runtimes || []).slice().sort(function (a, b) {
      return ((b.github && b.github.stars) || 0) - ((a.github && a.github.stars) || 0);
    });
    $("oww-rgrid").innerHTML = rts.length ? rts.map(runtimeCard).join("") : '<p class="empty-note">No runtime data in this build.</p>';
    var sps = (DATA.spaces || []).slice().sort(function (a, b) { return (b.likes || 0) - (a.likes || 0); });
    $("oww-sgrid").innerHTML = sps.length ? sps.map(spaceCard).join("") : '<p class="empty-note">No Spaces in this build.</p>';
  }

  /* ================================================================
   * Fresh on the Hub
   * ================================================================ */
  function renderFresh() {
    var rows = DATA.discovered || [];
    $("oww-ftbody").innerHTML = rows.length ? rows.map(function (d) {
      return "<tr>" +
        '<td><a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.id) + " ↗</a>" + (d.gated ? ' <span class="oww-chip">gated</span>' : "") + "</td>" +
        '<td class="r">' + (d.params ? fmtParams(d.params / 1e9) : "—") + "</td>" +
        "<td>" + esc(d.license || "none") + ' <span class="oww-muted">' + esc(CLASS_TEXT[d.licenseClass] || "L-?") + "</span></td>" +
        '<td class="r">' + fmtN(d.downloads) + "</td>" +
        '<td class="r">' + fmtN(d.likes) + "</td>" +
        "<td>" + fmtDay(d.createdAt) + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="6" class="empty-note">Nothing new is trending outside the catalogue right now.</td></tr>';
  }

  /* ================================================================
   * Detail dialog
   * ================================================================ */
  var dialog = $("oww-detail");
  var lastFocus = null;

  function openDialog(html) {
    $("oww-detail-body").innerHTML = html;
    lastFocus = document.activeElement;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    var closeBtn = dialog.querySelector(".oww-close");
    if (closeBtn) closeBtn.focus();
  }
  dialog.addEventListener("close", function () { if (lastFocus && lastFocus.focus) lastFocus.focus(); });
  dialog.addEventListener("click", function (e) {
    if (e.target === dialog) dialog.close ? dialog.close() : dialog.removeAttribute("open");
    var link = e.target.closest && e.target.closest("[data-goto]");
    if (link) {
      e.preventDefault();
      var kind = link.getAttribute("data-kind"), id = link.getAttribute("data-goto");
      show(kind, id);
    }
  });

  function yesNo(v, y, n) { return v === true ? y : v === false ? n : "unknown"; }
  function dataText(d) { return d === 2 ? "released in full" : d === 1 ? "partially released or documented" : d === 0 ? "undisclosed" : "unknown"; }
  function gotoLink(kind, id, text) { return '<a href="#" data-kind="' + kind + '" data-goto="' + esc(id) + '">' + esc(text) + "</a>"; }

  function pigmentDetail(p) {
    var lab = labOf(p), h = p.hub || {}, der = h.derivatives || {};
    var licPts = { osi: 2, cond: 1, restr: 0, unk: 0 }[p.cls];
    var lic = (DATA.licenses || {})[p.license] || {};
    var formats = (der.quantized && der.quantized.formats) || {};
    var fmtRows = Object.keys(formats).sort(function (a, b) { return formats[b].repos - formats[a].repos; }).map(function (f) {
      var x = formats[f];
      return "<tr><td>" + esc(FORMAT_LABEL[f] || f) + '</td><td class="r">' + fmtInt(x.repos) + '</td><td class="r">' + fmtN(x.downloads) + "</td><td>" +
        (x.top ? '<a href="https://huggingface.co/' + esc(x.top.id) + '" target="_blank" rel="noopener">' + esc(x.top.id) + "</a>" : "—") + "</td></tr>";
    }).join("");
    var usedBy = (DATA.runtimes || []).map(function (rt) {
      var tot = (rt.composition || []).reduce(function (s, c) { return s + c.weight; }, 0);
      var mine = (rt.composition || []).filter(function (c) { return c.pigment === p.id; })[0];
      return mine ? { rt: rt, share: mine.weight / tot, weight: mine.weight } : null;
    }).filter(Boolean).sort(function (a, b) { return b.share - a.share; });
    var spaces = (DATA.spaces || []).filter(function (s) { return (s.pigments || []).indexOf(p.id) !== -1; });

    return '<div class="oww-detail-head">' + swatchHTML(p, true) +
      "<div><h2 id=\"oww-detail-title\">" + esc(p.name) + "</h2>" +
      '<p class="swatch-source">' + esc(lab.name) + " · hue: " + esc(lab.pigment) +
        (lab.palette ? ' (<a href="' + esc(root.getAttribute("data-palette")) + '">on the palette</a>)' : "") + "</p>" +
      '<p class="swatch-formula">Released ' + fmtDay(p.date) + " · " + (p.arch === "moe" ? "mixture of experts" : p.arch || "architecture unknown") +
        " · " + fmtParams(p.total) + (p.active ? " total, " + fmtParams(p.active) + " active" : "") + " · context " + fmtCtx(p.ctx) + "</p></div></div>" +

      '<div class="oww-detail-grid">' +
      "<section><h3>Tube label</h3><ol class=\"oww-outline\">" +
        "<li>Lightfastness <strong>" + esc(p.tier) + "</strong>: " + esc(TIER_TEXT[p.tier]) + "</li>" +
        "<li>Transparency <strong>" + esc(p.transparency) + "</strong>: " + esc(TR_TEXT[p.transparency]) + "</li>" +
        "<li>Openness score <strong>" + p.score + " / 6</strong><ol type=\"a\">" +
          "<li>Licence " + esc(CLASS_TEXT[p.cls]) + ": " + licPts + " / 2 — " + esc(p.licenseName) + (lic.note ? "<br><span class=\"oww-muted\">" + esc(lic.note) + "</span>" : "") + "</li>" +
          "<li>Training code: " + (p.code === true ? 1 : 0) + " / 1 — " + yesNo(p.code, "released", "not released") + "</li>" +
          "<li>Training data: " + (p.data || 0) + " / 2 — " + dataText(p.data) + "</li>" +
          "<li>Technical report: " + (p.report === true ? 1 : 0) + " / 1 — " + yesNo(p.report, "published", "none") + "</li>" +
        "</ol></li>" +
        "<li>Verification: " + (p.status === "confirmed" ? "confirmed against the official release" : "reported in secondary coverage" + (p.src ? ' (<a href="' + esc(p.src) + '" target="_blank" rel="noopener">source</a>)' : "")) + "</li>" +
        (p.note ? "<li>" + esc(p.note) + "</li>" : "") +
      "</ol></section>" +

      "<section><h3>On the Hub " + (h.stale ? '<span class="oww-chip">last good data</span>' : '<span class="oww-live">live</span>') + "</h3>" +
      (h.found
        ? '<dl class="oww-stats wide">' +
            '<dt>Repository</dt><dd><a href="' + esc(h.url || "https://huggingface.co/" + h.id) + '" target="_blank" rel="noopener">' + esc(h.id) + " ↗</a>" + (h.resolvedBy === "search" ? ' <span class="oww-muted">(found by search)</span>' : "") + "</dd>" +
            "<dt>Downloads</dt><dd>" + fmtInt(h.downloads) + " in 30 days" + (h.downloadsAllTime ? " · " + fmtN(h.downloadsAllTime) + " all time" : "") + "</dd>" +
            "<dt>Likes</dt><dd>" + fmtInt(h.likes) + "</dd>" +
            "<dt>Hub licence</dt><dd>" + esc(h.license || "none") + " (" + esc(CLASS_TEXT[h.licenseClass] || "L-?") + ")" + (h.gated ? " · gated" : "") + "</dd>" +
            "<dt>Hub params</dt><dd>" + (h.params ? fmtParams(h.params / 1e9) : "—") + "</dd>" +
            "<dt>Updated</dt><dd>" + fmtDay(h.lastModified) + "</dd>" +
          "</dl>" +
          ((p.checks || []).length ? '<ul class="oww-checks">' + p.checks.map(function (c) { return "<li>" + esc(c.message) + "</li>"; }).join("") + "</ul>" : "")
        : "<p>" + esc(((p.checks || [])[0] || {}).message || "Not located on the Hub.") + "</p>") +
      "</section>" +

      "<section><h3>Convenience mixtures</h3>" +
        '<ul class="oww-plain">' + ["quantized", "finetune", "adapter", "merge"].map(function (k) {
          var d = der[k] || {};
          return "<li>" + fmtInt(d.count || 0) + (d.capped ? "+" : "") + " " + RELATION_LABEL[k] + "</li>";
        }).join("") + "</ul>" +
        (fmtRows ? '<div class="oww-table-wrap"><table><thead><tr><th>Format</th><th class="r">Repos</th><th class="r">Downloads</th><th>Most used</th></tr></thead><tbody>' + fmtRows + "</tbody></table></div>" : "") +
      "</section>" +

      "<section><h3>Set in these mosaics</h3>" +
        (usedBy.length ? '<ul class="oww-plain">' + usedBy.map(function (u) {
          return "<li>" + gotoLink("runtime", u.rt.repo, u.rt.name) + " — " + pct(u.share) + " of tesserae (" + fmtInt(u.weight) + ")</li>";
        }).join("") + "</ul>" : '<p class="oww-muted">No runtime evidence yet.</p>') +
        (spaces.length ? '<p class="oww-small">Spaces: ' + spaces.map(function (s) { return gotoLink("space", s.id, s.title); }).join(", ") + "</p>" : "") +
      "</section></div>";
  }

  function compositionTable(parts) {
    var total = parts.reduce(function (s, p) { return s + p.weight; }, 0) || 1;
    return '<div class="oww-table-wrap"><table><thead><tr><th>Pigment</th><th class="r">Evidence</th><th class="r">Share</th></tr></thead><tbody>' +
      parts.map(function (p) {
        var pig = PIG[p.key];
        var hex = p.key === OTHER_KEY ? OTHER_HEX : labOf(pig || {}).hex;
        var name = p.key === OTHER_KEY ? "uncatalogued models" : pig ? gotoLink("pigment", pig.id, pig.name) : esc(p.key);
        return '<tr><td><i class="oww-dotswatch" style="background:' + hex + '"></i>' + name + '</td><td class="r">' + fmtInt(p.weight) + '</td><td class="r">' + (p.weight / total * 100).toFixed(1) + "%</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function runtimeDetail(rt) {
    var g = rt.github || {};
    var parts = runtimeParts(rt);
    return '<div class="oww-detail-head">' + mosaicSVG(parts, rt.repo, rt.name + " mosaic") +
      '<div><h2 id="oww-detail-title">' + esc(rt.name) + "</h2>" +
      '<p class="swatch-source">' + esc(g.description || rt.role) + "</p>" +
      '<dl class="oww-stats wide">' +
        '<dt>Repository</dt><dd><a href="' + esc(g.url || "https://github.com/" + rt.repo) + '" target="_blank" rel="noopener">' + esc(rt.repo) + " ↗</a></dd>" +
        "<dt>Stars</dt><dd>" + fmtInt(g.stars) + " " + sparkline(rt.history, "s", "stars") + "</dd>" +
        "<dt>Last push</dt><dd>" + (g.pushedAt ? esc(relTime(g.pushedAt)) : "—") + "</dd>" +
        "<dt>Release</dt><dd>" + (g.release ? '<a href="' + esc(g.release.url) + '" target="_blank" rel="noopener">' + esc(g.release.tag) + "</a> · " + fmtDay(g.release.publishedAt) : "—") + "</dd>" +
        "<dt>Licence</dt><dd>" + esc(g.license || "—") + "</dd>" +
        "<dt>Tessera</dt><dd>" + esc(evidenceUnit(rt)) + "</dd>" +
      "</dl></div></div>" +
      "<h3>Composition</h3>" + (parts.length ? compositionTable(parts) : '<p class="oww-muted">No evidence in this build.</p>');
  }

  function spaceDetail(sp) {
    var parts = spaceParts(sp);
    return '<div class="oww-detail-head">' + mosaicSVG(parts, sp.id, sp.title + " mosaic") +
      '<div><h2 id="oww-detail-title">' + (sp.emoji ? esc(sp.emoji) + " " : "") + esc(sp.title) + "</h2>" +
      '<dl class="oww-stats wide">' +
        '<dt>Space</dt><dd><a href="' + esc(sp.url) + '" target="_blank" rel="noopener">' + esc(sp.id) + " ↗</a></dd>" +
        "<dt>Likes</dt><dd>" + fmtInt(sp.likes) + "</dd>" +
        "<dt>SDK</dt><dd>" + esc(sp.sdk || "—") + "</dd>" +
        "<dt>Status</dt><dd>" + esc(sp.stage || "—") + "</dd>" +
        "<dt>Updated</dt><dd>" + fmtDay(sp.lastModified) + "</dd>" +
      "</dl></div></div>" +
      "<h3>Composition</h3>" + compositionTable(parts) +
      ((sp.otherModels || []).length ? '<p class="oww-small oww-muted">Uncatalogued: ' + sp.otherModels.map(esc).join(", ") + "</p>" : "");
  }

  function show(kind, id) {
    if (kind === "pigment" && PIG[id]) return openDialog(pigmentDetail(PIG[id]));
    if (kind === "runtime") {
      var rt = (DATA.runtimes || []).filter(function (r) { return r.repo === id; })[0];
      if (rt) return openDialog(runtimeDetail(rt));
    }
    if (kind === "space") {
      var sp = (DATA.spaces || []).filter(function (s) { return s.id === id; })[0];
      if (sp) return openDialog(spaceDetail(sp));
    }
  }

  /* ================================================================
   * Tabs, filters, wiring
   * ================================================================ */
  var TABS = { pigments: "tab-pigments", mosaics: "tab-mosaics", fresh: "tab-fresh" };

  function selectTab(name, push) {
    if (!TABS[name]) name = "pigments";
    Object.keys(TABS).forEach(function (k) {
      var tab = $(TABS[k]);
      var on = k === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      $(tab.getAttribute("aria-controls")).hidden = !on;
    });
    if (push && history.replaceState) history.replaceState(null, "", "#" + name);
  }

  function wire() {
    Object.keys(TABS).forEach(function (k, i, keys) {
      var tab = $(TABS[k]);
      tab.addEventListener("click", function () { selectTab(k, true); });
      tab.addEventListener("keydown", function (e) {
        var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        var next = keys[(i + d + keys.length) % keys.length];
        selectTab(next, true);
        $(TABS[next]).focus();
      });
    });
    selectTab((location.hash || "").replace("#", ""), false);

    var fields = { q: "pf-q", lab: "pf-lab", tier: "pf-tier", tr: "pf-tr", sort: "pf-sort" };
    Object.keys(fields).forEach(function (k) {
      var el = $(fields[k]);
      if (el.tagName === "SELECT" && !Array.prototype.some.call(el.options, function (o) { return o.value === ui[k]; })) {
        ui[k] = k === "sort" ? "strength" : "";
      }
      el.value = ui[k];
      el.addEventListener(el.tagName === "INPUT" ? "input" : "change", function () {
        ui[k] = el.value.trim();
        save(ui);
        renderPigments();
      });
    });
    $("oww-pfilters").addEventListener("submit", function (e) { e.preventDefault(); });

    root.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest(".oww-open");
      if (!btn) return;
      show(btn.getAttribute("data-kind"), btn.getAttribute("data-id"));
    });
  }

  function fillLabSelect() {
    var used = {};
    DATA.pigments.forEach(function (p) { used[p.lab] = true; });
    $("pf-lab").insertAdjacentHTML("beforeend", DATA.labs.filter(function (l) { return used[l.key]; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); })
      .map(function (l) { return '<option value="' + esc(l.key) + '">' + esc(l.name) + "</option>"; }).join(""));
  }

  function renderAll() {
    renderFreshness();
    renderPigments();
    renderMosaics();
    renderFresh();
  }

  function fail(msg) {
    $("oww-fresh").innerHTML = '<span class="oww-dot stale" aria-hidden="true"></span> ' + esc(msg);
    $("oww-pgrid").innerHTML = '<p class="empty-note">The pigment index appears here once the scheduled build has fetched live data from the Hugging Face Hub and GitHub.</p>';
    $("oww-rgrid").innerHTML = "";
    $("oww-sgrid").innerHTML = "";
    $("oww-ftbody").innerHTML = "";
  }

  wire();
  fetch(root.getAttribute("data-src"), { cache: "no-cache" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (doc) {
      if (!doc || doc.schema !== 1 || !Array.isArray(doc.pigments)) throw new Error("unexpected data format");
      DATA = doc;
      (doc.labs || []).forEach(function (l) { LAB[l.key] = l; });
      doc.pigments.forEach(function (p) { PIG[p.id] = p; });
      quartiles = computeQuartiles(doc.pigments);
      fillLabSelect();
      var labSel = $("pf-lab");
      if (ui.lab && !Array.prototype.some.call(labSel.options, function (o) { return o.value === ui.lab; })) ui.lab = "";
      labSel.value = ui.lab;
      renderAll();
      // Keep the relative "built … ago" line honest while the page stays open.
      setInterval(renderFreshness, 60000);
    })
    .catch(function (err) {
      fail("Live data is not available yet (" + err.message + "). It is generated by the site’s scheduled build every few hours.");
    });
})();
