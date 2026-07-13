"""Market Brief — Flask web app (luxury Arabic daily market report).

Public dashboard — no login. The landing page shows the full live report at a
glance. A background thread keeps the report warm so page loads are instant,
and daily records/history are saved to data/history.json.
"""
import datetime
import os
import threading
import time

from flask import Flask, jsonify, render_template, request
from werkzeug.middleware.proxy_fix import ProxyFix

import brief

app = Flask(__name__)

REFRESH_SECONDS = int(os.environ.get("MB_REFRESH_SECONDS", "60"))

# Production hardening: set MB_ENV=production on the host to trust the
# platform's X-Forwarded-* proxy headers (correct scheme/host in redirects).
IS_PROD = os.environ.get("MB_ENV", "").lower() == "production"
if IS_PROD:
    # Render / Railway / Fly terminate TLS at a proxy and forward plain HTTP.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


# --------------------------------------------------------------------------- #
# Pages  (public — no auth)
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    report = brief.build_report(force=request.args.get("refresh") == "1")
    return render_template("index.html", r=report,
                           refresh_seconds=REFRESH_SECONDS)


@app.route("/api/report")
def api_report():
    report = brief.build_report(force=request.args.get("refresh") == "1")
    return jsonify(report)


@app.route("/history")
def history():
    return render_template("history.html", rows=brief.get_history())


@app.route("/api/history")
def api_history():
    return jsonify(brief.get_history())


@app.route("/telegram")
def telegram_page():
    report = brief.build_report()
    send_hour = int(os.environ.get("TELEGRAM_SEND_HOUR", "9"))
    now = datetime.datetime.now()
    next_send = now.replace(hour=send_hour, minute=0, second=0, microsecond=0)
    if next_send <= now:
        next_send += datetime.timedelta(days=1)
    status = {
        "configured": bool(brief.TELEGRAM_TOKEN and brief.TELEGRAM_CHAT_ID),
        "token_set": bool(brief.TELEGRAM_TOKEN),
        "chat_id": brief.TELEGRAM_CHAT_ID or "",
        "send_hour": send_hour,
        "next_send": next_send.strftime("%Y-%m-%d %H:%M"),
        "log": brief.get_telegram_log()[:20],
    }
    return render_template("telegram.html", status=status, r=report)


@app.route("/api/telegram/send", methods=["POST"])
def telegram_send_now():
    report = brief.build_report()
    ok = brief.send_telegram_report(report)
    return jsonify({
        "ok": ok,
        "message": "✅ تم الإرسال بنجاح!" if ok else "❌ فشل الإرسال — تحقق من الإعدادات",
    })


@app.route("/api/telegram/find-chats", methods=["POST"])
def telegram_find_chats():
    """Given a bot token, return all chats the bot has seen via getUpdates."""
    import requests as _req
    data = request.get_json(silent=True) or {}
    token = (data.get("token") or "").strip()
    if not token:
        return jsonify({"ok": False, "error": "أدخل التوكن أولاً"})
    try:
        # Validate token + get bot info
        me = _req.get(
            f"https://api.telegram.org/bot{token}/getMe", timeout=8
        ).json()
        if not me.get("ok"):
            return jsonify({"ok": False, "error": "التوكن غير صحيح — تحقق منه"})
        bot_name = me["result"].get("first_name", "")

        # Pull recent updates to find chats
        upd = _req.get(
            f"https://api.telegram.org/bot{token}/getUpdates",
            params={"limit": 100}, timeout=10
        ).json()

        chats = {}
        for u in (upd.get("result") or []):
            for key in ("message", "my_chat_member", "chat_member"):
                msg = u.get(key)
                if msg:
                    chat = msg.get("chat", {})
                    cid = chat.get("id")
                    if cid and cid not in chats:
                        chats[cid] = {
                            "id": cid,
                            "title": chat.get("title") or chat.get("username") or str(cid),
                            "type": chat.get("type", ""),
                        }

        return jsonify({
            "ok": True,
            "bot_name": bot_name,
            "chats": list(chats.values()),
        })
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(e)[:120]})


# --------------------------------------------------------------------------- #
# Background refresher — keeps data fresh even if nobody is polling
# --------------------------------------------------------------------------- #
def _refresher():
    while True:
        try:
            brief.build_report(force=True)
        except Exception:  # noqa: BLE001
            pass
        time.sleep(REFRESH_SECONDS)


def _daily_telegram_sender():
    """Send the daily market report to Telegram at TELEGRAM_SEND_HOUR (default 9 AM).

    Checks once per minute; sends once per calendar day when the hour matches.
    Set TELEGRAM_SEND_HOUR=HH (0-23, local server time) to change the send time.
    """
    send_hour = int(os.environ.get("TELEGRAM_SEND_HOUR", "9"))
    last_sent: datetime.date | None = None
    while True:
        try:
            now = datetime.datetime.now()
            if now.hour == send_hour and now.date() != last_sent:
                report = brief.build_report()
                if brief.send_telegram_report(report):
                    last_sent = now.date()
        except Exception:  # noqa: BLE001
            pass
        time.sleep(60)


_refresher_lock = threading.Lock()
_refresher_started = False


def _start_refresher():
    """Start background workers exactly once (idempotent)."""
    global _refresher_started
    with _refresher_lock:
        if _refresher_started:
            return
        _refresher_started = True
        t = threading.Thread(target=_refresher, name="mb-refresher", daemon=True)
        t.start()
        if brief.TELEGRAM_TOKEN and brief.TELEGRAM_CHAT_ID:
            tg = threading.Thread(target=_daily_telegram_sender,
                                  name="mb-telegram", daemon=True)
            tg.start()


# Start at import time so the refresher also runs under a production WSGI
# server (gunicorn/waitress), which imports `app` rather than executing
# the __main__ block. Deploy with a single worker so only one refresher runs.
_start_refresher()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=True,
            use_reloader=False, threaded=True)
