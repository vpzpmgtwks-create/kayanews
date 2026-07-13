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
  var lastReport = null;          // most recent data, for re-render on focus
  var numState = new WeakMap();   // element -> last numeric value shown
  var gaugeVals = {};             // gauge id -> { v: rawValue, p: pct }

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
  function sentColor(s) { return s > 0 ? "#12885a" : s < 0 ? "#d1443a" : "#ef4d23"; }
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
        '" stroke="#e0ddd6" stroke-width="2.6" stroke-linecap="round"/>';
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
    for (var i = 0; i < N; i++) g.lines[i].setAttribute("stroke", i < active ? color : "#e0ddd6");
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
    var color = good == null ? "#8a8a8a" : good ? "#12885a" : "#d1443a";
    var bg = good == null ? "#f0efec" : good ? "#e7f6ee" : "#fdeceb";
    var icon = up ? TREND_UP : down ? TREND_DOWN : "";
    el.style.color = color; el.style.background = bg;
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
        '" stroke="#eee7df" stroke-width="1"/>';
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
      '<circle class="spark-dot" cx="' + lx + '" cy="' + ly + '" r="5" fill="#fff" stroke="' +
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
    var color = up ? "#12885a" : down ? "#d1443a" : "#8a8a8a";
    var bg = up ? "#e7f6ee" : down ? "#fdeceb" : "#f0efec";
    el.style.color = color; el.style.background = bg;
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
    var sc = sentColor(n.sentiment);
    var tags = (n.tags || []).slice(0, 3).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("");
    return '<a class="news-item" href="' + esc(n.link) + '" target="_blank" rel="noopener">' +
      '<div class="news-title">' + esc(title) + '</div><div class="news-meta">' +
      '<span class="dot-s" style="background:' + sc + '"></span>' +
      '<span class="src">' + esc(n.source) + '</span>' +
      (n.published_str ? '<span>' + esc(n.published_str) + '</span>' : '') + tags + '</div></a>';
  }

  function renderNews(r) {
    var g = $("geo-list"), m = $("mk-list");
    if (g) g.innerHTML = (r.geopolitics || []).map(newsItem).join("") || emptyRow();
    if (m) m.innerHTML = (r.markets || []).map(newsItem).join("") || emptyRow();
    setText("news-count", r.news_count != null ? r.news_count : "—");
  }
  function emptyRow() {
    return '<div class="news-item"><div class="news-title" style="color:#9a988f">لا توجد أخبار متاحة حالياً</div></div>';
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
    counter -= 1;
    setText("countdown", Math.max(0, counter));
    renderUpdated();
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
    applyTheme(saved !== null ? saved === "1" : prefersDark);
    btn.addEventListener("click", function () {
      applyTheme(document.documentElement.getAttribute("data-theme") !== "dark");
    });
  }

  // ---- lazy-load TradingView widgets -----------------------------------
  // Scripts are stored as application/json so they don't run at parse time.
  // We inject real <script> elements only when the section scrolls into view,
  // cutting ~900 KB of external script from the critical path.
  function _loadTV(section) {
    var theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    section.querySelectorAll("script.tv-lazy").forEach(function (tmpl) {
      try {
        var cfg = JSON.parse(tmpl.textContent);
        cfg.colorTheme = theme;
        var s = document.createElement("script");
        s.type = "text/javascript";
        s.async = true;
        s.src = tmpl.getAttribute("data-src");
        s.textContent = JSON.stringify(cfg);
        tmpl.parentNode.replaceChild(s, tmpl);
      } catch (e) {}
    });
  }

  function setupLazyTV() {
    var sec = $("fear-live"); if (!sec) return;
    if (!("IntersectionObserver" in window)) { _loadTV(sec); return; }
    var io = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) { _loadTV(sec); io.disconnect(); }
    }, { rootMargin: "400px" });
    io.observe(sec);
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
    setupLazyTV();
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
