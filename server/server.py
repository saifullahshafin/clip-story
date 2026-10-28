"""Clip Story API. Binds to 127.0.0.1 only; the laptop reaches it through an SSH tunnel.

Every request needs  Authorization: Bearer $CLIPSTORY_TOKEN.
"""
import hmac
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import store
import story

TOKEN = os.environ.get("CLIPSTORY_TOKEN", "")
HOST = os.environ.get("CLIPSTORY_HOST", "127.0.0.1")
PORT = int(os.environ.get("CLIPSTORY_PORT", "8790"))
JOBS = {}


def run_job(period):
    JOBS[period] = {"state": "running", "started": int(time.time() * 1000)}
    try:
        rid = story.build_report(period)
        JOBS[period] = {"state": "done", "report_id": rid, "finished": int(time.time() * 1000)}
    except Exception as e:
        traceback.print_exc()
        JOBS[period] = {"state": "error", "error": str(e)[:300], "finished": int(time.time() * 1000)}


class Handler(BaseHTTPRequestHandler):
    server_version = "ClipStory/1.0"

    def log_message(self, fmt, *args):
        pass  # never log request lines; query strings can hold search terms

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def _authed(self):
        got = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not TOKEN or not hmac.compare_digest(got, TOKEN):
            self._send(401, {"error": "unauthorized"})
            return False
        return True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def _route(self, method):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path.rstrip("/")
        if p == "/api/health":
            return self._send(200, {"ok": True, "time": int(time.time() * 1000)})
        if not self._authed():
            return
        try:
            if method == "GET" and p == "/api/stats":
                return self._send(200, {**store.stats(), "jobs": JOBS, "model": story.MODEL})
            if method == "POST" and p == "/api/clips":
                n = store.upsert_clips(self._body().get("clips", []))
                return self._send(200, {"upserted": n})
            if method == "GET" and p == "/api/clips":
                return self._send(200, {"clips": store.query_clips(q.get("q"), q.get("since"), q.get("until"),
                                                                    q.get("kind"), int(q.get("limit", 200)),
                                                                    ids=q.get("ids", "").split(",") if q.get("ids") else None)})
            if method == "POST" and p == "/api/ask":
                question = (self._body().get("question") or "").strip()
                if not question:
                    return self._send(400, {"error": "question required"})
                return self._send(200, story.ask(question))
            if method == "GET" and p == "/api/loops":
                return self._send(200, {"loops": story.loops()})
            if method == "POST" and p == "/api/loops/done":
                b = self._body()
                done = store.kv_get("loops_done", {})
                if b.get("done", True):
                    done[b["key"]] = int(time.time() * 1000)
                else:
                    done.pop(b["key"], None)
                store.kv_set("loops_done", done)
                return self._send(200, {"ok": True})
            if method == "GET" and p == "/api/vault":
                return self._send(200, {"vault": store.kv_get("vault")})
            if method == "POST" and p == "/api/vault":
                store.kv_set("vault", self._body().get("vault"))
                return self._send(200, {"ok": True})
            if method == "GET" and p == "/api/sessions":
                since = int(q.get("since", 0))
                rows = store.db().execute("SELECT * FROM sessions WHERE start_ts>=? ORDER BY start_ts DESC LIMIT ?",
                                          (since, int(q.get("limit", 100)))).fetchall()
                return self._send(200, {"sessions": [store.row_dict(r) for r in rows]})
            if method == "GET" and p == "/api/reports":
                rows = store.db().execute("SELECT id,period,start_ts,end_ts,created_at,model,data FROM reports ORDER BY created_at DESC LIMIT 50").fetchall()
                return self._send(200, {"reports": [store.row_dict(r) for r in rows]})
            if method == "GET" and p.startswith("/api/reports/"):
                r = store.db().execute("SELECT * FROM reports WHERE id=?", (p.split("/")[-1],)).fetchone()
                return self._send(200 if r else 404, {"report": store.row_dict(r) if r else None})
            if method == "POST" and p == "/api/stories/run":
                period = self._body().get("period", "week")
                if period not in ("day", "week", "month"):
                    return self._send(400, {"error": "period must be day|week|month"})
                if JOBS.get(period, {}).get("state") == "running":
                    return self._send(409, {"error": "already running", "job": JOBS[period]})
                threading.Thread(target=run_job, args=(period,), daemon=True).start()
                return self._send(202, {"started": period})
            return self._send(404, {"error": "not found"})
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"error": str(e)[:300]})

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("CLIPSTORY_TOKEN is not set (see /mnt/data/clip-story/.env)")
    store.db()
    print(f"Clip Story listening on {HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
