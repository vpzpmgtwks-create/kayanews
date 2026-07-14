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

  function renderScore(sc, initial) {
    sc = sc || {};
    var color = sc.color || "#ef4d23";
    var score = sc.score;
    var pct = score != null ? Math.max(0, Math.min(1, score / 10)) * 100 : 0;
    animGaugeTick("g-score", score, pct, function (v) { return num(v, 1); }, color, initial ? 760 : 0);
    var lbl = $("hv-score-lbl");
    if (lbl) { lbl.textContent = sc.label_ar || "—"; lbl.style.color = color; }
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
  function renderTickers(quotes) {
    var el = $("tickers");
    if (!el) return;
    el.innerHTML = (quotes || []).map(function (q) {
      if (!q.ok) return '<div class="tick"><div class="t-name">' + esc(q.name) +
        '</div><div class="t-price">—</div></div>';
      var cls = q.up ? "up" : "down", ar = q.up ? "▲" : "▼";
      return '<div class="tick"><div class="t-name">' + esc(q.name) + '</div>' +
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
    return '<a class="news-item' + read + sc2 + isNew + '" href="' + esc(url) + '" target="_blank" rel="noopener"' +
      ' data-sent="' + (n.sentiment || 0) + '" data-url="' + esc(url) + '">' +
      '<div class="news-title">' + esc(title) + '</div>' +
      '<div class="news-meta">' +
      '<span class="dot-s" style="background:' + sc + '"></span>' +
      '<span class="src">' + esc(n.source) + '</span>' +
      (n.published_str ? '<span>' + esc(n.published_str) + '</span>' : '') + tags +
      '<span class="ni-actions">' +
      '<button class="ni-pin' + (pinnedUrls.has(url) ? ' pinned' : '') + '" data-pin-url="' + esc(url) + '" title="تثبيت">⭐</button>' +
      '<button class="ni-copy" data-copy-title="' + esc(title) + '" data-copy-url="' + esc(url) + '" title="نسخ العنوان">⧉</button>' +
      '<button class="ni-wa"   data-wa-title="'   + esc(title) + '" data-wa-url="'   + esc(url) + '" title="مشاركة واتساب">💬</button>' +
      '<button class="ni-hide" title="إخفاء">✕</button>' +
      '</span></div></a>';
  }

  function renderNews(r) {
    var g = $("geo-list"), m = $("mk-list");
    if (g) g.innerHTML = (r.geopolitics || []).map(newsItem).join("") || emptyRow();
    if (m) m.innerHTML = (r.markets || []).map(newsItem).join("") || emptyRow();
    setText("news-count", r.news_count != null ? r.news_count : "—");
    if (newsSearchTerm) setTimeout(filterNews, 60);
    setTimeout(function () { applyPins(); applyHighlight(); buildSourceChips(); updateNewsCounts(); applyBreakingBadge(); updateReadCounter(); }, 0);
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

    function updateShare() {
      var text = formatReport(lastReport);
      if (waBtn && text) waBtn.href = "https://wa.me/?text=" + encodeURIComponent(text);
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
          copyBtn.textContent = "✅ تم النسخ!";
          setTimeout(function () { copyBtn.classList.remove("copied"); copyBtn.innerHTML = orig; }, 2200);
          toast("✅ تم نسخ التقرير — الصقه في واتساب أو تيليجرام");
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
      var cp = e.target.closest(".ni-copy");
      if (cp) {
        e.preventDefault(); e.stopPropagation();
        navigator.clipboard.writeText(cp.dataset.copyTitle + "\n" + cp.dataset.copyUrl)
          .then(function () { toast("✅ تم نسخ الخبر"); }).catch(function () {});
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
        toast(on ? "⭐ تم التثبيت" : "📌 تم إلغاء التثبيت");
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
      btn.textContent = on ? "📄 مفصّل" : "📰 مختصر";
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
        el.textContent = "NYSE 🟢 مفتوح · يُغلق خلال " + Math.floor(rem / 60) + "س " + (rem % 60) + "د";
        el.className = "market-timer open";
      } else if (total < open) {
        var to = open - total;
        el.textContent = "NYSE 🔴 مغلق · يُفتح خلال " + Math.floor(to / 60) + "س " + (to % 60) + "د";
        el.className = "market-timer closed";
      } else {
        el.textContent = "NYSE 🔴 مغلق · يُفتح غداً 9:30ص"; el.className = "market-timer closed";
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
    var fire = d.streak > 1 ? '<span class="streak-fire">🔥</span> ' + d.streak + " أيام متتالية · " : "";
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
        bar.innerHTML = '<div class="pinned-label">📌 مثبّت</div>';
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
      if (e.key === "r" || e.key === "R") { e.preventDefault(); poll(); toast("🔄 جاري التحديث..."); return; }
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
    var label = function (v) { return v < 25 ? "منخفض جداً 🟢" : v < 45 ? "منخفض 🟡" : v < 55 ? "متوسط 🟠" : v < 75 ? "عالٍ 🔴" : "عالٍ جداً ⚠️"; };
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
      toast("📥 تم تصدير الملاحظات");
    });
    var clrBtn = $("btn-clear-read");
    if (clrBtn) clrBtn.addEventListener("click", function () {
      readNews.clear(); try { localStorage.removeItem(READ_NEWS_KEY); } catch (e) {}
      document.querySelectorAll(".news-item.news-read").forEach(function (el) { el.classList.remove("news-read"); });
      toast("🧹 تم مسح الأخبار المقروءة");
    });
  }

  // ---- score change alert --------------------------------------------------
  var _lastScore = null;
  function checkScoreChange(r) {
    if (!r || !r.score || r.score.score == null) return;
    var sc = r.score.score;
    if (_lastScore !== null && Math.abs(sc - _lastScore) >= 0.5) {
      var dir = sc > _lastScore ? "↑ ارتفع" : "↓ انخفض";
      var em  = sc >= 7 ? "🟢" : sc >= 5 ? "🟡" : sc >= 3 ? "🟠" : "🔴";
      toast(em + " التقييم " + dir + " من " + _lastScore + " إلى " + sc + "/10");
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
      if (item) { item.classList.add("ni-hidden"); updateReadCounter(); toast("🙈 تم إخفاء الخبر"); }
    });
  }

  // ---- time-based sort option ------------------------------------------------
  // Patches into setupNewsSort to add a "recent" option
  function patchNewsSortTime() {
    var btn = $("btn-news-sort"); if (!btn) return;
    var modes = ["↕ الترتيب", "↑ إيجابي", "↓ سلبي", "🕐 الأحدث"];
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
      toast("📥 تم تصدير النشرة + الملاحظات");
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
        toast("✅ تم نسخ " + items.length + " خبر");
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
            new Notification("نشرة السوق 📊", { body: "تم تفعيل التذكير اليومي بالنشرة", icon: "" });
            toast("🔔 تم تفعيل التذكير اليومي");
          } else { toast("🔕 تم إيقاف التذكير"); }
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
