"""Render the Market Brief to a single static index.html (for Netlify).

Netlify does not run a live Python/Flask server, so instead of serving the app
we run this at *build time*: it fetches the data once, renders the same Jinja2
template used by the Flask app, and writes a self-contained static page to
`dist/index.html`. Netlify then serves that folder.

The live TradingView VIX chart still works on the static page (it is a
client-side JavaScript widget). News/prices/sentiment reflect the moment the
build ran — schedule a periodic rebuild to keep them fresh (see netlify.toml).
"""
import os
import shutil

from jinja2 import Environment, FileSystemLoader, select_autoescape

import brief

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "dist")


def main() -> None:
    report = brief.build_report(force=True)

    env = Environment(
        loader=FileSystemLoader(os.path.join(HERE, "templates")),
        autoescape=select_autoescape(["html", "xml"]),
    )
    html = env.get_template("index.html").render(r=report, is_static=True)

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, "index.html")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)

    # Copy CSS/JS so the static snapshot keeps its styling (paths are relative
    # to index.html: "static/style.css" and "static/app.js").
    src_static = os.path.join(HERE, "static")
    dst_static = os.path.join(OUT_DIR, "static")
    if os.path.isdir(src_static):
        shutil.copytree(src_static, dst_static, dirs_exist_ok=True)

    print(f"Wrote {out_path} ({len(html)} bytes) — "
          f"score {report['score']['score']}/10, "
          f"{report['news_count']} news items")


if __name__ == "__main__":
    main()
