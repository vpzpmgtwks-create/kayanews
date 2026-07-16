"""
Market Brief engine — 100% free, no API keys.

- Geopolitical + economic news via free RSS, condensed and auto-translated to
  concise Arabic (free Google endpoint via deep-translator).
- VIX index + live key market quotes (gold, oil, S&P 500, Nasdaq, Bitcoin,
  US dollar) via Yahoo Finance chart API (no key).
- A market score out of 10 and a concise Arabic bottom-line (الزبدة).
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html import unescape

import feedparser
import requests

# --------------------------------------------------------------------------- #
# Telegram (optional — set env vars to enable daily push)
# --------------------------------------------------------------------------- #
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
_TELEGRAM_LOG: list[dict] = []   # in-memory send history (last 100 entries)


def send_telegram_report(report: dict) -> bool:
    """Send daily market summary to a Telegram channel/chat.

    Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from environment.
    Returns True on success, False if disabled or on any error.
    """
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        return False

    vix   = report.get("vix") or {}
    score = report.get("score") or {}
    fg_s  = report.get("fear_greed_stocks") or {}
    geo   = report.get("geopolitics") or []
    mk    = report.get("markets") or []

    def _f(v, d=1):
        try:
            return f"{float(v):.{d}f}"
        except Exception:
            return "—"

    lines = [
        "📊 *نشرة السوق اليومية*",
        "",
        f"🎯 التقييم: *{_f(score.get('score'))}/١٠* — {score.get('label_ar', '')}",
        f"😰 VIX: *{_f(vix.get('current'))}* — {vix.get('label_ar', '')}",
    ]
    if fg_s.get("ok"):
        lines.append(
            f"💹 مزاج الأسهم: *{_f(fg_s.get('value'), 0)}* — {fg_s.get('label_ar', '')}"
        )

    bl = report.get("bottom_line", "")
    if bl:
        lines += ["", f"💡 _{bl}_"]

    pts = report.get("points") or []
    if pts:
        lines += ["", "📌 *النقاط الرئيسية:*"]
        for p in pts[:4]:
            lines.append(f"◆ {p}")

    top_geo = (geo[0].get("title_ar") or geo[0].get("title")) if geo else None
    top_mk  = (mk[0].get("title_ar")  or mk[0].get("title"))  if mk  else None
    if top_geo or top_mk:
        lines += ["", "📰 *أبرز الأخبار:*"]
        if top_geo:
            lines.append(f"🌍 {top_geo}")
        if top_mk:
            lines.append(f"📈 {top_mk}")

    lines += ["", "🔗 [التقرير الكامل](https://kayanews.onrender.com)"]

    success = False
    error_msg = ""
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
            json={
                "chat_id": TELEGRAM_CHAT_ID,
                "text": "\n".join(lines),
                "parse_mode": "Markdown",
                "disable_web_page_preview": False,
            },
            timeout=12,
        )
        success = resp.ok
        if not resp.ok:
            try:
                error_msg = resp.json().get("description", resp.text[:120])
            except Exception:
                error_msg = resp.text[:120]
    except Exception as e:  # noqa: BLE001
        error_msg = str(e)[:120]

    _TELEGRAM_LOG.append({
        "ts": int(time.time()),
        "ok": success,
        "chat_id": TELEGRAM_CHAT_ID,
        "error": error_msg,
    })
    if len(_TELEGRAM_LOG) > 100:
        del _TELEGRAM_LOG[:-100]
    return success


def get_telegram_log() -> list[dict]:
    """Return recent Telegram send log, newest first."""
    return list(reversed(_TELEGRAM_LOG))


# --------------------------------------------------------------------------- #
# Sources (all free, no API key required)
# --------------------------------------------------------------------------- #
NEWS_FEEDS = [
    # Wire services — publish within seconds of breaking events
    ("Reuters World",    "https://feeds.reuters.com/Reuters/worldNews",                "geopolitics"),
    ("Reuters Politics", "https://feeds.reuters.com/Reuters/PoliticsNews",             "geopolitics"),
    ("Reuters Business", "https://feeds.reuters.com/reuters/businessNews",             "markets"),
    ("Reuters Finance",  "https://feeds.reuters.com/reuters/financialsNews",           "markets"),
    # Broad news
    ("Al Jazeera",       "https://www.aljazeera.com/xml/rss/all.xml",                  "geopolitics"),
    ("BBC World",        "https://feeds.bbci.co.uk/news/world/rss.xml",                "geopolitics"),
    # Financial Juice — aggregates top financial Twitter/X analysts in real time
    ("Financial Juice",  "https://financialjuice.com/feed.ashx",                       "markets"),
    # Specialized financial / macro
    ("ForexLive",        "https://www.forexlive.com/feed/news",                        "markets"),
    ("CNBC Markets",     "https://www.cnbc.com/id/100003114/device/rss/rss.html",      "markets"),
    ("CNBC Economy",     "https://www.cnbc.com/id/20910258/device/rss/rss.html",       "markets"),
    ("MarketWatch",      "https://feeds.content.dowjones.io/public/rss/mw_topstories", "markets"),
    # Precision macro analysis (Substack newsletters from top analysts)
    ("Kobeissi Letter",  "https://thekobeissiletter.substack.com/feed",                "markets"),
    ("Wolf Street",      "https://wolfstreet.com/feed/",                               "markets"),
    # Crypto — specialized
    ("CoinDesk",         "https://www.coindesk.com/arc/outboundfeeds/rss/",            "markets"),
    ("CoinTelegraph",    "https://cointelegraph.com/rss",                              "markets"),
    ("Blockworks",       "https://blockworks.co/feed",                                 "markets"),
    # Energy / Commodities
    ("OilPrice",         "https://oilprice.com/rss/main",                              "markets"),
    # Broad financial coverage
    ("Investing.com",    "https://www.investing.com/rss/news.rss",                     "markets"),
]

# Precision / wire sources get a relevance boost so they rank above generic news
PRECISION_SOURCES = {
    "Financial Juice", "Kobeissi Letter", "Wolf Street", "ForexLive",
    "Reuters World", "Reuters Politics", "Reuters Business", "Reuters Finance",
}

VIX_URL = "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1mo"
QUOTE_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=5d"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MarketBrief/1.0"}
# Some endpoints (CNN) require a full browser UA
BROWSER_HEADERS = {"User-Agent": (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")}

# Free sentiment / on-chain sources (no API key)
CRYPTO_FG_URL = "https://api.alternative.me/fng/?limit=2"
CNN_FG_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
STABLECOINS_URL = "https://stablecoins.llama.fi/stablecoincharts/all"

# Live market quotes shown in the top strip (name_ar, yahoo symbol, decimals)
MARKET_TICKERS = [
    ("الذهب", "GC=F", 1),
    ("النفط WTI", "CL=F", 2),
    ("S&P 500", "%5EGSPC", 2),
    ("ناسداك", "%5EIXIC", 2),
    ("داو جونز", "%5EDJI", 0),
    ("بيتكوين", "BTC-USD", 0),
    ("مؤشر الدولار", "DX-Y.NYB", 2),
    ("عائد ١٠ سنوات", "%5ETNX", 2),
]

# US sector ETFs (SPDR) — one-day performance = market breadth at a glance
SECTOR_TICKERS = [
    ("التكنولوجيا", "XLK"),
    ("المالية", "XLF"),
    ("الرعاية الصحية", "XLV"),
    ("الطاقة", "XLE"),
    ("الاستهلاك التقديري", "XLY"),
    ("السلع الاستهلاكية", "XLP"),
    ("الصناعات", "XLI"),
    ("المواد", "XLB"),
    ("المرافق", "XLU"),
    ("العقارات", "XLRE"),
    ("الاتصالات", "XLC"),
]

# --------------------------------------------------------------------------- #
# Keyword dictionaries for relevance + lightweight sentiment
# --------------------------------------------------------------------------- #
GEO_KEYWORDS = [
    "war", "conflict", "invasion", "sanction", "military", "missile", "strike",
    "ceasefire", "troops", "nuclear", "tension", "border", "coup", "protest",
    "terror", "attack", "hostage", "embargo", "opec", "oil", "gas", "pipeline",
    "russia", "ukraine", "israel", "gaza", "iran", "china", "taiwan",
    "north korea", "red sea", "houthi", "hormuz", "middle east", "nato",
    "election", "airstrike", "drone",
]
FIN_KEYWORDS = [
    "fed", "federal reserve", "interest rate", "rate cut", "rate hike",
    "inflation", "cpi", "ppi", "gdp", "recession", "jobs", "unemployment",
    "earnings", "stocks", "bond", "yield", "dollar", "treasury", "market",
    "nasdaq", "s&p", "dow", "ecb", "boj", "tariff", "crude", "gold",
    "bitcoin", "crypto", "central bank", "selloff", "rally", "wall street",
    "ethereum", "btc", "eth", "defi", "blockchain", "altcoin", "stablecoin",
    "binance", "coinbase", "sec", "etf", "halving", "forex", "fx",
    "oil", "opec", "commodities", "silver", "copper", "energy",
    # Precision macro / rates
    "fomc", "powell", "lagarde", "boe", "bank of england", "pboc", "rba",
    "quantitative", "liquidity", "balance sheet", "debt ceiling", "fiscal",
    "trade deficit", "current account", "pmi", "ism", "nfp", "adp",
    "options", "futures", "derivatives", "swap", "spread", "basis points",
    "ipo", "earnings beat", "earnings miss", "guidance", "revenue",
    "bankruptcy", "default risk", "credit", "leverage", "margin call",
]
NEG_KEYWORDS = [
    "war", "invasion", "attack", "strike", "missile", "sanction", "crash",
    "plunge", "slump", "fear", "recession", "escalation", "conflict",
    "tension", "selloff", "default", "downgrade", "layoff", "hike", "embargo",
    "shutdown", "surge in inflation", "tumble", "fall", "drop", "warns",
    "crisis", "threat", "airstrike",
]
POS_KEYWORDS = [
    "ceasefire", "deal", "agreement", "truce", "rate cut", "easing", "rally",
    "surge", "gains", "recovery", "growth", "stimulus", "peace", "resolution",
    "beats", "upgrade", "rebound", "record high", "optimism", "boost",
]

# in-memory caches
_CACHE: dict = {"ts": 0, "data": None}
_CACHE_TTL = 60  # seconds — background refresher fires every 45 s
_NEWS_CACHE: dict = {"ts": 0, "data": None}
_NEWS_CACHE_TTL = 30  # news refreshed independently every 30 s
_TR_CACHE: dict = {}  # english title -> arabic (per-process)

# Persistent daily history (site records)
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
HISTORY_PATH = os.path.join(DATA_DIR, "history.json")
_HISTORY_LOCK = threading.Lock()
_HISTORY_MAX = 120  # keep ~4 months of daily snapshots


def _count_matches(text: str, keywords: list[str]) -> list[str]:
    return [kw for kw in keywords if kw in text]


def _clean(text: str) -> str:
    text = unescape(text or "")
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\s+", " ", text).strip()


# --------------------------------------------------------------------------- #
# Free Arabic translation (Google endpoint, no key)
# --------------------------------------------------------------------------- #
GT_URL = "https://translate.googleapis.com/translate_a/single"


def _translate_one(text: str) -> str:
    """Translate to Arabic via Google's free endpoint, with an explicit timeout.

    We call the endpoint directly (instead of deep_translator) so every network
    read in the pipeline is time-bounded — deep_translator sets no timeout and a
    single throttled request could otherwise hang the whole page indefinitely.
    """
    try:
        params = {"client": "gtx", "sl": "auto", "tl": "ar", "dt": "t", "q": text}
        r = requests.get(GT_URL, params=params, headers=HEADERS, timeout=8)
        r.raise_for_status()
        segments = r.json()[0] or []
        out = "".join(seg[0] for seg in segments if seg and seg[0])
        return out or text
    except Exception:  # noqa: BLE001
        return text  # fallback to original English


def _translate_batch(texts: list[str]) -> list[str]:
    """Translate English headlines to concise Arabic, in parallel. Cached
    per-text; falls back to the original text if the endpoint is unavailable."""
    out: list[str] = [""] * len(texts)
    todo = [(i, t) for i, t in enumerate(texts) if t and t not in _TR_CACHE]
    for i, t in enumerate(texts):
        if not t:
            out[i] = ""
        elif t in _TR_CACHE:
            out[i] = _TR_CACHE[t]

    if todo:
        with ThreadPoolExecutor(max_workers=8) as ex:
            results = list(ex.map(lambda p: _translate_one(p[1]), todo))
        for (i, t), val in zip(todo, results):
            _TR_CACHE[t] = val
            out[i] = val
    return out


# --------------------------------------------------------------------------- #
# VIX
# --------------------------------------------------------------------------- #
def fetch_vix() -> dict:
    try:
        r = requests.get(VIX_URL, headers=HEADERS, timeout=12)
        r.raise_for_status()
        result = r.json()["chart"]["result"][0]
        meta = result.get("meta", {}) or {}
        closes = [c for c in result["indicators"]["quote"][0]["close"] if c is not None]
        # Live intraday value while the market is open; the last daily close
        # otherwise. Using regularMarketPrice keeps VIX moving tick-by-tick
        # instead of freezing on yesterday's close.
        live = meta.get("regularMarketPrice")
        current = round(float(live), 2) if live is not None else round(closes[-1], 2)
        cur_raw = float(live) if live is not None else closes[-1]
        # Previous *daily* close. NOTE: meta.chartPreviousClose on a 1-month
        # range is the close from ~a month ago, so we derive yesterday's close
        # from the daily series: if the last candle is today's (≈ live), take
        # the one before it; otherwise the last candle already is yesterday.
        tol = max(0.05, abs(cur_raw) * 0.01)
        if len(closes) >= 2 and abs(closes[-1] - cur_raw) <= tol:
            prev = round(closes[-2], 2)
        elif closes:
            prev = round(closes[-1], 2)
        else:
            prev = current
        change = round(current - prev, 2)
        pct = round((change / prev) * 100, 2) if prev else 0.0
        # fold the live tick into the month range + sparkline tail
        month_high = round(max(max(closes), current), 2)
        month_low = round(min(min(closes), current), 2)
        history = [round(c, 2) for c in closes[-22:]]  # ~1 trading month
        if history and abs(history[-1] - current) > 1e-9:
            history[-1] = current
        ok, err = True, None
    except Exception as e:  # noqa: BLE001
        current = prev = change = pct = month_high = month_low = None
        history = []
        ok, err = False, str(e)

    level, label_en, label_ar, color = _vix_interpretation(current)
    return {
        "ok": ok, "error": err, "current": current, "prev_close": prev,
        "change": change, "change_pct": pct, "month_high": month_high,
        "month_low": month_low, "level": level, "label_en": label_en,
        "label_ar": label_ar, "color": color, "history": history,
    }


def _vix_interpretation(v):
    if v is None:
        return ("unknown", "Unknown", "غير متوفر", "#888")
    if v < 15:
        return ("calm", "Calm", "هدوء واطمئنان", "#16a34a")
    if v < 20:
        return ("normal", "Normal", "تقلّب طبيعي", "#65a30d")
    if v < 30:
        return ("elevated", "Elevated", "قلق وتوتر مرتفع", "#f59e0b")
    return ("fear", "High Fear", "خوف شديد", "#dc2626")


# --------------------------------------------------------------------------- #
# Live market quotes (gold, oil, indices, bitcoin, dollar)
# --------------------------------------------------------------------------- #
def _fetch_quote(name: str, symbol: str, decimals: int) -> dict:
    try:
        url = QUOTE_URL.format(sym=symbol)
        r = requests.get(url, headers=HEADERS, timeout=8)
        r.raise_for_status()
        res = r.json()["chart"]["result"][0]
        meta = res.get("meta", {}) or {}
        closes = [c for c in res["indicators"]["quote"][0]["close"] if c is not None]
        price = meta.get("regularMarketPrice")
        if price is None and closes:
            price = closes[-1]
        prev = meta.get("chartPreviousClose")
        if prev is None and len(closes) > 1:
            prev = closes[-2]
        price = float(price)
        prev = float(prev) if prev else price
        change = price - prev
        pct = (change / prev) * 100 if prev else 0.0
        return {
            "name": name, "ok": True,
            "price": round(price, decimals),
            "change": round(change, decimals),
            "change_pct": round(pct, 2),
            "up": change >= 0,
        }
    except Exception as e:  # noqa: BLE001
        return {"name": name, "ok": False, "error": str(e)}


def fetch_markets() -> list[dict]:
    with ThreadPoolExecutor(max_workers=6) as ex:
        return list(ex.map(lambda a: _fetch_quote(*a), MARKET_TICKERS))


def fetch_sectors() -> list[dict]:
    """Live S&P 500 sector performance via the 11 SPDR sector ETFs.

    Returns only the tickers that resolved, sorted best-to-worst by daily %.
    Lets the report show sector rotation (risk-on vs. defensive) at a glance.
    """
    with ThreadPoolExecutor(max_workers=len(SECTOR_TICKERS)) as ex:
        rows = list(ex.map(lambda a: _fetch_quote(a[0], a[1], 2), SECTOR_TICKERS))
    ok = [r for r in rows if r.get("ok")]
    ok.sort(key=lambda r: r.get("change_pct", 0.0), reverse=True)
    return ok


# --------------------------------------------------------------------------- #
# Free market-sentiment gauges (Fear & Greed) + on-chain stablecoin reserve
# --------------------------------------------------------------------------- #
def _fg_arabic(value):
    """Map a 0–100 Fear & Greed value to an Arabic label + color."""
    if value is None:
        return ("غير متوفر", "#888")
    if value < 25:
        return ("خوف شديد", "#dc2626")
    if value < 45:
        return ("خوف", "#f59e0b")
    if value < 55:
        return ("محايد", "#d97706")
    if value < 75:
        return ("طمع", "#65a30d")
    return ("طمع شديد", "#16a34a")


def fetch_fear_greed_crypto() -> dict:
    """Crypto Fear & Greed index (alternative.me, free)."""
    try:
        r = requests.get(CRYPTO_FG_URL, headers=HEADERS, timeout=10)
        r.raise_for_status()
        data = r.json()["data"]
        val = int(data[0]["value"])
        prev = int(data[1]["value"]) if len(data) > 1 else val
        label_ar, color = _fg_arabic(val)
        return {"ok": True, "value": val, "change": val - prev,
                "label_ar": label_ar, "color": color}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


def fetch_fear_greed_stocks() -> dict:
    """CNN stock-market Fear & Greed index (free JSON, needs browser UA)."""
    try:
        r = requests.get(CNN_FG_URL, headers=BROWSER_HEADERS, timeout=10)
        r.raise_for_status()
        fg = r.json()["fear_and_greed"]
        val = round(float(fg["score"]), 1)
        prev = float(fg.get("previous_close", val) or val)
        label_ar, color = _fg_arabic(val)
        return {"ok": True, "value": val, "change": round(val - prev, 1),
                "label_ar": label_ar, "color": color}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


def fetch_stablecoins() -> dict:
    """Total stablecoin supply + weekly trend (DeFiLlama, free).

    Rising stablecoin reserves = dry powder building on the sidelines
    (potential whale accumulation), per the user's on-chain rule.
    """
    def _val(point):
        v = point.get("totalCirculatingUSD")
        if isinstance(v, dict):
            return sum(float(x) for x in v.values())
        return float(v)

    try:
        r = requests.get(STABLECOINS_URL, headers=HEADERS, timeout=15)
        r.raise_for_status()
        series = r.json()
        last = _val(series[-1])
        week = _val(series[-8]) if len(series) > 8 else _val(series[0])
        change_pct = ((last - week) / week * 100) if week else 0.0
        return {"ok": True, "total_b": round(last / 1e9, 1),
                "change_pct": round(change_pct, 2), "rising": last >= week}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


# --------------------------------------------------------------------------- #
# News
# --------------------------------------------------------------------------- #
def _parse_feed(url: str):
    """Download the feed with an explicit timeout via requests, then hand the
    bytes to feedparser. feedparser's own fetch has no timeout and can hang the
    whole request if a single RSS host stalls, so we never let it fetch."""
    try:
        r = requests.get(url, headers=BROWSER_HEADERS, timeout=(4, 8))
        r.raise_for_status()
        return feedparser.parse(r.content)
    except Exception:  # noqa: BLE001
        return None


def fetch_news(force: bool = False) -> list[dict]:
    now = time.time()
    if not force and _NEWS_CACHE["data"] is not None and (now - _NEWS_CACHE["ts"]) < _NEWS_CACHE_TTL:
        return _NEWS_CACHE["data"]

    items: list[dict] = []
    seen_titles: set[str] = set()

    # download all feeds in parallel, then process them in declared order
    with ThreadPoolExecutor(max_workers=len(NEWS_FEEDS)) as ex:
        feeds = list(ex.map(lambda f: _parse_feed(f[1]), NEWS_FEEDS))

    for (source, url, category), feed in zip(NEWS_FEEDS, feeds):
        if feed is None:
            continue

        for entry in feed.entries[:30]:
            title = _clean(entry.get("title", ""))
            if not title or title.lower() in seen_titles:
                continue
            seen_titles.add(title.lower())

            summary = _clean(entry.get("summary", entry.get("description", "")))
            link = entry.get("link", "")
            published = _parse_time(entry)
            text = (title + " " + summary).lower()

            geo_hits = _count_matches(text, GEO_KEYWORDS)
            fin_hits = _count_matches(text, FIN_KEYWORDS)
            neg_hits = _count_matches(text, NEG_KEYWORDS)
            pos_hits = _count_matches(text, POS_KEYWORDS)

            relevance = len(geo_hits) * 2 + len(fin_hits) * 2
            if category == "markets":
                relevance += 1
            if source in PRECISION_SOURCES and relevance > 0:
                relevance += 2  # wire / precision source boost
            if relevance < 2:  # require at least one keyword hit
                continue

            items.append({
                "title": title,
                "title_ar": "",  # filled later (only for displayed items)
                "link": link,
                "source": source,
                "category": category,
                "published": published,
                "published_str": _fmt_time(published),
                "relevance": relevance,
                "sentiment": len(pos_hits) - len(neg_hits),
                "tags": sorted(set(geo_hits + fin_hits))[:5],
            })

    # Freshness first: the newest relevant headline always leads, relevance
    # only breaks ties between articles published in the same minute.
    items.sort(key=lambda x: (x["published"] or 0, x["relevance"]), reverse=True)
    _NEWS_CACHE["ts"] = time.time()
    _NEWS_CACHE["data"] = items
    return items


def get_news() -> dict:
    """Return geo/markets news with 30-second freshness for /api/news."""
    news = fetch_news()
    geo = [n for n in news if n["category"] == "geopolitics"][:10]
    mk = [n for n in news if n["category"] == "markets"][:10]
    titles = [n["title"] for n in geo] + [n["title"] for n in mk]
    tr = _translate_batch(titles)
    for i, n in enumerate(geo):
        n["title_ar"] = tr[i]
    for j, n in enumerate(mk):
        n["title_ar"] = tr[len(geo) + j]
    return {
        "geopolitics": geo,
        "markets": mk,
        "news_count": len(news),
        "news_sentiment": news_sentiment_index(news),
    }


def _parse_time(entry) -> float | None:
    for key in ("published_parsed", "updated_parsed"):
        t = entry.get(key)
        if t:
            try:
                return time.mktime(t)
            except Exception:  # noqa: BLE001
                pass
    return None


def _fmt_time(ts: float | None) -> str:
    if not ts:
        return ""
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


# --------------------------------------------------------------------------- #
# Scoring + concise Arabic bottom-line (الزبدة)
# --------------------------------------------------------------------------- #
def _vix_score_contrib(v: float) -> float:
    """Smooth VIX→comfort contribution (~+3 calm … −4 panic).

    Piecewise-linear between anchor points so even a 0.2-point VIX move nudges
    the overall score — that's what makes the gauge feel live and precise,
    instead of jumping only when VIX crosses a whole bucket boundary.
    """
    pts = [(10, 3.0), (13, 2.5), (15, 2.0), (18, 1.0), (22, 0.0),
           (27, -1.5), (32, -3.0), (40, -4.0)]
    if v <= pts[0][0]:
        return pts[0][1]
    if v >= pts[-1][0]:
        return pts[-1][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= v <= x1:
            t = (v - x0) / (x1 - x0)
            return y0 + t * (y1 - y0)
    return 0.0


def news_sentiment_index(news: list[dict]) -> dict:
    """Continuous market news-sentiment index in [-100, +100].

    Every headline's positive/negative tilt is weighted by how *fresh* it is
    (exponential decay, ~8-hour half-life) and how *relevant* it is, so the
    index — and the score built on top of it — shifts precisely as the news
    flow changes rather than moving in coarse whole-number steps.
    """
    now = time.time()
    num = den = 0.0
    pos_n = neg_n = 0
    for n in news[:40]:
        s = n.get("sentiment", 0)
        if s > 0:
            pos_n += 1
        elif s < 0:
            neg_n += 1
        pub = n.get("published")
        age_h = ((now - pub) / 3600.0) if pub else 12.0
        recency = 0.5 ** (max(0.0, age_h) / 8.0)
        relevance = 1.0 + min(4.0, n.get("relevance", 0) / 3.0)
        w = recency * relevance
        num += s * w
        den += w
    idx = max(-100.0, min(100.0, (num / den) * 33.0)) if den > 0 else 0.0
    return {"index": round(idx, 1), "pos": pos_n, "neg": neg_n,
            "count": len(news)}


def estimate_mood(vix: dict, news_idx: dict) -> dict:
    """Fallback stock-mood (0–100) derived from VIX + news sentiment.

    Used only when the live CNN Fear & Greed feed is unreachable, so the
    "مزاج السوق" gauge is never blank. Flagged with estimated=True.
    """
    base = 50.0
    if vix.get("ok") and vix.get("current") is not None:
        base += max(-35.0, min(35.0, (20.0 - vix["current"]) * 2.2))
    if news_idx:
        base += max(-18.0, min(18.0, news_idx.get("index", 0.0) * 0.18))
    val = int(max(0, min(100, round(base))))
    label_ar, color = _fg_arabic(val)
    return {"ok": True, "value": val, "change": 0, "label_ar": label_ar,
            "color": color, "estimated": True}


def market_score(vix: dict, news_idx: dict,
                 fg_stocks: dict | None = None) -> dict:
    """A 0–10 market-comfort score. 10 = calm/positive, 0 = fear/negative.

    Blends a smooth VIX level + VIX direction + a recency-weighted news
    sentiment index + (when live) the stock Fear & Greed reading. Every input
    is continuous, so the score tracks the market precisely and keeps moving
    with each refresh instead of looking frozen.
    """
    score = 5.0
    v = vix.get("current")
    if vix.get("ok") and v is not None:
        score += _vix_score_contrib(v)
        ch = vix.get("change") or 0
        score += max(-0.6, min(0.6, -ch * 0.25))    # rising VIX = less comfort

    ni = news_idx.get("index", 0.0) if news_idx else 0.0
    score += max(-2.5, min(2.5, ni / 40.0))         # news tilt, continuous

    # live stock Fear & Greed nudge (skip our own estimate to avoid double-count)
    if fg_stocks and fg_stocks.get("ok") and not fg_stocks.get("estimated"):
        score += max(-1.0, min(1.0, (fg_stocks["value"] - 50) / 50.0))

    score = round(max(0.0, min(10.0, score)), 1)

    if score >= 7:
        label_ar, label_en, color = "إيجابي / مطمئن", "Positive", "#16a34a"
    elif score >= 4:
        label_ar, label_en, color = "حذر / محايد", "Cautious", "#d97706"
    else:
        label_ar, label_en, color = "سلبي / خطر مرتفع", "Risky", "#dc2626"

    return {"score": score, "net": ni, "news_index": ni,
            "label_ar": label_ar, "label_en": label_en, "color": color}


def _title_ar(n: dict) -> str:
    return n.get("title_ar") or n.get("title") or ""


def key_points(vix: dict, score: dict, geo: list[dict], mk: list[dict],
               fg_c: dict | None = None, fg_s: dict | None = None,
               whale: str | None = None) -> list[str]:
    pts = []
    if vix.get("ok"):
        arrow = "مرتفع" if (vix["change"] or 0) > 0 else "منخفض" if (vix["change"] or 0) < 0 else "مستقر"
        pts.append(f"مؤشر الخوف VIX عند {vix['current']} ({vix['label_ar']})، واتجاهه {arrow} اليوم.")
    pts.append(f"تقييم السوق العام اليوم: {score['score']} من 10 — {score['label_ar']}.")
    if fg_s and fg_s.get("ok"):
        pts.append(f"مزاج سوق الأسهم (الخوف/الطمع): {fg_s['value']} — {fg_s['label_ar']}.")
    if fg_c and fg_c.get("ok"):
        pts.append(f"مزاج الكريبتو (الخوف/الطمع): {fg_c['value']} — {fg_c['label_ar']}.")
    if whale:
        pts.append(whale)
    if geo:
        pts.append("أهم حدث سياسي: " + _title_ar(geo[0]))
    if mk:
        pts.append("أهم خبر اقتصادي: " + _title_ar(mk[0]))
    return pts


def whale_signal(quotes: list[dict], stable: dict | None) -> str | None:
    """Implements the user's on-chain rule combining BTC direction with the
    stablecoin reserve trend."""
    if not stable or not stable.get("ok"):
        return None
    btc = next((q for q in quotes
                if q.get("name") == "بيتكوين" and q.get("ok")), None)
    if not btc:
        return None
    if not btc["up"] and stable["rising"]:
        return ("🐋 إشارة: بيتكوين نازل + احتياطي العملات المستقرة يرتفع "
                f"({stable['change_pct']:+.1f}% بالأسبوع) — عادةً الحيتان عم "
                "يجهّزوا للشراء (سيولة جاهزة على الهامش).")
    if btc["up"] and not stable["rising"]:
        return ("⚠️ إشارة: بيتكوين طالع + احتياطي العملات المستقرة ينخفض "
                f"({stable['change_pct']:+.1f}% بالأسبوع) — السيولة عم تُستهلك، "
                "انتبه لاحتمال تباطؤ الزخم.")
    return None


def bottom_line(score: dict) -> str:
    if score["score"] >= 7:
        return ("الزبدة: الأجواء إيجابية نسبياً وشهية المخاطرة مرتفعة — يمكن للأصول "
                "عالية المخاطر أن تؤدّي جيداً، مع مراقبة أي تصعيد مفاجئ.")
    if score["score"] >= 4:
        return ("الزبدة: إشارات مختلطة والسوق في وضع حذر — يُفضّل الترقّب ومتابعة "
                "بيانات التضخّم والفائدة قبل اتخاذ مواقف كبيرة.")
    return ("الزبدة: بيئة متوترة وميل واضح للنفور من المخاطرة — عادةً يتّجه "
            "المستثمرون نحو الأصول الآمنة (الذهب، السندات، الدولار).")


# --------------------------------------------------------------------------- #
# Persistent daily history (saved in the site's records)
# --------------------------------------------------------------------------- #
def get_history() -> list[dict]:
    """Return saved daily snapshots, newest first."""
    try:
        with open(HISTORY_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return sorted(data, key=lambda d: d.get("date", ""), reverse=True)
    except Exception:  # noqa: BLE001
        pass
    return []


def record_history(report: dict) -> None:
    """Upsert today's snapshot into data/history.json (one row per day).

    Keeps a compact summary — not the full news payload — so the history file
    stays small while giving us a daily record + VIX/score table.
    """
    date = report.get("generated_date")
    if not date:
        return
    vix = report.get("vix") or {}
    score = report.get("score") or {}
    fg_s = report.get("fear_greed_stocks") or {}
    fg_c = report.get("fear_greed_crypto") or {}
    snapshot = {
        "date": date,
        "updated_at": report.get("generated_at"),
        "vix": vix.get("current"),
        "vix_label_ar": vix.get("label_ar"),
        "vix_color": vix.get("color"),
        "vix_change": vix.get("change"),
        "score": score.get("score"),
        "score_label_ar": score.get("label_ar"),
        "score_color": score.get("color"),
        "fg_stocks": fg_s.get("value") if fg_s.get("ok") else None,
        "fg_crypto": fg_c.get("value") if fg_c.get("ok") else None,
        "bottom_line": report.get("bottom_line"),
        "news_count": report.get("news_count"),
    }
    with _HISTORY_LOCK:
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            try:
                with open(HISTORY_PATH, encoding="utf-8") as f:
                    rows = json.load(f)
                    if not isinstance(rows, list):
                        rows = []
            except Exception:  # noqa: BLE001
                rows = []
            rows = [r for r in rows if r.get("date") != date]
            rows.append(snapshot)
            rows.sort(key=lambda d: d.get("date", ""))
            rows = rows[-_HISTORY_MAX:]
            tmp = HISTORY_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(rows, f, ensure_ascii=False, indent=2)
            os.replace(tmp, HISTORY_PATH)
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------- #
# Report assembly
# --------------------------------------------------------------------------- #
def build_report(force: bool = False) -> dict:
    now = time.time()
    if not force and _CACHE["data"] and (now - _CACHE["ts"]) < _CACHE_TTL:
        return _CACHE["data"]

    # run all independent network fetches concurrently
    with ThreadPoolExecutor(max_workers=7) as ex:
        f_vix = ex.submit(fetch_vix)
        f_quotes = ex.submit(fetch_markets)
        f_sectors = ex.submit(fetch_sectors)
        f_news = ex.submit(fetch_news, force)
        f_fgc = ex.submit(fetch_fear_greed_crypto)
        f_fgs = ex.submit(fetch_fear_greed_stocks)
        f_stable = ex.submit(fetch_stablecoins)
        vix = f_vix.result()
        quotes = f_quotes.result()
        sectors = f_sectors.result()
        news = f_news.result()
        fg_crypto = f_fgc.result()
        fg_stocks = f_fgs.result()
        stablecoins = f_stable.result()

    geo = [n for n in news if n["category"] == "geopolitics"][:10]
    mk = [n for n in news if n["category"] == "markets"][:10]

    # translate only the displayed headlines (concise Arabic)
    titles = [n["title"] for n in geo] + [n["title"] for n in mk]
    tr = _translate_batch(titles)
    for i, n in enumerate(geo):
        n["title_ar"] = tr[i]
    for j, n in enumerate(mk):
        n["title_ar"] = tr[len(geo) + j]

    news_idx = news_sentiment_index(news)
    # keep the "مزاج السوق" gauge populated even if the live CNN feed is down
    if not fg_stocks.get("ok"):
        fg_stocks = estimate_mood(vix, news_idx)
    score = market_score(vix, news_idx, fg_stocks)
    whale = whale_signal(quotes, stablecoins)
    points = key_points(vix, score, geo, mk, fg_crypto, fg_stocks, whale)
    line = bottom_line(score)

    report = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "generated_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "generated_ts": int(datetime.now(timezone.utc).timestamp()),
        "vix": vix,
        "quotes": quotes,
        "sectors": sectors,
        "score": score,
        "points": points,
        "bottom_line": line,
        "geopolitics": geo,
        "markets": mk,
        "news_count": len(news),
        "fear_greed_crypto": fg_crypto,
        "fear_greed_stocks": fg_stocks,
        "news_sentiment": news_idx,
        "stablecoins": stablecoins,
        "whale_signal": whale,
    }
    _CACHE["data"] = report
    _CACHE["ts"] = now
    record_history(report)
    return report


if __name__ == "__main__":
    import json

    print(json.dumps(build_report(force=True), ensure_ascii=False, indent=2))
