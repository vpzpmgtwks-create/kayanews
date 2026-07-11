"""Production entry point using Waitress (pure-Python, cross-platform).

Use this on Windows, a VPS, or any host where gunicorn is not available:

    set MB_ENV=production
    set MB_SECRET_KEY=<a long random string>
    set MB_PASSWORD=<your strong password>
    python serve.py

Importing `app` starts the single background refresher thread (see app.py).
Waitress runs one process, so exactly one refresher stays warm — which is the
correct topology for this app's in-memory cache. The listen port comes from the
PORT env var (set by most hosts) and defaults to 8000 locally.
"""
import os

from waitress import serve

from app import app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Market Brief — serving on http://0.0.0.0:{port} (waitress)")
    serve(app, host="0.0.0.0", port=port, threads=8)
