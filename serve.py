#!/usr/bin/env python3
"""Serve fingod on http://localhost:8000. No dependencies, no build step.

fingod is a static web app: this is only a file server, so the browser can load
the WebAssembly SQLite and your agent's files. It adds one thing — a listing of
data/ at /data/manifest.json — so the app can import whatever your coding agent
drops there. Everything is bound to localhost.

    python3 serve.py            # port 8000, and opens your browser
    python3 serve.py 9000       # another port
    python3 serve.py --no-open  # don't open a browser

You don't need this file: `python3 -m http.server 8000 --bind 127.0.0.1` also works, and runs nothing
from this repo. The app reads data/ from the directory listings in that case.
"""
import http.server, json, os, socketserver, sys, mimetypes, threading, webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
PORT = int(ARGS[0]) if ARGS else 8000
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")


def manifest():
    files = []
    for base, _, names in os.walk(DATA):
        for n in names:
            full = os.path.join(base, n)
            rel = os.path.relpath(full, DATA).replace(os.sep, "/")
            if n.startswith(".") or not n.endswith(".json") or rel == "manifest.json":
                continue
            st = os.stat(full)
            files.append({"path": rel, "size": st.st_size, "mtime": int(st.st_mtime)})
    return {"files": sorted(files, key=lambda f: f["path"])}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        if self.path.split("?")[0] == "/data/manifest.json":
            body = json.dumps(manifest()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always the latest files while developing
        super().end_headers()

    def log_message(self, fmt, *args):
        if "manifest.json" not in (args[0] if args else ""):  # the app polls it every few seconds
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128  # a browser asks for every ES module at once


if __name__ == "__main__":
    os.makedirs(os.path.join(DATA, "checkpoints"), exist_ok=True)
    os.makedirs(os.path.join(DATA, "transactions"), exist_ok=True)
    with Server(("127.0.0.1", PORT), Handler) as srv:
        url = f"http://localhost:{PORT}"
        print(f"fingod → {url}   (watching {os.path.relpath(DATA)}/, Ctrl-C to stop)")
        if "--no-open" not in sys.argv:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print()
