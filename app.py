"""Market Brief — Flask web app (luxury Arabic daily market report).

Features:
- Login gate (password 1111) via server-side session.
- Live dashboard that auto-refreshes news + indicators every minute.
- A background thread keeps the report warm so page loads are instant.
- Daily records/history saved to data/history.json (see brief.record_history).
"""
import os
import threading
import time
from functools import wraps

from flask import (Flask, jsonify, redirect, render_template, request,
                   session, url_for)
from werkzeug.middleware.proxy_fix import ProxyFix

import brief

app = Flask(__name__)
# Session signing key. Override in production via env var; a stable dev default
# keeps you logged in across restarts locally.
app.secret_key = os.environ.get("MB_SECRET_KEY", "market-brief-gold-2026-secret")

# Entry password and refresh cadence are overridable via env so a public
# deploy can use a stronger secret without editing code.
PASSWORD = os.environ.get("MB_PASSWORD", "1111")
REFRESH_SECONDS = int(os.environ.get("MB_REFRESH_SECONDS", "60"))

# Production hardening: set MB_ENV=production on the host to force HTTPS-only
# cookies and trust the platform's X-Forwarded-* proxy headers.
IS_PROD = os.environ.get("MB_ENV", "").lower() == "production"
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=IS_PROD,
    PREFERRED_URL_SCHEME="https" if IS_PROD else "http",
)
if IS_PROD:
    # Render / Railway / Fly terminate TLS at a proxy and forward plain HTTP;
    # trust one hop so request.is_secure and url_for(_external) see https.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("auth"):
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        if request.form.get("password", "") == PASSWORD:
            session["auth"] = True
            session.permanent = True
            dest = request.args.get("next") or url_for("index")
            return redirect(dest)
        error = "كلمة السر غير صحيحة"
    if session.get("auth"):
        return redirect(url_for("index"))
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# --------------------------------------------------------------------------- #
# Pages
# --------------------------------------------------------------------------- #
@app.route("/")
@login_required
def index():
    report = brief.build_report(force=request.args.get("refresh") == "1")
    return render_template("index.html", r=report,
                           refresh_seconds=REFRESH_SECONDS)


@app.route("/api/report")
@login_required
def api_report():
    report = brief.build_report(force=request.args.get("refresh") == "1")
    return jsonify(report)


@app.route("/history")
@login_required
def history():
    return render_template("history.html", rows=brief.get_history())


@app.route("/api/history")
@login_required
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
