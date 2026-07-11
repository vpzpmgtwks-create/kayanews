"""Market Brief — Flask web app (luxury Arabic daily market report).

Public dashboard — no login. The landing page shows the full live report at a
glance. A background thread keeps the report warm so page loads are instant,
and daily records/history are saved to data/history.json.
"""
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


_refresher_lock = threading.Lock()
_refresher_started = False


def _start_refresher():
    """Start the background refresher exactly once (idempotent)."""
    global _refresher_started
    with _refresher_lock:
        if _refresher_started:
            return
        _refresher_started = True
        t = threading.Thread(target=_refresher, name="mb-refresher", daemon=True)
        t.start()


# Start at import time so the refresher also runs under a production WSGI
# server (gunicorn/waitress), which imports `app` rather than executing
# the __main__ block. Deploy with a single worker so only one refresher runs.
_start_refresher()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=True,
            use_reloader=False, threaded=True)
