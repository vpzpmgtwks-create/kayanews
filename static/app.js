/* ==========================================================================
   Market Brief — client renderer + live auto-refresh (Convix hero edition)
   Populates the hero dashboard cards (VIX / score / market mood) with animated
   tick-gauges, plus the full report below (tickers, VIX chart, sentiment,
   news). Smoothly tweens values on each 60s refresh and shows live feedback.
 * ========================================================================== */
(function () {
  "use strict";

  var MAX_VIX = 50;
  var REFRESH = (window.MB_REFRESH_SECONDS || 60);
  var REDUCED = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var initialDone = false;
  var _seenUrls = new Set();
  var lastReport = null;          // most recent data, for re-render on focus
  var numState = new WeakMap();   // element -> last numeric value shown
  var gaugeVals = {};             // gauge id -> { v: rawValue, p: pct }
  var newsSearchTerm = "";        // live news-search filter
  var refreshPaused = false;      // pause / resume auto-refresh
  var READ_NEWS_KEY = "mb-read-v1";
  var readNews = (function () {
    try { return new Set(JSON.parse(localStorage.getItem(READ_NEWS_KEY) || "[]")); }
    catch (e) { return new Set(); }
  })();

  // ---- helpers ----------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function num(v, d) {
    if (v == null || isNaN(v)) return "—";
    return Number(v).toLocaleString("en-US",
      { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function signed(v, d) {
    if (v == null || isNaN(v)) return "—";
    return (Number(v) >= 0 ? "+" : "") + num(v, d);
  }
  function sentColor(s) { return s > 0 ? "#22C97A" : s < 0 ? "#E05050" : "#F07818"; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  // easeOutExpo — long, gentle deceleration for a premium settle
  function easeOutExpo(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); }

  function hexA(hex, a) {
    var h = hex.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return "rgba(" + parseInt(h.substr(0, 2), 16) + "," +
      parseInt(h.substr(2, 2), 16) + "," + parseInt(h.substr(4, 2), 16) + "," + a + ")";
  }
  function setText(id, t) { var e = $(id); if (e) e.textContent = t; }

  // ---- animated number tween -------------------------------------------
  function animNum(el, to, fmt, dur, delay) {
    if (!el || to == null || isNaN(to)) { if (el) el.textContent = "—"; return; }
    var from = numState.has(el) ? numState.get(el) : 0;
    numState.set(el, to);
    if (REDUCED || document.hidden || from === to) { el.textContent = fmt(to); return; }
    dur = dur || 1300;
    el.textContent = fmt(from);
    var run = function () {
      var start = performance.now();
      (function frame(now) {
        var p = Math.min(1, (now - start) / dur);
        el.textContent = fmt(from + (to - from) * easeOutExpo(p));
        if (p < 1) requestAnimationFrame(frame);
        else el.textContent = fmt(to);
      })(start);
    };
    if (delay) setTimeout(run, delay); else run();
  }

  // ---- tick gauge (40 ticks over a 180° arc, RTL fill right→left) --------
  // Built ONCE per gauge; each animation frame only recolors strokes + text
  // (no innerHTML churn) so the sweep stays perfectly smooth.
  var GAUGE_N = 40;
  function ensureGauge(el) {
    if (el._g) return el._g;
    var N = GAUGE_N, cx = 100, cy = 100, rI = 70, rO = 80, s = "";
    for (var i = 0; i < N; i++) {
      var a = 2 * Math.PI - (i / (N - 1)) * Math.PI;     // right → left
      var x1 = cx + rI * Math.cos(a), y1 = cy + rI * Math.sin(a);
      var x2 = cx + rO * Math.cos(a), y2 = cy + rO * Math.sin(a);
      s += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' +
        x2.toFixed(1) + '" y2="' + y2.toFixed(1) +
        '" stroke="#252525" stroke-width="2.6" stroke-linecap="round"/>';
    }
    s += '<text x="100" y="97" text-anchor="middle" font-size="26" font-weight="700" ' +
      'fill="currentColor" font-family="Tajawal,sans-serif"></text>';
    el.innerHTML = s;
    el._g = { lines: el.querySelectorAll("line"), text: el.querySelector("text") };
    return el._g;
  }
  function paintGauge(el, pct, centerText, color) {
    var g = ensureGauge(el), N = g.lines.length;
    var active = Math.round(Math.max(0, Math.min(100, pct)) / 100 * N);
    for (var i = 0; i < N; i++) g.lines[i].setAttribute("stroke", i < active ? color : "#252525");
    if (g.text) g.text.textContent = centerText;
  }

  function animGaugeTick(id, rawValue, pct, fmt, color, delay) {
    var el = $(id); if (!el) return;
    var prev = gaugeVals[id] || { v: 0, p: 0 };
    var hasV = !(rawValue == null || isNaN(rawValue));
    var toV = hasV ? Number(rawValue) : 0;
    var toP = pct || 0;
    gaugeVals[id] = { v: toV, p: toP };
    var centerOf = function (v) { return hasV ? fmt(v) : "—"; };
    if (REDUCED || document.hidden || (prev.v === toV && prev.p === toP)) {
      paintGauge(el, toP, centerOf(toV), color); return;
    }
    var fromV = prev.v, fromP = prev.p, dur = 1400;
    paintGauge(el, fromP, centerOf(fromV), color);   // settle at start state
    var run = function () {
      var start = performance.now();
      (function frame(now) {
        var t = Math.min(1, (now - start) / dur), e = easeOutExpo(t);
        paintGauge(el, fromP + (toP - fromP) * e, centerOf(fromV + (toV - fromV) * e), color);
        if (t < 1) requestAnimationFrame(frame);
      })(start);
    };
    if (delay) setTimeout(run, delay); else run();
  }

  // ---- trend pills ------------------------------------------------------
  var TREND_UP = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>';
  var TREND_DOWN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></svg>';

  // upIsGood: whether a rise should read as positive (green). For VIX a rise
  // means MORE fear (false); for greed indices a rise is risk-on (true).
  function setPill(id, change, text, upIsGood) {
    var el = $(id); if (!el) return;
    var up = change > 0, down = change < 0;
    var good = up ? upIsGood : down ? !upIsGood : null;
    var color = good == null ? "#888888" : good ? "#22C97A" : "#E05050";
    var bg = good == null ? "rgba(60,60,60,.35)" : good ? "rgba(34,201,122,.12)" : "rgba(224,80,80,.12)";
    var icon = up ? TREND_UP : down ? TREND_DOWN : "";
    el.style.color = color; el.style.background = bg; el.style.borderColor = "transparent";
    el.innerHTML = icon + "<span>" + esc(text) + "</span>";
  }

  // ---- VIX month chart --------------------------------------------------
  function drawSpark(vix, animate) {
    var el = $("vix-spark");
    if (!el) return;
    var h = (vix && vix.history) || [];
    if (h.length < 2) { el.innerHTML = ""; return; }
    var W = 640, H = 260, pl = 12, pr = 12, pt = 24, pb = 28;
    var cw = W - pl - pr, ch = H - pt - pb;
    var min = Math.min.apply(null, h), max = Math.max.apply(null, h);
    var pad = (max - min) * 0.18 || 1; min -= pad; max += pad;
    var color = (vix && vix.color) || "#ef4d23";
    function X(i) { return pl + (i / (h.length - 1)) * cw; }
    function Y(v) { return pt + (1 - (v - min) / (max - min)) * ch; }

    var grid = "";
    for (var k = 0; k <= 2; k++) {
      var gy = (pt + ch * k / 2).toFixed(1);
      grid += '<line x1="' + pl + '" y1="' + gy + '" x2="' + (W - pr) + '" y2="' + gy +
        '" stroke="#1e1e1e" stroke-width="1"/>';
    }
    var line = "";
    h.forEach(function (v, i) { line += (i ? " L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1); });
    var area = "M" + X(0).toFixed(1) + " " + (pt + ch).toFixed(1) + " " +
      line.replace(/^M/, "L") + " L" + X(h.length - 1).toFixed(1) + " " + (pt + ch).toFixed(1) + " Z";
    var lx = X(h.length - 1).toFixed(1), ly = Y(h[h.length - 1]).toFixed(1);

    el.innerHTML =
      '<defs><linearGradient id="vg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + hexA(color, .30) + '"/>' +
      '<stop offset="1" stop-color="' + hexA(color, .02) + '"/></linearGradient></defs>' +
      grid +
      '<path class="spark-area" d="' + area + '" fill="url(#vg)"/>' +
      '<path class="spark-line" d="' + line + '" fill="none" stroke="' + color +
      '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle class="spark-dot" cx="' + lx + '" cy="' + ly + '" r="5" fill="#111111" stroke="' +
      color + '" stroke-width="3"/>';

    var path = el.querySelector(".spark-line");
    var areaEl = el.querySelector(".spark-area");
    var dot = el.querySelector(".spark-dot");
    if (path && animate && !REDUCED && !document.hidden) {
      var len = path.getTotalLength();
      path.style.transition = "none";
      path.style.strokeDasharray = len; path.style.strokeDashoffset = len;
      if (areaEl) { areaEl.style.opacity = "0"; }
      if (dot) { dot.style.opacity = "0"; dot.style.transition = "opacity .4s ease 1.2s"; }
      requestAnimationFrame(function () {
        path.style.transition = "stroke-dashoffset 1.5s var(--ease)";
        path.style.strokeDashoffset = "0";
        if (areaEl) { areaEl.style.transition = "opacity 1.2s ease .3s"; areaEl.style.opacity = "1"; }
        if (dot) dot.style.opacity = "1";
      });
    }
  }

  // ---- hero card renderers ---------------------------------------------
  function renderVix(vix, initial) {
    vix = vix || {};
    var color = vix.color || "#ef4d23";
    var cur = vix.current;
    var pct = cur != null ? Math.max(0, Math.min(1, cur / MAX_VIX)) * 100 : 0;
    animGaugeTick("g-vix", cur, pct, function (v) { return num(v, 1); }, color, initial ? 640 : 0);
    setText("g-vix-min", vix.month_low != null ? num(vix.month_low, 1) : "—");
    setText("g-vix-max", vix.month_high != null ? num(vix.month_high, 1) : "—");

    var lbl = $("hv-vix-lbl");
    if (lbl) { lbl.textContent = vix.label_ar || "—"; lbl.style.color = color; }
    // VIX up = more fear (bad) → upIsGood = false
    setPill("hv-vix-chg", vix.change || 0,
      signed(vix.change, 2) + " (" + signed(vix.change_pct, 2) + "%)", false);

    // below-hero month stats + chart
    animNum($("vix-high"), vix.month_high, function (v) { return num(v, 1); });
    animNum($("vix-low"), vix.month_low, function (v) { return num(v, 1); });
    animNum($("vix-prev"), vix.prev_close, function (v) { return num(v, 1); });
    drawSpark(vix, initial);
  }

  var _lastBigScore = null;
  function renderScore(sc, initial) {
    sc = sc || {};
    var color = sc.color || "#ef4d23";
    var score = sc.score;
    var pct = score != null ? Math.max(0, Math.min(1, score / 10)) * 100 : 0;
    animGaugeTick("g-score", score, pct, function (v) { return num(v, 1); }, color, initial ? 760 : 0);
    var lbl = $("hv-score-lbl");
    if (lbl) { lbl.textContent = sc.label_ar || "—"; lbl.style.color = color; }

    var card = $("score-card");
    if (card) card.style.setProperty("--score-color", color);
    var big = $("hv-score-big");
    if (big && score != null) {
      big.textContent = num(score, 1);
      if (!initial && _lastBigScore !== null && _lastBigScore !== score) {
        big.classList.remove("bump"); void big.offsetWidth; big.classList.add("bump");
      }
      _lastBigScore = score;
    }
  }

  // News-sentiment badge next to the score: the index + pos/neg headline split,
  // so the director sees exactly what's driving today's rating.
  function renderNewsPill(ns) {
    var el = $("hv-news-pill");
    if (!el) return;
    if (!ns || ns.index == null) { el.style.display = "none"; return; }
    el.style.display = "inline-flex";
    var idx = ns.index, pos = ns.pos || 0, neg = ns.neg || 0;
    var up = idx > 2, down = idx < -2;
    var color = up ? "#22C97A" : down ? "#E05050" : "#888888";
    var bg = up ? "rgba(34,201,122,.12)" : down ? "rgba(224,80,80,.12)" : "rgba(60,60,60,.35)";
    el.style.color = color; el.style.background = bg; el.style.borderColor = "transparent";
    var sign = idx > 0 ? "+" : "";
    el.title = "مشاعر الأخبار: " + sign + num(idx, 0) + " من ١٠٠ — " +
      pos + " خبر إيجابي مقابل " + neg + " سلبي";
    el.innerHTML = (up ? TREND_UP : down ? TREND_DOWN : "") +
      '<span class="np-idx">' + sign + num(idx, 0) + '</span>' +
      '<span class="np-c np-up">▲' + pos + '</span>' +
      '<span class="np-c np-dn">▼' + neg + '</span>';
  }

  function renderMood(fg, initial) {
    fg = fg || {};
    var color = fg.color || "#9ca3af";
    var val = fg.ok ? fg.value : null;
    var pct = val != null ? Math.max(0, Math.min(100, val)) : 0;
    animGaugeTick("g-mood", val, pct, function (v) { return num(v, 0); }, color, initial ? 880 : 0);
    var lbl = $("hv-mood-lbl");
    if (lbl) { lbl.textContent = fg.ok ? (fg.label_ar || "—") : "غير متوفر"; lbl.style.color = color; }
    // greed rising = risk-on → upIsGood = true
    setPill("hv-mood-chg", fg.ok ? (fg.change || 0) : 0,
      fg.ok ? signed(fg.change, 0) + " نقطة" : "—", true);
  }

  // ---- report renderers -------------------------------------------------
  var _prevPrices = {};
  function renderTickers(quotes) {
    var el = $("tickers");
    if (!el) return;
    el.innerHTML = (quotes || []).map(function (q) {
      if (!q.ok) return '<div class="tick"><div class="t-name">' + esc(q.name) +
        '</div><div class="t-price">—</div></div>';
      var cls = q.up ? "up" : "down", ar = q.up ? "▲" : "▼";
      var prev = _prevPrices[q.name];
      var flash = prev != null && prev !== q.price ? (q.price > prev ? " flash-up" : " flash-down") : "";
      _prevPrices[q.name] = q.price;
      return '<div class="tick t-' + cls + flash + '"><div class="t-name">' + esc(q.name) + '</div>' +
        '<div class="t-price">' + num(q.price, q.price >= 1000 ? 0 : 2) + '</div>' +
        '<div class="t-chg ' + cls + '">' + ar + " " + signed(q.change_pct, 2) + '%</div></div>';
    }).join("");
  }

  // ---- live ticker-tape (marquee) --------------------------------------
  // Builds one row of price chips, then injects TWO copies into the track so
  // the CSS translate(-50%) loop is perfectly seamless.
  function marqueeChip(q) {
    if (!q.ok) {
      return '<span class="mq-item"><span class="mq-name">' + esc(q.name) +
        '</span><span class="mq-price">—</span></span>';
    }
    var cls = q.up ? "up" : "down", ar = q.up ? "▲" : "▼";
    return '<span class="mq-item"><span class="mq-name">' + esc(q.name) + '</span>' +
      '<span class="mq-price">' + num(q.price, q.price >= 1000 ? 0 : 2) + '</span>' +
      '<span class="mq-chg ' + cls + '">' + ar + " " + signed(q.change_pct, 2) + '%</span></span>';
  }
  function renderMarquee(quotes) {
    var el = $("marquee-track");
    if (!el) return;
    var list = (quotes || []).filter(function (q) { return q && q.name; });
    if (!list.length) { el.innerHTML = ""; return; }
    var row = list.map(function (q) {
      return marqueeChip(q) + '<span class="mq-sep" aria-hidden="true"></span>';
    }).join("");
    // duplicate for a seamless -50% loop
    el.innerHTML = row + row;
  }

  // ---- sector rotation bars (best -> worst) ----------------------------
  // Bar width is proportional to |daily %| vs. the strongest mover, so the
  // spread between leaders and laggards is read at a glance.
  function renderSectors(sectors) {
    var el = $("sectors");
    if (!el) return;
    var list = (sectors || []).filter(function (s) { return s && s.ok; });
    if (!list.length) {
      el.innerHTML = '<div class="sec-empty">تعذّر تحميل بيانات القطاعات</div>';
      return;
    }
    var maxAbs = list.reduce(function (m, s) {
      return Math.max(m, Math.abs(s.change_pct || 0));
    }, 0.1);
    el.innerHTML = list.map(function (s, i) {
      var up = (s.change_pct || 0) >= 0;
      var cls = up ? "up" : "down", ar = up ? "▲" : "▼";
      var w = Math.max(4, Math.min(100, Math.abs(s.change_pct || 0) / maxAbs * 100));
      var delay = (0.04 * i).toFixed(2);
      return '<div class="sector">' +
        '<div class="sec-name">' + esc(s.name) + '</div>' +
        '<div class="sec-track"><span class="sec-bar ' + cls + '" ' +
          'style="width:' + w.toFixed(1) + '%;animation-delay:' + delay + 's"></span></div>' +
        '<div class="sec-pct ' + cls + '">' + ar + ' ' + signed(s.change_pct, 2) + '%</div>' +
      '</div>';
    }).join("");
  }

  function sentiCard(name, obj, isStable) {
    if (!obj || !obj.ok) return '<div class="card"><div class="s-name">' + esc(name) +
      '</div><div class="s-val">—</div><div class="s-lbl">غير متوفر</div></div>';
    if (isStable) {
      var rc = obj.rising ? "#12885a" : "#d1443a", rl = obj.rising ? "يرتفع ▲" : "ينخفض ▼";
      return '<div class="card"><div class="s-name">' + esc(name) + '</div>' +
        '<div class="s-val">$' + num(obj.total_b, 1) + 'B</div>' +
        '<div class="s-lbl" style="color:' + rc + '">' + rl + '</div>' +
        '<div class="s-chg">' + signed(obj.change_pct, 2) + '% خلال الأسبوع</div></div>';
    }
    return '<div class="card"><div class="s-name">' + esc(name) + '</div>' +
      '<div class="s-val" style="color:' + obj.color + '">' + obj.value + '</div>' +
      '<div class="s-lbl" style="color:' + obj.color + '">' + esc(obj.label_ar) + '</div>' +
      '<div class="s-chg">التغيّر: ' + signed(obj.change, 1) + '</div></div>';
  }

  function renderSentiment(r) {
    var el = $("senti");
    if (!el) return;
    el.innerHTML =
      sentiCard("مزاج سوق الأسهم", r.fear_greed_stocks, false) +
      sentiCard("مزاج الكريبتو", r.fear_greed_crypto, false) +
      sentiCard("احتياطي العملات المستقرة", r.stablecoins, true);
  }

  function renderDigest(r) {
    var pts = $("points");
    if (pts) pts.innerHTML = (r.points || []).map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("");
    setText("zubda", r.bottom_line || "");
    var w = $("whale");
    if (w) {
      if (r.whale_signal) { w.style.display = "block"; w.textContent = r.whale_signal; }
      else { w.style.display = "none"; }
    }
  }

  // Thin-line SVG icons for the per-item action row (no emoji — cleaner look)
  var _NI = function (paths) {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  };
  var NI_ICONS = {
    pin:      _NI('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
    copy:     _NI('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    chat:     _NI('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
    send:     _NI('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
    bookmark: _NI('<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>'),
    sound:    _NI('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'),
    x:        _NI('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  };

  function newsItem(n) {
    var title = n.title_ar || n.title || "";
    var url   = n.link || "";
    var sc    = sentColor(n.sentiment);
    var tags  = (n.tags || []).slice(0, 3).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("");
    var read  = readNews.has(url) ? " news-read" : "";
    var sv    = parseFloat(n.sentiment || 0);
    var sc2   = sv > 0 ? " s-pos" : sv < 0 ? " s-neg" : " s-neu";
    var isNew = !readNews.has(url) && !_seenUrls.has(url) ? " is-new" : "";
    _seenUrls.add(url);
    var tsMs = n.published_str ? (function() { try { return new Date(n.published_str.replace(" UTC","Z").replace(" ","T")).getTime(); } catch(e) { return 0; } })() : 0;
    var relPct = Math.min(100, Math.round((n.relevance || 0) / 12 * 100));
    var relCls = relPct >= 70 ? 'rel-high' : relPct >= 35 ? 'rel-mid' : 'rel-low';
    var relBadge = '<span class="rel-badge ' + relCls + '" title="نسبة أهمية الخبر للأسواق">' + relPct + '%</span>';
    return '<a class="news-item' + read + sc2 + isNew + '" href="' + esc(url) + '" target="_blank" rel="noopener"' +
      ' data-sent="' + (n.sentiment || 0) + '" data-url="' + esc(url) + '" data-ts="' + tsMs + '">' +
      '<div class="news-title">' + esc(title) + '</div>' +
      '<div class="news-meta">' +
      relBadge +
      '<span class="dot-s" style="background:' + sc + '"></span>' +
      '<span class="src">' + esc(n.source) + '</span>' +
      (n.published_str ? '<span>' + esc(n.published_str) + '</span>' : '') + tags +
      '<span class="ni-actions">' +
      '<button class="ni-pin' + (pinnedUrls.has(url) ? ' pinned' : '') + '" data-pin-url="' + esc(url) + '" title="تثبيت">' + NI_ICONS.pin + '</button>' +
      '<button class="ni-copy" data-copy-title="' + esc(title) + '" data-copy-url="' + esc(url) + '" title="نسخ العنوان">' + NI_ICONS.copy + '</button>' +
      '<button class="ni-wa"   data-wa-title="'   + esc(title) + '" data-wa-url="'   + esc(url) + '" title="مشاركة واتساب">' + NI_ICONS.chat + '</button>' +
      '<button class="ni-tg"   data-tg-title="'   + esc(title) + '" data-tg-url="'   + esc(url) + '" title="مشاركة تليجرام">' + NI_ICONS.send + '</button>' +
      '<button class="ni-rl"   data-rl-url="'    + esc(url)   + '" data-rl-title="'  + esc(title) + '" title="احفظ لاحقاً">' + NI_ICONS.bookmark + '</button>' +
      '<button class="ni-tts" data-tts-text="'  + esc(title) + '" title="قراءة بالصوت">' + NI_ICONS.sound + '</button>' +
      '<button class="ni-hide" title="إخفاء">' + NI_ICONS.x + '</button>' +
      '</span></div></a>';
  }

  function renderNews(r) {
    var g = $("geo-list"), m = $("mk-list");
    if (g) g.innerHTML = (r.geopolitics || []).map(newsItem).join("") || emptyRow();
    if (m) m.innerHTML = (r.markets || []).map(newsItem).join("") || emptyRow();
    setText("news-count", r.news_count != null ? r.news_count : "—");
    if (newsSearchTerm) setTimeout(filterNews, 60);
    setTimeout(function () { applyPins(); applyHighlight(); buildSourceChips(); updateNewsCounts(); applyBreakingBadge(); updateReadCounter(); applyBlacklist(); applyTimeFilter(); applyTagFilter(); updateSentimentDonut(); buildTagFilter(); applyReadLaterBadges(); }, 0);
  }
  function emptyRow() {
    return '<div class="news-item"><div class="news-title" style="color:#9a988f">لا توجد أخبار متاحة حالياً</div></div>';
  }

  // ---- copy / share report -----------------------------------------------
  function scoreEmoji(s) { return s >= 7 ? "🟢" : s >= 5 ? "🟡" : s >= 3 ? "🟠" : "🔴"; }

  function formatReport(r) {
    if (!r) return "";
    var sc = r.score || {}, vix = r.vix || {}, fg = r.fear_greed_stocks || {};
    var sn = sc.score, vn = vix.current;
    var date = (r.generated_at || "").split(" ")[0] || "";
    var lines = [
      "📊 نشرة السوق — " + date,
      "━━━━━━━━━━━━━━━━━━",
      "",
      (sn != null ? scoreEmoji(sn) : "▪") + " التقييم اليومي: " + (sn != null ? sn + "/10" : "—") + " · " + (sc.label_ar || ""),
      "📈 VIX مؤشر الخوف: " + (vn != null ? num(vn, 1) : "—") + " (" + (vix.label_ar || "—") + ")",
      "🎭 مزاج السوق: " + (fg.ok && fg.label_ar ? fg.label_ar : "—"),
      ""
    ];
    if (r.bottom_line) { lines.push("📝 الزبدة:", r.bottom_line, ""); }
    if (r.points && r.points.length) {
      lines.push("📌 أبرز النقاط:");
      r.points.forEach(function (p) { lines.push("• " + p); });
      lines.push("");
    }
    lines.push("━━━━━━━━━━━━━━━━━━", "📢 قناة نشرة السوق:", "https://t.me/+qBtY37bvQow2NWZk");
    return lines.join("\n");
  }

  function setupReportActions() {
    var copyBtn = $("btn-copy-report");
    var waBtn   = $("btn-wa-share");
    var row     = $("report-share-row");

    var tgBtn = $("btn-tg-report");
    function updateShare() {
      var text = formatReport(lastReport);
      if (waBtn && text) waBtn.href = "https://wa.me/?text=" + encodeURIComponent(text);
      if (tgBtn && text) tgBtn.onclick = function() { window.open("https://t.me/share/url?url=" + encodeURIComponent("https://t.me/+qBtY37bvQow2NWZk") + "&text=" + encodeURIComponent(text), "_blank", "noopener"); };
      if (row) row.style.display = "";
    }
    window._updateShare = updateShare;

    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        var text = formatReport(lastReport);
        if (!text) return;
        navigator.clipboard.writeText(text).then(function () {
          var orig = copyBtn.innerHTML;
          copyBtn.classList.add("copied");
          copyBtn.textContent = "تم النسخ!";
          setTimeout(function () { copyBtn.classList.remove("copied"); copyBtn.innerHTML = orig; }, 2200);
          toast("تم نسخ التقرير — الصقه في واتساب أو تيليجرام");
        }).catch(function () {});
      });
    }
  }

  // ---- news search ---------------------------------------------------------
  function filterNews() {
    var items = document.querySelectorAll(".news-item");
    var count = 0;
    items.forEach(function (el) {
      var title = (el.querySelector(".news-title") || {}).textContent || "";
      var match = !newsSearchTerm || title.includes(newsSearchTerm);
      el.style.display = match ? "" : "none";
      if (match) count++;
    });
    var info  = $("news-filter-info");
    var clear = $("news-clear-btn");
    if (info)  info.textContent  = newsSearchTerm ? (count + " نتيجة") : "";
    if (clear) clear.style.display = newsSearchTerm ? "" : "none";
  }

  function setupNewsSearch() {
    var inp   = $("news-search-inp");
    var clear = $("news-clear-btn");
    if (!inp) return;

    inp.addEventListener("input", function () {
      newsSearchTerm = inp.value.trim();
      filterNews();
    });
    if (clear) {
      clear.addEventListener("click", function () {
        inp.value = ""; newsSearchTerm = "";
        filterNews(); inp.focus();
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        inp.focus();
        inp.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "center" });
      }
      if (e.key === "Escape" && document.activeElement === inp) {
        inp.blur(); inp.value = ""; newsSearchTerm = ""; filterNews();
      }
    });
  }

  // ---- mark read + copy/share news (event delegation) ---------------------
  function markRead(url) {
    if (!url) return; readNews.add(url);
    try { localStorage.setItem(READ_NEWS_KEY, JSON.stringify(Array.from(readNews).slice(-300))); } catch (e) {}
  }
  function setupNewsActions() {
    document.addEventListener("click", function (e) {
      var wa = e.target.closest(".ni-wa");
      if (wa) {
        e.preventDefault(); e.stopPropagation();
        window.open("https://wa.me/?text=" + encodeURIComponent(wa.dataset.waTitle + "\n" + wa.dataset.waUrl), "_blank", "noopener");
        return;
      }
      var tg = e.target.closest(".ni-tg");
      if (tg) {
        e.preventDefault(); e.stopPropagation();
        window.open("https://t.me/share/url?url=" + encodeURIComponent(tg.dataset.tgUrl) + "&text=" + encodeURIComponent(tg.dataset.tgTitle), "_blank", "noopener");
        return;
      }
      var cp = e.target.closest(".ni-copy");
      if (cp) {
        e.preventDefault(); e.stopPropagation();
        navigator.clipboard.writeText(cp.dataset.copyTitle + "\n" + cp.dataset.copyUrl)
          .then(function () { toast("تم نسخ الخبر"); }).catch(function () {});
        return;
      }
      var pin = e.target.closest(".ni-pin");
      if (pin) {
        e.preventDefault(); e.stopPropagation();
        var url = pin.dataset.pinUrl;
        var on  = !pinnedUrls.has(url);
        savePin(url, on);
        pin.classList.toggle("pinned", on);
        applyPins();
        toast(on ? "⭐ تم التثبيت" : "تم إلغاء التثبيت");
        return;
      }
      var item = e.target.closest(".news-item");
      if (item && item.dataset.url) { item.classList.add("news-read"); markRead(item.dataset.url); }
    });
  }

  // ---- personal notes -------------------------------------------------------
  function setupNotes() {
    var ta = $("notes-ta"); if (!ta) return;
    var key = "mb-notes-v1";
    try { ta.value = localStorage.getItem(key) || ""; } catch (e) {}
    ta.addEventListener("input", function () {
      try { localStorage.setItem(key, ta.value); } catch (e) {}
    });
  }

  // ---- focus mode -----------------------------------------------------------
  function setupFocusMode() {
    var btn = $("btn-focus"); if (!btn) return;
    var on = false;
    btn.addEventListener("click", function () {
      on = !on;
      document.body.classList.toggle("focus-mode", on);
      btn.classList.toggle("active", on);
      btn.textContent = on ? "✖ إلغاء" : "⚡ تركيز";
      if (on) { var el = $("markets"); if (el) el.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" }); }
    });
  }

  // ---- news sort ------------------------------------------------------------
  var sortDir = 0;
  var origNewsHtml = {};
  function setupNewsSort() {
    var btn = $("btn-news-sort"); if (!btn) return;
    btn.addEventListener("click", function () {
      sortDir = sortDir === 0 ? 1 : sortDir === 1 ? -1 : 0;
      var lbl = { "0": "↕ الترتيب", "1": "↑ إيجابي", "-1": "↓ سلبي" };
      btn.textContent = lbl[sortDir]; btn.classList.toggle("active", sortDir !== 0);
      ["geo-list", "mk-list"].forEach(function (id) {
        var el = $(id); if (!el) return;
        if (sortDir === 0) { if (origNewsHtml[id]) el.innerHTML = origNewsHtml[id]; return; }
        if (!origNewsHtml[id]) origNewsHtml[id] = el.innerHTML;
        var items = Array.from(el.querySelectorAll("a.news-item[data-sent]"));
        items.sort(function (a, b) {
          var sa = parseFloat(a.dataset.sent || 0), sb = parseFloat(b.dataset.sent || 0);
          return sortDir === 1 ? sb - sa : sa - sb;
        });
        items.forEach(function (it) { el.appendChild(it); });
      });
    });
  }

  // ---- compact news ---------------------------------------------------------
  function setupNewsCompact() {
    var btn = $("btn-news-compact"); if (!btn) return;
    var on = false;
    btn.addEventListener("click", function () {
      on = !on;
      document.body.classList.toggle("news-compact", on);
      btn.textContent = on ? "مفصّل" : "مختصر";
      btn.classList.toggle("active", on);
    });
  }

  // ---- pause auto-refresh ---------------------------------------------------
  var PAUSE_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  var PLAY_ICON  = '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  function setupPauseRefresh() {
    var btn = $("fab-pause"); if (!btn) return;
    btn.addEventListener("click", function () {
      refreshPaused = !refreshPaused;
      btn.classList.toggle("paused", refreshPaused);
      btn.innerHTML = refreshPaused ? PLAY_ICON : PAUSE_ICON;
      btn.title = refreshPaused ? "استئناف التحديث التلقائي" : "إيقاف التحديث التلقائي";
      toast(refreshPaused ? "⏸ تم إيقاف التحديث التلقائي" : "▶ تم استئناف التحديث التلقائي");
    });
  }

  // ---- NYSE market timer ----------------------------------------------------
  function setupMarketTimer() {
    var el = $("market-timer"); if (!el) return;
    function update() {
      var now = new Date();
      var utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
      var et = new Date(utcMs + (-4) * 3600000); // EDT approx
      var h = et.getHours(), m = et.getMinutes(), dow = et.getDay();
      if (dow === 0 || dow === 6) {
        el.textContent = "NYSE · مغلق — عطلة نهاية الأسبوع";
        el.className = "market-timer closed"; return;
      }
      var total = h * 60 + m, open = 570, close = 960; // 9:30 & 16:00
      if (total >= open && total < close) {
        var rem = close - total;
        el.textContent = "NYSE مفتوح · يُغلق خلال " + Math.floor(rem / 60) + "س " + (rem % 60) + "د";
        el.className = "market-timer open";
      } else if (total < open) {
        var to = open - total;
        el.textContent = "NYSE مغلق · يُفتح خلال " + Math.floor(to / 60) + "س " + (to % 60) + "د";
        el.className = "market-timer closed";
      } else {
        el.textContent = "NYSE مغلق · يُفتح غداً 9:30ص"; el.className = "market-timer closed";
      }
    }
    update(); setInterval(update, 30000);
  }

  // ---- font size toggle -----------------------------------------------------
  function setupFontSize() {
    var key = "mb-fs-v1", cls = ["fs-sm", "", "fs-lg"], idx = 1;
    try { var s = parseInt(localStorage.getItem(key)); if (!isNaN(s) && s >= 0 && s < cls.length) idx = s; } catch (e) {}
    function apply() {
      cls.forEach(function (c) { if (c) document.body.classList.remove(c); });
      if (cls[idx]) document.body.classList.add(cls[idx]);
      try { localStorage.setItem(key, idx); } catch (e) {}
    }
    apply();
    var plus = $("btn-font-plus"), minus = $("btn-font-minus");
    if (plus)  plus.addEventListener("click",  function () { if (idx < cls.length - 1) { idx++; apply(); } });
    if (minus) minus.addEventListener("click", function () { if (idx > 0) { idx--; apply(); } });
  }

  // ---- visit streak ---------------------------------------------------------
  function setupVisitStreak() {
    var el = $("visit-streak"); if (!el) return;
    var key = "mb-streak-v1";
    var today = new Date().toISOString().split("T")[0];
    var d;
    try { d = JSON.parse(localStorage.getItem(key)); } catch (e) {}
    if (!d) d = { count: 0, streak: 0, last: "" };
    if (d.last !== today) {
      var yest = new Date(Date.now() - 86400000).toISOString().split("T")[0];
      d.count  = (d.count  || 0) + 1;
      d.streak = (d.last === yest) ? (d.streak || 0) + 1 : 1;
      d.last   = today;
      try { localStorage.setItem(key, JSON.stringify(d)); } catch (e) {}
    }
    var fire = d.streak > 1 ? d.streak + " أيام متتالية · " : "";
    el.innerHTML = fire + "زيارة #" + d.count;
  }

  // ---- sticky status bar ----------------------------------------------------
  function setupStickyBar() {
    var bar = $("status-bar"); if (!bar) return;
    var shown = false, tk = false;
    function check() {
      var want = window.scrollY > 480;
      if (want !== shown) {
        shown = want;
        bar.classList.toggle("visible", want);
        document.body.classList.toggle("sb-visible", want);
      }
      tk = false;
    }
    window.addEventListener("scroll", function () {
      if (!tk) { tk = true; requestAnimationFrame(check); }
    }, { passive: true });
    check();
  }

  function updateStickyBar(r) {
    if (r.score) {
      var sbS = $("sb-score");
      if (sbS) { sbS.textContent = r.score.score != null ? r.score.score + "/10" : "—"; sbS.style.color = r.score.color || ""; }
      var yest = getYesterdayScore();
      var delta = $("sb-delta");
      if (delta && r.score.score != null && yest != null) {
        var diff = parseFloat((r.score.score - yest).toFixed(1));
        var absDiff = Math.abs(diff);
        delta.textContent = (diff > 0 ? "▲ +" : diff < 0 ? "▼ −" : "= ") + absDiff + " عن أمس";
        delta.className = "sb-delta " + (diff > 0 ? "up" : diff < 0 ? "dn" : "");
      }
    }
    var sbV = $("sb-vix");
    if (sbV && r.vix) sbV.textContent = r.vix.current != null ? num(r.vix.current, 1) : "—";
    var sbM = $("sb-mood-lbl");
    if (sbM && r.fear_greed_stocks) { sbM.textContent = r.fear_greed_stocks.label_ar || ""; sbM.style.color = r.fear_greed_stocks.color || ""; }
  }

  // ---- pinned news ----------------------------------------------------------
  var PINS_KEY = "mb-pins-v1";
  var pinnedUrls = (function () {
    try { return new Set(JSON.parse(localStorage.getItem(PINS_KEY) || "[]")); } catch (e) { return new Set(); }
  })();
  function savePin(url, on) {
    if (on) pinnedUrls.add(url); else pinnedUrls.delete(url);
    try { localStorage.setItem(PINS_KEY, JSON.stringify(Array.from(pinnedUrls).slice(-50))); } catch (e) {}
  }
  function applyPins() {
    ["geo-list", "mk-list"].forEach(function (id) {
      var el = $(id); if (!el) return;
      var items = Array.from(el.querySelectorAll("a.news-item[data-url]"));
      var pinned = items.filter(function (i) { return pinnedUrls.has(i.dataset.url); });
      var rest   = items.filter(function (i) { return !pinnedUrls.has(i.dataset.url); });
      var bar = el.querySelector(".news-pinned-bar");
      if (pinned.length) {
        if (!bar) { bar = document.createElement("div"); bar.className = "news-pinned-bar"; el.insertBefore(bar, el.firstChild); }
        bar.innerHTML = '<div class="pinned-label">مثبّت</div>';
        pinned.forEach(function (it) { bar.appendChild(it); });
      } else if (bar) { bar.remove(); }
      rest.forEach(function (it) { el.appendChild(it); });
    });
  }

  // ---- keyboard shortcuts panel --------------------------------------------
  function setupShortcuts() {
    var overlay = $("shortcuts-overlay"), closeBtn = $("sc-close-btn");
    function open()  { if (overlay) overlay.classList.add("open"); }
    function close() { if (overlay) overlay.classList.remove("open"); }
    if (closeBtn) closeBtn.addEventListener("click", close);
    if (overlay)  overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function (e) {
      var tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "?") { e.preventDefault(); open(); return; }
      if (e.key === "Escape") { close(); return; }
      if (e.key === "r" || e.key === "R") { e.preventDefault(); poll(); toast("جاري التحديث..."); return; }
      if (e.key === "f" || e.key === "F") { e.preventDefault(); var btn = $("btn-focus"); if (btn) btn.click(); return; }
      var sectionMap = {"1":"markets","2":"full","3":"full","4":"full","5":"senti","6":"news"};
      if (sectionMap[e.key]) {
        e.preventDefault();
        var el = $(sectionMap[e.key]);
        if (el) el.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
      }
    });
  }

  // ---- watchwords highlight ------------------------------------------------
  var watchwords = [];
  function applyHighlight() {
    document.querySelectorAll(".news-item .news-title").forEach(function (el) {
      var orig = el.dataset.orig || el.textContent;
      el.dataset.orig = orig;
      if (!watchwords.length) { el.textContent = orig; return; }
      var html = esc(orig);
      watchwords.forEach(function (w) {
        if (!w) return;
        var re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        html = html.replace(re, '<mark class="hw">$&</mark>');
      });
      el.innerHTML = html;
    });
  }
  function setupWatchwords() {
    var inp = $("watch-inp"); if (!inp) return;
    var key = "mb-watch-v1";
    try { inp.value = localStorage.getItem(key) || ""; } catch (e) {}
    function update() {
      watchwords = inp.value.split(/[,،\s]+/).map(function (w) { return w.trim(); }).filter(Boolean);
      try { localStorage.setItem(key, inp.value); } catch (e) {}
      applyHighlight();
    }
    update();
    inp.addEventListener("input", update);
  }

  // ---- source filter chips -------------------------------------------------
  var activeSources = new Set();
  function buildSourceChips() {
    var container = $("src-chips"); if (!container) return;
    var sources = new Set();
    document.querySelectorAll(".news-item .src").forEach(function (el) { var s = el.textContent.trim(); if (s) sources.add(s); });
    if (!sources.size) { container.style.display = "none"; return; }
    container.style.display = "";
    var html = '<span class="src-chip' + (!activeSources.size ? " active" : "") + '" data-src="__all__">الكل</span>';
    sources.forEach(function (s) { html += '<span class="src-chip' + (activeSources.has(s) ? " active" : "") + '" data-src="' + esc(s) + '">' + esc(s) + '</span>'; });
    container.innerHTML = html;
    container.querySelectorAll(".src-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var src = chip.dataset.src;
        if (src === "__all__") {
          activeSources.clear();
          container.querySelectorAll(".src-chip").forEach(function (c) { c.classList.remove("active"); });
        } else {
          container.querySelector('[data-src="__all__"]').classList.remove("active");
          chip.classList.toggle("active");
          if (chip.classList.contains("active")) activeSources.add(src); else activeSources.delete(src);
          if (!activeSources.size) container.querySelector('[data-src="__all__"]').classList.add("active");
        }
        document.querySelectorAll(".news-item").forEach(function (el) {
          if (!activeSources.size) { el.style.display = ""; return; }
          var s = (el.querySelector(".src") || {}).textContent || "";
          el.style.display = activeSources.has(s.trim()) ? "" : "none";
        });
      });
    });
  }

  // ---- risk slider ---------------------------------------------------------
  function setupRiskSlider() {
    var sl = $("risk-slider"), val = $("risk-val"); if (!sl) return;
    var key = "mb-risk-v1";
    var label = function (v) { return v < 25 ? "منخفض جداً" : v < 45 ? "منخفض" : v < 55 ? "متوسط" : v < 75 ? "عالٍ" : "عالٍ جداً"; };
    try { sl.value = localStorage.getItem(key) || 50; } catch (e) {}
    function update() { if (val) val.textContent = label(sl.value); try { localStorage.setItem(key, sl.value); } catch (e) {} }
    update(); sl.addEventListener("input", update);
  }

  // ---- export notes + clear read ------------------------------------------
  function setupNotesActions() {
    var expBtn = $("btn-export-notes");
    if (expBtn) expBtn.addEventListener("click", function () {
      var text = ($("notes-ta") || {}).value || "";
      if (!text.trim()) { toast("لا توجد ملاحظات للتصدير"); return; }
      var a = document.createElement("a");
      a.href = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
      a.download = "ملاحظاتي_" + new Date().toISOString().split("T")[0] + ".txt";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      toast("تم تصدير الملاحظات");
    });
    var clrBtn = $("btn-clear-read");
    if (clrBtn) clrBtn.addEventListener("click", function () {
      readNews.clear(); try { localStorage.removeItem(READ_NEWS_KEY); } catch (e) {}
      document.querySelectorAll(".news-item.news-read").forEach(function (el) { el.classList.remove("news-read"); });
      toast("تم مسح الأخبار المقروءة");
    });
  }

  // ---- score change alert --------------------------------------------------
  var _lastScore = null;
  function checkScoreChange(r) {
    if (!r || !r.score || r.score.score == null) return;
    var sc = r.score.score;
    if (_lastScore !== null && Math.abs(sc - _lastScore) >= 0.5) {
      var dir = sc > _lastScore ? "↑ ارتفع" : "↓ انخفض";
      toast("التقييم " + dir + " من " + _lastScore + " إلى " + sc + "/10");
    }
    _lastScore = sc;
  }

  // ---- stale data indicator -----------------------------------------------
  function checkStaleData() {
    var el = $("gen-at"); if (!el || !lastGenTs) return;
    el.classList.toggle("stale", (Date.now() / 1000 - lastGenTs) / 60 > 8);
  }

  // ---- world clocks -----------------------------------------------------------
  var BREAKING_WORDS = ["عاجل","يكسر","ينهار","يرتفع بشدة","ينخفض بشدة","يحظر","يمنع","يعلن","طارئ","أزمة","انهيار","حرب","هجوم"];
  function setupWorldClocks() {
    var zones = [
      { id:"wc-dubai",  city:"دبي",     tz:4  },
      { id:"wc-riyadh", city:"الرياض",  tz:3  },
      { id:"wc-london", city:"لندن",    tz:1  },
      { id:"wc-ny",     city:"نيويورك", tz:-4 }
    ];
    function paint() {
      var now = new Date();
      zones.forEach(function (z) {
        var el = document.getElementById(z.id); if (!el) return;
        var utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
        var local = new Date(utcMs + z.tz * 3600000);
        var h = local.getHours(), m = local.getMinutes();
        var hh = h < 10 ? "0"+h : h, mm = m < 10 ? "0"+m : m;
        var ampm = h < 12 ? "ص" : "م";
        var h12 = h % 12 || 12;
        var t = (h12 < 10 ? "0"+h12 : h12) + ":" + mm + " " + ampm;
        var isOpen = (z.id==="wc-ny") && local.getDay()>0 && local.getDay()<6 && (h*60+m)>=570 && (h*60+m)<960;
        el.textContent = t;
        el.className = "wclock-time" + (isOpen ? " open" : " closed");
      });
    }
    paint(); setInterval(paint, 10000);
  }

  // ---- read counter ----------------------------------------------------------
  function updateReadCounter() {
    var el = $("news-read-counter"); if (!el) return;
    var total = document.querySelectorAll(".news-item[data-url]").length;
    var readCount = document.querySelectorAll(".news-item.news-read").length;
    el.innerHTML = "قرأت <b>" + readCount + "</b>/" + total;
  }

  // ---- breaking news badge ---------------------------------------------------
  function applyBreakingBadge() {
    document.querySelectorAll(".news-item .news-title").forEach(function (el) {
      var txt = (el.dataset.orig || el.textContent || "").toLowerCase();
      var breaking = BREAKING_WORDS.some(function (w) { return txt.includes(w); });
      var item = el.closest(".news-item");
      if (item) item.classList.toggle("is-breaking", breaking);
    });
  }

  // ---- hide news item --------------------------------------------------------
  function setupHideNews() {
    document.addEventListener("click", function (e) {
      var btn = e.target.closest(".ni-hide");
      if (!btn) return;
      e.preventDefault(); e.stopPropagation();
      var item = btn.closest(".news-item");
      if (item) { item.classList.add("ni-hidden"); updateReadCounter(); toast("تم إخفاء الخبر"); }
    });
  }

  // ---- time-based sort option ------------------------------------------------
  // Patches into setupNewsSort to add a "recent" option
  function patchNewsSortTime() {
    var btn = $("btn-news-sort"); if (!btn) return;
    var modes = ["↕ الترتيب", "↑ إيجابي", "↓ سلبي", "الأحدث"];
    var idx = 0;
    btn.addEventListener("click", function () {}, true); // no-op — overridden below
    btn.onclick = function () {
      idx = (idx + 1) % modes.length;
      btn.textContent = modes[idx];
      btn.classList.toggle("active", idx > 0);
      ["geo-list","mk-list"].forEach(function (id) {
        var el = $(id); if (!el) return;
        if (idx === 0) { if (origNewsHtml[id]) el.innerHTML = origNewsHtml[id]; return; }
        if (!origNewsHtml[id]) origNewsHtml[id] = el.innerHTML;
        var items = Array.from(el.querySelectorAll("a.news-item[data-sent]"));
        items.sort(function (a, b) {
          if (idx === 3) {
            var ta = a.querySelector(".news-meta span:nth-child(3)"), tb = b.querySelector(".news-meta span:nth-child(3)");
            return (tb ? tb.textContent : "").localeCompare(ta ? ta.textContent : "");
          }
          var sa = parseFloat(a.dataset.sent||0), sb = parseFloat(b.dataset.sent||0);
          return idx === 1 ? sb-sa : sa-sb;
        });
        items.forEach(function (it) { el.appendChild(it); });
      });
    };
  }

  // ---- export notes + today summary together ---------------------------------
  function setupExportFull() {
    var btn = $("btn-export-full"); if (!btn) return;
    btn.addEventListener("click", function () {
      var notes = ($("notes-ta") || {}).value || "";
      var summary = formatReport(lastReport);
      var text = summary + "\n\n" + "─".repeat(30) + "\n📝 ملاحظاتي:\n\n" + (notes.trim() || "لا توجد ملاحظات");
      var a = document.createElement("a");
      a.href = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
      a.download = "نشرة_السوق_" + new Date().toISOString().split("T")[0] + ".txt";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      toast("تم تصدير النشرة + الملاحظات");
    });
  }

  // ---- refresh countdown bar --------------------------------------------------
  function setupRefreshProg() {
    var bar = $("refresh-prog"); if (!bar) return;
    window._refreshProgUpdate = function () {
      var pct = REFRESH > 0 ? ((REFRESH - Math.max(0, counter)) / REFRESH * 100).toFixed(1) : 0;
      bar.style.width = pct + "%";
    };
  }

  // ---- collapsible news sections ---------------------------------------------
  function setupCollapsible() {
    document.querySelectorAll(".card h2").forEach(function (h2) {
      if (h2.closest("#geo-list") || h2.closest("#mk-list")) return;
      h2.classList.add("news-section-toggle");
      h2.addEventListener("click", function () {
        var card = h2.closest(".card");
        if (card) card.classList.toggle("section-collapsed");
      });
    });
  }

  // ---- sentiment filter -------------------------------------------------------
  function setupSentimentFilter() {
    var container = $("sent-filter"); if (!container) return;
    var activeSent = "all";
    container.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-sent-f]");
      if (!btn) return;
      activeSent = btn.dataset.sentF;
      container.querySelectorAll("[data-sent-f]").forEach(function (b) { b.classList.toggle("active", b === btn); });
      document.querySelectorAll(".news-item[data-sent]").forEach(function (el) {
        if (activeSent === "all") { el.style.display = ""; return; }
        var s = parseFloat(el.dataset.sent || 0);
        var match = activeSent === "pos" ? s > 0 : activeSent === "neg" ? s < 0 : (s === 0 || isNaN(s));
        el.style.display = match ? "" : "none";
      });
    });
  }

  // ---- news counts in section headers -----------------------------------------
  function updateNewsCounts() {
    var g = $("geo-list"), m = $("mk-list");
    var gc = g ? g.querySelectorAll("a.news-item").length : 0;
    var mc = m ? m.querySelectorAll("a.news-item").length : 0;
    setText("geo-count-badge", gc || "");
    setText("mk-count-badge", mc || "");
  }

  // ---- copy all news ----------------------------------------------------------
  function setupCopyAllNews() {
    var btn = $("btn-copy-all-news"); if (!btn) return;
    btn.addEventListener("click", function () {
      var items = Array.from(document.querySelectorAll(".news-item")).filter(function (el) {
        return el.style.display !== "none" && el.href;
      });
      if (!items.length) { toast("لا توجد أخبار"); return; }
      var lines = items.map(function (el, i) {
        var title = (el.querySelector(".news-title") || {}).textContent || "";
        return (i + 1) + ". " + title + "\n   " + (el.href || "");
      });
      var text = "📰 أخبار اليوم — نشرة السوق:\n\n" + lines.join("\n\n") +
        "\n\n📢 https://t.me/+qBtY37bvQow2NWZk";
      navigator.clipboard.writeText(text).then(function () {
        toast("تم نسخ " + items.length + " خبر");
      }).catch(function () { toast("تعذّر النسخ"); });
    });
  }

  // ---- daily browser reminder -------------------------------------------------
  function setupDailyReminder() {
    var btn = $("btn-reminder"); if (!btn) return;
    var KEY = "mb-notif-v1";
    function updateBtn() {
      var on = (function () { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } })();
      btn.classList.toggle("active", on);
      btn.title = on ? "إيقاف تذكير الإشعار" : "تذكير يومي بالنشرة (إشعار)";
      btn.innerHTML = on
        ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg> إيقاف التذكير'
        : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg> تذكير يومي';
    }
    updateBtn();
    btn.addEventListener("click", function () {
      if (!("Notification" in window)) { toast("المتصفح لا يدعم الإشعارات"); return; }
      Notification.requestPermission().then(function (perm) {
        if (perm === "granted") {
          var on = !((function () { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } })());
          try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) {}
          updateBtn();
          if (on) {
            new Notification("نشرة السوق", { body: "تم تفعيل التذكير اليومي بالنشرة", icon: "" });
            toast("تم تفعيل التذكير اليومي");
          } else { toast("تم إيقاف التذكير"); }
        } else { toast("لم يُمنح إذن الإشعارات"); }
      });
    });
  }

  // ---- tab title with score emoji -------------------------------------------
  function updateTabTitle(r) {
    if (!r || !r.score) return;
    var s = r.score.score;
    var em = s >= 7 ? "🟢" : s >= 5 ? "🟡" : s >= 3 ? "🟠" : "🔴";
    document.title = em + " نشرة السوق · " + (s != null ? s + "/10" : "—");
  }

  // ---- "last updated" in the viewer's own local time + live relative age
  var lastGenTs = 0;
  function _2(n) { return n < 10 ? "0" + n : "" + n; }
  function localHM(ts) { var d = new Date(ts * 1000); return _2(d.getHours()) + ":" + _2(d.getMinutes()); }
  function agoAr(ts) {
    var s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 5) return "محدَّث الآن";
    if (s < 60) return "منذ " + s + " ثانية";
    var m = Math.floor(s / 60);
    if (m === 1) return "منذ دقيقة";
    if (m === 2) return "منذ دقيقتين";
    if (m < 60) return "منذ " + m + (m <= 10 ? " دقائق" : " دقيقة");
    var h = Math.floor(m / 60);
    if (h === 1) return "منذ ساعة";
    if (h === 2) return "منذ ساعتين";
    return "منذ " + h + (h <= 10 ? " ساعات" : " ساعة");
  }
  function renderUpdated() {
    if (lastGenTs) setText("gen-at", localHM(lastGenTs) + " بتوقيتك · " + agoAr(lastGenTs));
  }

  function renderReport(r, initial) {
    if (!r) return;
    lastReport = r;
    renderVix(r.vix, initial);
    renderScore(r.score, initial);
    renderNewsPill(r.news_sentiment);
    renderMood(r.fear_greed_stocks, initial);
    renderTickers(r.quotes);
    renderMarquee(r.quotes);
    renderSectors(r.sectors);
    renderSentiment(r);
    renderDigest(r);
    renderNews(r);
    lastGenTs = r.generated_ts || 0;
    if (lastGenTs) renderUpdated(); else setText("gen-at", r.generated_at || "");
    if (window._updateShare) window._updateShare();
    updateTabTitle(r);
    updateStickyBar(r);
    checkScoreChange(r);
    checkStaleData();
    if (r.score && r.score.score != null) saveDailyScore(r.score.score);
    checkVixAlert(r);
    checkBtcAlert(r);
    updateCompositeRisk(r);
    updateMacroDashboard();
    buildWeeklySummary();
    if (window._portfolioRefresh) window._portfolioRefresh();
    origNewsHtml = {};   // reset sort cache on each refresh
  }

  // ---- reveal on scroll -------------------------------------------------
  function setupReveal() {
    var els = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window) || REDUCED) {
      els.forEach(function (e) { e.classList.add("in"); }); return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    els.forEach(function (e) { io.observe(e); });
    if (document.hidden) els.forEach(function (e) { e.classList.add("in"); });
  }

  // ---- live refresh + feedback -----------------------------------------
  var counter = REFRESH, busy = false;
  function tick() {
    if (refreshPaused) { setText("sb-cd", "⏸"); return; }
    counter -= 1;
    var cd = Math.max(0, counter);
    setText("countdown", cd);
    setText("sb-cd", cd);
    renderUpdated();
    if (window._refreshProgUpdate) window._refreshProgUpdate();
    if (counter <= 0) { counter = REFRESH; poll(); }
  }
  function loadbar(state) {
    var b = $("loadbar"); if (!b) return;
    if (state === "go") { b.classList.remove("done"); b.classList.add("go"); }
    else { b.classList.remove("go"); b.classList.add("done"); setTimeout(function () { b.classList.remove("done"); }, 700); }
  }
  function toast(txt) {
    var t = $("toast"); if (!t) return;
    t.innerHTML = txt; t.classList.add("show");
    clearTimeout(t._t); t._t = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }
  function poll() {
    if (busy) return; busy = true; loadbar("go");
    fetch("/api/report", { headers: { "Accept": "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data) { renderReport(data, false); toast('<span class="g">●</span> تم تحديث البيانات لحظياً'); }
      })
      .catch(function () {})
      .then(function () { busy = false; loadbar("done"); });
  }

  // Pause one-shot decorative animations while the tab is hidden (keeps a
  // background tab idle; the native video handles its own pause).
  function syncStill() { document.body.classList.toggle("still", document.hidden); }

  // ---- mobile menu ------------------------------------------------------
  function setupMenu() {
    var hamb = $("hamb"), menu = $("nav-menu");
    if (!hamb || !menu) return;
    hamb.addEventListener("click", function () { menu.classList.toggle("open"); });
    menu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () { menu.classList.remove("open"); });
    });
  }

  // ---- back-to-top ------------------------------------------------------
  function setupTop() {
    var btn = $("totop");
    if (!btn) return;
    var shown = false, ticking = false;
    function update() {
      var want = window.pageYOffset > 620;
      if (want !== shown) { shown = want; btn.classList.toggle("show", want); }
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    btn.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" });
    });
    update();
  }

  // ---- live hero clock (viewer's local time, Arabic) --------------------
  function startClock() {
    var t = $("hc-time"), d = $("hc-date");
    if (!t && !d) return;
    var timeFmt, dateFmt;
    try {
      timeFmt = new Intl.DateTimeFormat("ar", {
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
      });
      dateFmt = new Intl.DateTimeFormat("ar", {
        weekday: "long", day: "numeric", month: "long"
      });
    } catch (e) { timeFmt = dateFmt = null; }
    function paint() {
      var now = new Date();
      if (t) t.textContent = timeFmt ? timeFmt.format(now)
        : _2(now.getHours()) + ":" + _2(now.getMinutes()) + ":" + _2(now.getSeconds());
      if (d) d.textContent = dateFmt ? dateFmt.format(now) : now.toLocaleDateString();
    }
    paint();
    setInterval(paint, 1000);
  }

  // ---- dark mode toggle ------------------------------------------------
  var MOON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  var SUN_SVG  = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  var DARK_KEY = "mb-dark";

  function applyTheme(dark) {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    var btn = $("fab-dark");
    if (btn) btn.innerHTML = dark ? SUN_SVG : MOON_SVG;
    try { localStorage.setItem(DARK_KEY, dark ? "1" : "0"); } catch (e) {}
  }

  function setupDark() {
    var btn = $("fab-dark"); if (!btn) return;
    var saved;
    try { saved = localStorage.getItem(DARK_KEY); } catch (e) {}
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(saved !== "0");  /* default to dark (black) unless explicitly set light */
    btn.addEventListener("click", function () {
      applyTheme(document.documentElement.getAttribute("data-theme") !== "dark");
    });
  }

  // ---- print buttons (FABs) --------------------------------------------
  // News-only print: tag <body>, so @media print isolates the news section,
  // then untag once the print dialog closes (afterprint).
  function printNewsOnly() {
    document.body.classList.add("print-news");
    var cleanup = function () {
      document.body.classList.remove("print-news");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  }
  function setupPrint() {
    var b = $("fab-print");
    if (b) b.addEventListener("click", function () { window.print(); });
    var n = $("fab-news");
    if (n) n.addEventListener("click", printNewsOnly);
    var navn = $("nav-print-news");
    if (navn) navn.addEventListener("click", function (e) { e.preventDefault(); printNewsOnly(); });
  }

  // ---- Read Later ---------------------------------------------------------
  var RL_KEY = "mb-readlater-v1";
  function getRlItems() { try { return JSON.parse(localStorage.getItem(RL_KEY) || "[]"); } catch(e) { return []; } }
  function saveRlItems(arr) { try { localStorage.setItem(RL_KEY, JSON.stringify(arr)); } catch(e) {} }
  function toggleReadLater(url, title) {
    var items = getRlItems();
    var idx = items.findIndex(function(i) { return i.url === url; });
    if (idx >= 0) { items.splice(idx, 1); saveRlItems(items); return false; }
    items.unshift({ url: url, title: title, saved: new Date().toISOString().split("T")[0] });
    if (items.length > 100) items.pop();
    saveRlItems(items); return true;
  }
  function isInReadLater(url) { return getRlItems().some(function(i) { return i.url === url; }); }
  function applyReadLaterBadges() {
    document.querySelectorAll(".ni-rl[data-rl-url]").forEach(function(btn) {
      btn.classList.toggle("saved", isInReadLater(btn.dataset.rlUrl));
      btn.title = isInReadLater(btn.dataset.rlUrl) ? "محفوظ في اقرأ لاحقاً" : "احفظ لاحقاً";
    });
    var cnt = $("rl-count"); if (cnt) { var n = getRlItems().length; cnt.textContent = n || ""; }
  }
  function setupReadLater() {
    document.addEventListener("click", function(e) {
      var btn = e.target.closest(".ni-rl"); if (!btn) return;
      e.preventDefault(); e.stopPropagation();
      var added = toggleReadLater(btn.dataset.rlUrl, btn.dataset.rlTitle);
      applyReadLaterBadges();
      toast(added ? "حُفظ في قائمة القراءة" : "حُذف من قائمة القراءة");
    });
    var openBtn = $("btn-open-readlater"), overlay = $("readlater-overlay"), closeBtn = $("rl-close-btn");
    function openOverlay() {
      var items = getRlItems(); var list = $("rl-list"); if (!list) return;
      if (!items.length) { list.innerHTML = '<p class="rl-empty">لا توجد مقالات محفوظة بعد — اضغط زر الحفظ على أي خبر.</p>'; }
      else {
        list.innerHTML = items.map(function(it, idx) {
          return '<div class="rl-item"><div class="rl-item-title"><a href="' + esc(it.url) + '" target="_blank" rel="noopener">' + esc(it.title) + '</a><br><span style="font-size:10px;color:var(--ink-3)">' + (it.saved||"") + '</span></div><button class="rl-item-del" data-rl-idx="' + idx + '" title="حذف">✕</button></div>';
        }).join("");
        list.querySelectorAll(".rl-item-del").forEach(function(del) {
          del.addEventListener("click", function() {
            var arr = getRlItems(); arr.splice(parseInt(del.dataset.rlIdx,10),1); saveRlItems(arr);
            applyReadLaterBadges(); openOverlay();
          });
        });
      }
      var cnt = list.closest(".readlater-panel") && list.closest(".readlater-panel").querySelector(".readlater-count");
      if (cnt) cnt.textContent = items.length ? "(" + items.length + ")" : "";
      if (overlay) overlay.classList.add("open");
    }
    if (openBtn) openBtn.addEventListener("click", openOverlay);
    if (closeBtn) closeBtn.addEventListener("click", function() { if (overlay) overlay.classList.remove("open"); });
    if (overlay) overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.classList.remove("open"); });
    applyReadLaterBadges();
  }

  // ---- Text-to-Speech (TTS) -----------------------------------------------
  var _ttsActive = null; // currently speaking button
  function setupTts() {
    if (!window.speechSynthesis) return;
    document.addEventListener("click", function(e) {
      var btn = e.target.closest(".ni-tts"); if (!btn) return;
      e.preventDefault(); e.stopPropagation();
      if (_ttsActive) {
        window.speechSynthesis.cancel();
        if (_ttsActive !== btn) {
          _ttsActive.classList.remove("speaking");
          _ttsActive = null;
          speak(btn);
        } else {
          _ttsActive.classList.remove("speaking"); _ttsActive = null;
        }
        return;
      }
      speak(btn);
    });
    function speak(btn) {
      var text = btn.dataset.ttsText || ""; if (!text) return;
      var utt = new SpeechSynthesisUtterance(text); utt.lang = "ar-SA"; utt.rate = 0.95;
      utt.onend = function() { if (_ttsActive) _ttsActive.classList.remove("speaking"); _ttsActive = null; };
      window.speechSynthesis.speak(utt);
      _ttsActive = btn; btn.classList.add("speaking");
    }
  }

  // ---- Tag Filter ---------------------------------------------------------
  var _activeTags = new Set();
  function buildTagFilter() {
    var container = $("tag-filter"); if (!container) return;
    var tagCounts = {};
    document.querySelectorAll(".news-item .tag").forEach(function(el) {
      var t = el.textContent.trim(); if (t) tagCounts[t] = (tagCounts[t] || 0) + 1;
    });
    var tags = Object.keys(tagCounts).sort(function(a,b) { return tagCounts[b] - tagCounts[a]; }).slice(0, 20);
    if (!tags.length) { container.style.display = "none"; return; }
    container.style.display = "";
    var html = tags.map(function(t) {
      return '<button class="tag-chip' + (_activeTags.has(t) ? " active" : "") + '" data-tag="' + esc(t) + '">' + esc(t) + ' <span style="opacity:.5;font-size:9px">' + tagCounts[t] + '</span></button>';
    }).join("") + '<button class="tag-filter-toggle" id="tag-filter-toggle">▼ المزيد</button>';
    container.innerHTML = html;
    container.querySelectorAll(".tag-chip").forEach(function(chip) {
      chip.addEventListener("click", function() {
        var t = chip.dataset.tag;
        if (_activeTags.has(t)) _activeTags.delete(t); else _activeTags.add(t);
        chip.classList.toggle("active", _activeTags.has(t));
        applyTagFilter();
      });
    });
    var tog = $("tag-filter-toggle");
    if (tog) tog.addEventListener("click", function() {
      container.classList.toggle("expanded");
      tog.textContent = container.classList.contains("expanded") ? "▲ أقل" : "▼ المزيد";
    });
  }
  function applyTagFilter() {
    if (!_activeTags.size) { document.querySelectorAll(".news-item").forEach(function(el) { el.classList.remove("tag-hidden"); }); updateReadCounter(); return; }
    document.querySelectorAll(".news-item[data-url]").forEach(function(el) {
      var tags = Array.from(el.querySelectorAll(".tag")).map(function(t) { return t.textContent.trim(); });
      el.classList.toggle("tag-hidden", !Array.from(_activeTags).some(function(t) { return tags.includes(t); }));
    });
    updateReadCounter();
  }

  // ---- Weekly Summary from localStorage -----------------------------------
  function buildWeeklySummary() {
    var wrap = $("weekly-summary"); if (!wrap) return;
    var hist; try { hist = JSON.parse(localStorage.getItem(SCORE_HIST_KEY) || "{}"); } catch(e) { hist = {}; }
    var keys = Object.keys(hist).sort().slice(-7);
    if (keys.length < 2) { wrap.style.display = "none"; return; }
    wrap.style.display = "";
    var scores = keys.map(function(k) { return parseFloat(hist[k]); });
    var avg = (scores.reduce(function(a,b){return a+b;},0) / scores.length).toFixed(1);
    var best = Math.max.apply(null, scores); var worst = Math.min.apply(null, scores);
    var trend = scores[scores.length-1] - scores[0];
    var trendColor = trend > 0 ? "#22C97A" : trend < 0 ? "#E05050" : "#7A7268";
    var trendTxt = trend > 0 ? "▲ تحسّن" : trend < 0 ? "▼ تراجع" : "= مستقر";
    var avgColor = avg >= 7 ? "#22C97A" : avg >= 4 ? "#F0BE46" : "#E05050";
    $("ws-avg") && ($("ws-avg").textContent = avg, $("ws-avg").style.color = avgColor);
    $("ws-best") && ($("ws-best").textContent = best, $("ws-best").style.color = "#22C97A");
    $("ws-worst") && ($("ws-worst").textContent = worst, $("ws-worst").style.color = "#E05050");
    $("ws-trend") && ($("ws-trend").textContent = trendTxt, $("ws-trend").style.color = trendColor);
    $("ws-days") && ($("ws-days").textContent = keys.length + " أيام");
  }

  // ---- Countdown Timer ----------------------------------------------------
  var _cdInterval = null, _cdRemaining = 0;
  function setupCountdownTimer() {
    var inp = $("cd-inp"), btn = $("cd-btn"), disp = $("cd-display"); if (!inp || !btn) return;
    function tick() {
      _cdRemaining--;
      if (disp) {
        var m = Math.floor(_cdRemaining/60), s = _cdRemaining%60;
        disp.textContent = (m<10?"0"+m:m)+":"+(s<10?"0"+s:s);
        disp.classList.toggle("urgent", _cdRemaining <= 10);
      }
      if (_cdRemaining <= 0) {
        clearInterval(_cdInterval); _cdInterval = null;
        btn.textContent = "ابدأ"; btn.classList.remove("running");
        toast("انتهى المؤقت!"); beep();
      }
    }
    function beep() {
      try {
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = ctx.createOscillator(); var gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = 880; gain.gain.setValueAtTime(.4, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .6);
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + .6);
      } catch(e) {}
    }
    btn.addEventListener("click", function() {
      if (_cdInterval) {
        clearInterval(_cdInterval); _cdInterval = null;
        btn.textContent = "ابدأ"; btn.classList.remove("running");
        if (disp) disp.classList.remove("urgent");
        return;
      }
      var mins = parseInt(inp.value, 10) || 5;
      _cdRemaining = mins * 60;
      var m = Math.floor(_cdRemaining/60), s = _cdRemaining%60;
      if (disp) disp.textContent = (m<10?"0"+m:m)+":"+(s<10?"0"+s:s);
      _cdInterval = setInterval(tick, 1000);
      btn.textContent = "إيقاف"; btn.classList.add("running");
      toast("بدأ المؤقت — " + mins + " دقيقة");
    });
  }

  // ---- Floating Sticky Note -----------------------------------------------
  var FLOATNOTE_KEY = "mb-floatnote-v1";
  function setupFloatingNote() {
    var fab = $("floatnote-fab"), panel = $("floatnote-panel"), ta = $("floatnote-ta"), saved = $("floatnote-saved");
    if (!fab || !panel || !ta) return;
    try { ta.value = localStorage.getItem(FLOATNOTE_KEY) || ""; } catch(e) {}
    fab.addEventListener("click", function() { panel.classList.toggle("open"); if (panel.classList.contains("open")) ta.focus(); });
    ta.addEventListener("input", function() {
      try { localStorage.setItem(FLOATNOTE_KEY, ta.value); } catch(e) {}
      if (saved) { saved.textContent = "✓ محفوظ"; setTimeout(function() { if (saved) saved.textContent = ""; }, 1500); }
    });
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape" && panel.classList.contains("open")) panel.classList.remove("open");
    });
  }

  // ---- Macro Dashboard Card -----------------------------------------------
  var MACRO_SYMS = [
    { sym:"BTC",  label:"بيتكوين", match:["BTC"] },
    { sym:"ETH",  label:"إيثيريوم", match:["ETH"] },
    { sym:"GC",   label:"ذهب", match:["GC=F","GC"] },
    { sym:"OIL",  label:"نفط WTI", match:["CL=F","WTI","OIL"] },
    { sym:"SPX",  label:"S&P 500", match:["^GSPC","SPX","SPY","S&P"] },
    { sym:"DXY",  label:"الدولار DXY", match:["DX=F","DXY","USD"] }
  ];
  function updateMacroDashboard() {
    if (!lastReport || !lastReport.quotes) return;
    MACRO_SYMS.forEach(function(def) {
      var q = null;
      for (var i = 0; i < lastReport.quotes.length && !q; i++) {
        var r = lastReport.quotes[i]; if (!r || !r.symbol) continue;
        var sym = r.symbol.toUpperCase();
        if (def.match.some(function(m) { return sym.includes(m.toUpperCase()); })) q = r;
      }
      var valEl = $("macro-val-" + def.sym.toLowerCase()), chgEl = $("macro-chg-" + def.sym.toLowerCase());
      if (!q || !valEl) return;
      var price = parseFloat(q.price);
      valEl.textContent = price >= 1000 ? num(price, 0) : num(price, 2);
      if (chgEl) {
        var chg = parseFloat(q.change_pct || 0);
        chgEl.textContent = (chg >= 0 ? "▲ +" : "▼ ") + Math.abs(chg).toFixed(2) + "%";
        chgEl.style.color = chg >= 0 ? "#22C97A" : "#E05050";
      }
    });
  }

  // ---- BTC price alert ----------------------------------------------------
  var BTC_ALERT_KEY = "mb-btcalert-v1";
  var _btcAlertVal = null, _btcAlertDir = "above";
  function setupBtcAlert() {
    var inp = $("btc-alert-inp"), sel = $("btc-alert-sel"), btn = $("btc-alert-set"), status = $("btc-alert-status");
    if (!inp) return;
    try { var sv = JSON.parse(localStorage.getItem(BTC_ALERT_KEY) || "null"); if (sv) { _btcAlertVal = sv.val; _btcAlertDir = sv.dir || "above"; inp.value = sv.val; if (sel) sel.value = sv.dir || "above"; } } catch(e) {}
    function updateStatus() {
      if (!status) return;
      status.textContent = _btcAlertVal != null ? ("BTC " + (_btcAlertDir === "above" ? ">" : "<") + " $" + num(_btcAlertVal, 0)) : "";
    }
    if (btn) btn.addEventListener("click", function() {
      var v = parseFloat(inp.value); var d = sel ? sel.value : "above";
      if (isNaN(v) || v <= 0) { _btcAlertVal = null; try { localStorage.removeItem(BTC_ALERT_KEY); } catch(e) {} toast("تم إلغاء تنبيه BTC"); }
      else { _btcAlertVal = v; _btcAlertDir = d; try { localStorage.setItem(BTC_ALERT_KEY, JSON.stringify({val:v,dir:d})); } catch(e) {} toast("سيتم تنبيهك عندما BTC " + (d==="above"?"يتجاوز":"ينخفض دون") + " $" + num(v,0)); }
      updateStatus();
    });
    updateStatus();
  }
  var _btcAlertFired = false;
  function checkBtcAlert(r) {
    if (_btcAlertVal == null || !r || !r.quotes) return;
    var btcQ = null;
    for (var i = 0; i < r.quotes.length; i++) { var q = r.quotes[i]; if (q && q.symbol && q.symbol.toUpperCase().replace("-USD","") === "BTC" && q.price) { btcQ = parseFloat(q.price); break; } }
    if (btcQ == null) return;
    var triggered = _btcAlertDir === "above" ? btcQ > _btcAlertVal : btcQ < _btcAlertVal;
    if (triggered && !_btcAlertFired) { _btcAlertFired = true; toast("BTC وصل إلى $" + num(btcQ, 0) + " — " + (_btcAlertDir === "above" ? "تجاوز" : "انخفض دون") + " $" + num(_btcAlertVal, 0)); }
    if (!triggered) _btcAlertFired = false;
  }

  // ---- News time filter ---------------------------------------------------
  var _timeFilter = 0; // 0=all, ms otherwise
  function setupTimeFilter() {
    var container = $("time-filter"); if (!container) return;
    container.addEventListener("click", function(e) {
      var btn = e.target.closest(".tf-chip"); if (!btn) return;
      container.querySelectorAll(".tf-chip").forEach(function(c) { c.classList.remove("active"); });
      btn.classList.add("active");
      var h = parseInt(btn.dataset.tf, 10);
      _timeFilter = h > 0 ? h * 3600000 : 0;
      applyTimeFilter();
    });
  }
  function applyTimeFilter() {
    var now = Date.now();
    document.querySelectorAll(".news-item[data-ts]").forEach(function(el) {
      if (!_timeFilter) { el.classList.remove("tf-hidden"); return; }
      var ts = parseInt(el.dataset.ts, 10);
      el.classList.toggle("tf-hidden", !ts || (now - ts) > _timeFilter);
    });
    updateReadCounter();
  }

  // ---- Composite risk meter -----------------------------------------------
  function updateCompositeRisk(r) {
    var fill = $("composite-fill"), score = $("composite-score"), lbl = $("composite-lbl");
    if (!fill || !r) return;
    var vixRisk   = r.vix && r.vix.current != null ? Math.min(100, (r.vix.current / 40) * 100) : 50;
    var scoreRisk = r.score && r.score.score != null ? Math.max(0, (1 - r.score.score / 10) * 100) : 50;
    var sentRisk  = 50;
    if (r.fear_greed_stocks && r.fear_greed_stocks.value != null) sentRisk = Math.max(0, 100 - r.fear_greed_stocks.value);
    var composite = Math.round(vixRisk * 0.35 + scoreRisk * 0.40 + sentRisk * 0.25);
    var color = composite >= 70 ? "#E05050" : composite >= 40 ? "#F0BE46" : "#22C97A";
    fill.style.width = composite + "%";
    fill.style.background = color;
    if (score) { score.textContent = composite + "%"; score.style.color = color; }
    if (lbl) lbl.textContent = composite >= 70 ? "مرتفع" : composite >= 40 ? "متوسط" : "منخفض ✓";
  }

  // ---- Auto dark mode by time ---------------------------------------------
  var AUTO_DARK_KEY = "mb-autodark-v1";
  function setupAutoDark() {
    var inp = $("auto-dark-inp"); if (!inp) return;
    try { var saved = localStorage.getItem(AUTO_DARK_KEY); if (saved) inp.value = saved; } catch(e) {}
    inp.addEventListener("change", function() {
      try { localStorage.setItem(AUTO_DARK_KEY, inp.value); } catch(e) {}
      checkAutoDark();
    });
    checkAutoDark();
  }
  function checkAutoDark() {
    var inp = $("auto-dark-inp"); if (!inp || !inp.value) return;
    var saved; try { saved = localStorage.getItem("mb-dark"); } catch(e) {}
    if (saved !== null && saved !== undefined) return; // user manually set theme
    var now = new Date(); var h = now.getHours(), m = now.getMinutes();
    var cur = h * 60 + m;
    var parts = inp.value.split(":"); if (parts.length < 2) return;
    var thresh = parseInt(parts[0],10) * 60 + parseInt(parts[1],10);
    applyTheme(cur >= thresh || cur < 360); // dark after set time, light 6am-threshold
  }

  // ---- Daily snapshot (save/restore today's report) -----------------------
  var SNAP_KEY = "mb-snaps-v1";
  function saveSnapshot() {
    if (!lastReport) { toast("لا يوجد تقرير بعد"); return; }
    var today = new Date().toISOString().split("T")[0];
    var snaps; try { snaps = JSON.parse(localStorage.getItem(SNAP_KEY) || "[]"); } catch(e) { snaps = []; }
    snaps = snaps.filter(function(s) { return s.date !== today; }); // replace today's
    snaps.unshift({ date: today, score: lastReport.score ? lastReport.score.score : null, vix: lastReport.vix ? lastReport.vix.current : null, summary: lastReport.bottom_line || "" });
    while (snaps.length > 30) snaps.pop();
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(snaps)); } catch(e) {}
    updateSnapshotCount();
    toast("تم حفظ لقطة اليوم (" + today + ")");
  }
  function updateSnapshotCount() {
    var el = $("snapshot-count"); if (!el) return;
    var snaps; try { snaps = JSON.parse(localStorage.getItem(SNAP_KEY) || "[]"); } catch(e) { snaps = []; }
    el.textContent = snaps.length ? snaps.length + " لقطة محفوظة" : "";
  }
  function setupSnapshot() {
    var saveBtn = $("btn-save-snapshot"), viewBtn = $("btn-view-snapshots");
    var overlay = $("snapshot-overlay"), closeBtn = $("snapshot-close");
    if (saveBtn) saveBtn.addEventListener("click", saveSnapshot);
    function openOverlay() {
      var snaps; try { snaps = JSON.parse(localStorage.getItem(SNAP_KEY) || "[]"); } catch(e) { snaps = []; }
      var list = $("snapshot-list"); if (!list) return;
      if (!snaps.length) { list.innerHTML = '<p style="color:var(--ink-3);font-size:13px">لا توجد لقطات محفوظة بعد.</p>'; }
      else {
        list.innerHTML = snaps.map(function(s) {
          var sc = s.score != null ? s.score + "/10" : "—";
          var color = s.score >= 7 ? "#22C97A" : s.score >= 4 ? "#F0BE46" : "#E05050";
          return '<div class="snapshot-item"><span class="snapshot-item-date">' + s.date + '</span><span class="snapshot-item-score" style="color:' + color + '">' + sc + '</span></div>';
        }).join("");
      }
      if (overlay) overlay.classList.add("open");
    }
    if (viewBtn) viewBtn.addEventListener("click", openOverlay);
    if (closeBtn) closeBtn.addEventListener("click", function() { if (overlay) overlay.classList.remove("open"); });
    if (overlay) overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.classList.remove("open"); });
    updateSnapshotCount();
  }

  // ---- Session timer -------------------------------------------------------
  var _sessionStart = Date.now();
  function setupSessionTimer() {
    var el = $("session-timer-val"); if (!el) return;
    function update() {
      var elapsed = Math.floor((Date.now() - _sessionStart) / 1000);
      var m = Math.floor(elapsed / 60), s = elapsed % 60;
      el.textContent = (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
    }
    update(); setInterval(update, 1000);
  }

  // ---- Group news by source -----------------------------------------------
  var _groupedBySource = false;
  function setupGroupBySource() {
    var btn = $("btn-group-src"); if (!btn) return;
    btn.addEventListener("click", function() {
      _groupedBySource = !_groupedBySource;
      btn.classList.toggle("active", _groupedBySource);
      btn.textContent = _groupedBySource ? "بالمصدر ✓" : "بالمصدر";
      ["geo-list","mk-list"].forEach(function(id) {
        var el = $(id); if (!el) return;
        var items = Array.from(el.querySelectorAll("a.news-item[data-url]"));
        el.querySelectorAll(".src-group-hdr").forEach(function(h) { h.remove(); });
        if (!_groupedBySource) return;
        var groups = {};
        items.forEach(function(item) {
          var src = (item.querySelector(".src") || {}).textContent || "أخرى";
          if (!groups[src]) groups[src] = [];
          groups[src].push(item);
        });
        Object.keys(groups).sort().forEach(function(src) {
          var hdr = document.createElement("div"); hdr.className = "src-group-hdr";
          hdr.innerHTML = '<span>' + esc(src) + '</span><span style="font-size:10px">' + groups[src].length + ' خبر</span>';
          el.appendChild(hdr);
          groups[src].forEach(function(item) { el.appendChild(item); });
        });
      });
    });
  }

  // ---- 1. Yesterday score comparison (sticky bar delta) -------------------
  var SCORE_HIST_KEY = "mb-score-hist-v1";
  function saveDailyScore(score) {
    var today = new Date().toISOString().split("T")[0];
    var hist; try { hist = JSON.parse(localStorage.getItem(SCORE_HIST_KEY) || "{}"); } catch(e) { hist = {}; }
    hist[today] = score;
    var keys = Object.keys(hist).sort(); while (keys.length > 30) { delete hist[keys.shift()]; }
    try { localStorage.setItem(SCORE_HIST_KEY, JSON.stringify(hist)); } catch(e) {}
  }
  function getYesterdayScore() {
    var yest = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    try { var h = JSON.parse(localStorage.getItem(SCORE_HIST_KEY) || "{}"); return h[yest] != null ? parseFloat(h[yest]) : null; } catch(e) { return null; }
  }

  // ---- 2. VIX threshold alert ---------------------------------------------
  var VIX_ALERT_KEY = "mb-vixalert-v1";
  var _vixAlertThreshold = null;
  function setupVixAlert() {
    var inp = $("vix-alert-inp"), btn = $("vix-alert-set"), status = $("vix-alert-status");
    if (!inp) return;
    try { var saved = localStorage.getItem(VIX_ALERT_KEY); if (saved) { _vixAlertThreshold = parseFloat(saved); inp.value = saved; } } catch(e) {}
    function updateStatus() {
      if (!status) return;
      if (_vixAlertThreshold != null) { status.textContent = "تنبيه عند VIX > " + _vixAlertThreshold; if (btn) btn.classList.add("active"); }
      else { status.textContent = ""; if (btn) btn.classList.remove("active"); }
    }
    if (btn) btn.addEventListener("click", function() {
      var v = parseFloat(inp.value);
      if (isNaN(v) || v <= 0) { _vixAlertThreshold = null; try { localStorage.removeItem(VIX_ALERT_KEY); } catch(e) {} toast("تم إلغاء تنبيه VIX"); }
      else { _vixAlertThreshold = v; try { localStorage.setItem(VIX_ALERT_KEY, v); } catch(e) {} toast("سيتم تنبيهك عندما يتجاوز VIX " + v); }
      updateStatus();
    });
    updateStatus();
  }
  function checkVixAlert(r) {
    if (_vixAlertThreshold == null || !r || !r.vix || r.vix.current == null) return;
    if (r.vix.current > _vixAlertThreshold) toast("تنبيه: VIX وصل إلى " + num(r.vix.current, 1) + " — تجاوز حدك " + _vixAlertThreshold);
  }

  // ---- 3. Portfolio calculator --------------------------------------------
  var PORTFOLIO_KEY = "mb-portfolio-v1";
  var PORTFOLIO_COINS = [
    { sym:"BTC",  ticker:"BTC"  },
    { sym:"ETH",  ticker:"ETH"  },
    { sym:"GOLD", ticker:"GC=F" },
    { sym:"CASH", ticker:null   }
  ];
  function getTickerPrice(ticker) {
    if (!lastReport || !lastReport.quotes || !ticker) return 0;
    for (var i = 0; i < lastReport.quotes.length; i++) {
      var q = lastReport.quotes[i];
      if (q && q.symbol && q.price) {
        var sym = q.symbol.toUpperCase().replace("-USD","").replace("=F","");
        if (sym === ticker.toUpperCase().replace("-USD","").replace("=F","")) return parseFloat(q.price) || 0;
      }
    }
    return 0;
  }
  function updatePortfolioTotals() {
    var saved; try { saved = JSON.parse(localStorage.getItem(PORTFOLIO_KEY) || "{}"); } catch(e) { saved = {}; }
    var prices = { BTC: getTickerPrice("BTC"), ETH: getTickerPrice("ETH"), GOLD: getTickerPrice("GC"), CASH: 1 };
    var total = 0;
    PORTFOLIO_COINS.forEach(function(c) {
      var qty = parseFloat(saved[c.sym]) || 0;
      var price = prices[c.sym] || 0;
      var usd = c.sym === "CASH" ? qty : qty * price;
      total += usd;
      var usdEl = $("pf-usd-" + c.sym.toLowerCase());
      if (usdEl) usdEl.textContent = (price > 0 || c.sym === "CASH") && qty > 0 ? "$" + num(usd, 0) : "—";
    });
    var tv = $("pf-total"); if (tv) tv.textContent = total > 0 ? "$" + num(total, 0) : "$0";
  }
  function setupPortfolio() {
    var saved; try { saved = JSON.parse(localStorage.getItem(PORTFOLIO_KEY) || "{}"); } catch(e) { saved = {}; }
    PORTFOLIO_COINS.forEach(function(c) {
      var inp = $("pf-inp-" + c.sym.toLowerCase()); if (!inp) return;
      inp.value = saved[c.sym] || "";
      inp.addEventListener("input", function() {
        saved[c.sym] = inp.value;
        try { localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(saved)); } catch(e) {}
        updatePortfolioTotals();
      });
    });
    updatePortfolioTotals();
    window._portfolioRefresh = updatePortfolioTotals;
  }

  // ---- 4. Settings backup / restore ----------------------------------------
  function setupSettingsBackup() {
    var expBtn = $("btn-settings-export"), impBtn = $("btn-settings-import"), impFile = $("settings-import-file");
    if (expBtn) expBtn.addEventListener("click", function() {
      var data = {};
      Object.keys(localStorage).filter(function(k) { return k.startsWith("mb-"); }).forEach(function(k) { data[k] = localStorage.getItem(k); });
      var a = document.createElement("a");
      a.href = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
      a.download = "market-brief-backup-" + new Date().toISOString().split("T")[0] + ".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      toast("تم تصدير " + Object.keys(data).length + " إعداد");
    });
    if (impBtn && impFile) {
      impBtn.addEventListener("click", function() { impFile.click(); });
      impFile.addEventListener("change", function() {
        var file = impFile.files[0]; if (!file) return;
        var reader = new FileReader();
        reader.onload = function(e) {
          try {
            var data = JSON.parse(e.target.result); var count = 0;
            Object.keys(data).forEach(function(k) { if (k.startsWith("mb-")) { localStorage.setItem(k, data[k]); count++; } });
            toast("تم استيراد " + count + " إعداد — أعِد تحميل الصفحة");
          } catch(err) { toast("❌ ملف غير صالح"); }
        };
        reader.readAsText(file);
      });
    }
  }

  // ---- 5. Word blacklist (hides news containing these words) ---------------
  var blacklistWords = [];
  function applyBlacklist() {
    document.querySelectorAll(".news-item[data-url]").forEach(function(el) {
      if (!blacklistWords.length) { el.classList.remove("bl-hidden"); return; }
      var title = ((el.querySelector(".news-title") || {}).textContent || "").toLowerCase();
      el.classList.toggle("bl-hidden", blacklistWords.some(function(w) { return w && title.includes(w.toLowerCase()); }));
    });
    updateReadCounter();
  }
  function setupBlacklist() {
    var inp = $("blacklist-inp"); if (!inp) return;
    var key = "mb-blacklist-v1";
    try { inp.value = localStorage.getItem(key) || ""; } catch(e) {}
    function update() {
      blacklistWords = inp.value.split(/[,،\s]+/).map(function(w) { return w.trim(); }).filter(Boolean);
      try { localStorage.setItem(key, inp.value); } catch(e) {}
      applyBlacklist();
    }
    update(); inp.addEventListener("input", update);
  }

  // ---- 6. Sentiment donut SVG chart ----------------------------------------
  function updateSentimentDonut() {
    var svg = $("sent-donut-svg"); if (!svg) return;
    var all = document.querySelectorAll(".news-item[data-sent]");
    var pos = 0, neg = 0, neu = 0;
    all.forEach(function(el) {
      if (el.classList.contains("ni-hidden") || el.classList.contains("bl-hidden") || el.style.display === "none") return;
      var s = parseFloat(el.dataset.sent || 0);
      if (s > 0) pos++; else if (s < 0) neg++; else neu++;
    });
    var total = pos + neg + neu; if (!total) return;
    var R = 17, cx = 21, cy = 21, tau = 2 * Math.PI;
    function arc(start, end, color) {
      if (end - start < 0.002) return "";
      if (end - start >= tau - 0.002) return '<circle cx="'+cx+'" cy="'+cy+'" r="'+R+'" fill="none" stroke="'+color+'" stroke-width="5"/>';
      var s = { x: cx + R * Math.cos(start - Math.PI/2), y: cy + R * Math.sin(start - Math.PI/2) };
      var e = { x: cx + R * Math.cos(end   - Math.PI/2), y: cy + R * Math.sin(end   - Math.PI/2) };
      return '<path d="M '+s.x.toFixed(2)+' '+s.y.toFixed(2)+' A '+R+' '+R+' 0 '+(end-start>Math.PI?1:0)+' 1 '+e.x.toFixed(2)+' '+e.y.toFixed(2)+'" fill="none" stroke="'+color+'" stroke-width="5" stroke-linecap="round"/>';
    }
    var a0 = 0, a1 = (pos/total)*tau, a2 = a1 + (neu/total)*tau, a3 = tau;
    svg.innerHTML = arc(a0,a1,"#22C97A") + arc(a1,a2,"rgba(120,114,104,.5)") + arc(a2,a3,"#E05050");
    var lPos = $("sdl-pos"), lNeg = $("sdl-neg"), lNeu = $("sdl-neu");
    if (lPos) lPos.textContent = pos + " (" + Math.round(pos/total*100) + "%)";
    if (lNeg) lNeg.textContent = neg + " (" + Math.round(neg/total*100) + "%)";
    if (lNeu) lNeu.textContent = neu + " (" + Math.round(neu/total*100) + "%)";
  }

  // ---- 7. Export read history as CSV --------------------------------------
  function setupExportReadHistory() {
    var btn = $("btn-export-read-hist"); if (!btn) return;
    btn.addEventListener("click", function() {
      var urls = Array.from(readNews);
      if (!urls.length) { toast("لم تقرأ أي خبر بعد"); return; }
      var a = document.createElement("a");
      a.href = "data:text/csv;charset=utf-8," + encodeURIComponent("url\n" + urls.join("\n"));
      a.download = "الأخبار_المقروءة_" + new Date().toISOString().split("T")[0] + ".csv";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      toast("تم تصدير " + urls.length + " خبر مقروء");
    });
  }

  // ---- 8. Heatmap calendar (history page — reads from window.MB_HIST_SCORES) --
  function buildHeatmap() {
    var wrap = $("heatmap-grid"); if (!wrap) return;
    var data = window.MB_HIST_SCORES || {};
    var today = new Date(); today.setHours(0,0,0,0);
    var cols = 13; var rows = 7; var days = cols * rows;
    var start = new Date(today); start.setDate(start.getDate() - (days - 1));
    var grid = document.createDocumentFragment();
    for (var c = 0; c < cols; c++) {
      var col = document.createElement("div"); col.className = "heatmap-col";
      for (var r2 = 0; r2 < rows; r2++) {
        var d = new Date(start); d.setDate(start.getDate() + c * rows + r2);
        var key = d.toISOString().split("T")[0];
        var score = data[key] != null ? parseFloat(data[key]) : null;
        var cell = document.createElement("div"); cell.className = "hm-cell";
        var level = score == null ? "none" : score >= 7 ? "high" : score >= 4 ? "mid" : "low";
        cell.dataset.score = level;
        cell.title = key + (score != null ? " · تقييم: " + score + "/10" : " · لا بيانات");
        col.appendChild(cell);
      }
      grid.appendChild(col);
    }
    wrap.appendChild(grid);
    // find label for month range
    var lbl = $("heatmap-range");
    if (lbl) {
      var sm = start.toLocaleDateString("ar", { month:"short", year:"numeric" });
      var em = today.toLocaleDateString("ar", { month:"short", year:"numeric" });
      lbl.textContent = sm === em ? sm : sm + " — " + em;
    }
  }

  // ---- reading progress bar (amber line at the very top) -----------------
  function setupScrollProgress() {
    var bar = $("scroll-progress"); if (!bar) return;
    var ticking = false;
    function paint() {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (h > 0 ? (window.pageYOffset / h) * 100 : 0) + "%";
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(paint); }
    }, { passive: true });
    paint();
  }

  // ---- fast news poller (every 30 s, independent of full report refresh) ----
  function setupNewsPoller() {
    var NEWS_MS = 30000;
    function pollNews() {
      fetch('/api/news', { headers: { Accept: 'application/json' } })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (!data || (!data.geopolitics && !data.markets)) return;
          origNewsHtml = {};
          renderNews(data);
          updateNewsCounts();
          patchNewsSortTime();
          applyBreakingBadge();
          applyBlacklist();
          applyTimeFilter();
          applyTagFilter();
          applyPins();
        })
        .catch(function() {});
      setTimeout(pollNews, NEWS_MS);
    }
    setTimeout(pollNews, NEWS_MS);
  }

  // ---- boot -------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", function () {
    syncStill();
    setupDark();
    setupReveal();
    setupMenu();
    setupTop();
    setupPrint();
    setupReportActions();
    setupNewsSearch();
    setupNewsActions();
    setupNotes();
    setupFocusMode();
    setupNewsSort();
    setupNewsCompact();
    setupPauseRefresh();
    setupMarketTimer();
    setupFontSize();
    setupVisitStreak();
    setupStickyBar();
    setupShortcuts();
    setupWatchwords();
    setupRiskSlider();
    setupNotesActions();
    setupSentimentFilter();
    setupCopyAllNews();
    setupDailyReminder();
    setupRefreshProg();
    setupCollapsible();
    setupWorldClocks();
    setupHideNews();
    patchNewsSortTime();
    setupExportFull();
    setupVixAlert();
    setupPortfolio();
    setupSettingsBackup();
    setupBlacklist();
    setupExportReadHistory();
    buildHeatmap();
    setupBtcAlert();
    setupTimeFilter();
    setupAutoDark();
    setupSnapshot();
    setupSessionTimer();
    setupGroupBySource();
    setupReadLater();
    setupTts();
    setupCountdownTimer();
    setupFloatingNote();
    setupNewsPoller();
    setupScrollProgress();
    buildWeeklySummary();
    startClock();
    var seed = window.MB_REPORT;
    if (seed) { renderReport(seed, true); initialDone = true; }
    if (!window.MB_STATIC) setInterval(tick, 1000);
  });

  // If the tab was hidden at load (gauges/anim paused), replay with correct
  // values the moment it becomes visible.
  document.addEventListener("visibilitychange", function () {
    syncStill();
    if (!document.hidden && initialDone && lastReport) {
      gaugeVals = {};                 // re-sweep the gauges from zero
      renderReport(lastReport, true);
    }
  });

  window.MB_renderReport = renderReport;
})();
