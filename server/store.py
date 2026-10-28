"""SQLite storage for Clip Story. Plaintext only for non-secret clips; secrets arrive sealed."""
import json
import os
import sqlite3
import threading
import re
import time


def load_env(path):
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\"?([^\"\r\n]*)\"?", line)
        if m:
            os.environ.setdefault(m[1], m[2].strip())


load_env(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

DB_PATH = os.environ.get("CLIPSTORY_DB", "/mnt/data/clip-story/data/clipstory.db")

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA secure_delete=ON;
CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,           -- ms epoch, first copy
  last_seen INTEGER,
  copy_count INTEGER DEFAULT 1,
  kind TEXT,                     -- url,email,password,api_key,otp,card,phone,code,text
  sensitive INTEGER DEFAULT 0,
  text TEXT,                     -- NULL when sensitive
  sealed TEXT,                   -- JSON ciphertext blob when sensitive
  preview TEXT,
  length INTEGER,
  hmac TEXT,                     -- keyed hash, key never leaves the laptop
  url TEXT, title TEXT, domain TEXT,
  source TEXT,                   -- 'page' | 'system'
  pinned INTEGER DEFAULT 0,
  tags TEXT,
  session_id TEXT,
  deleted INTEGER DEFAULT 0,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS clips_ts ON clips(ts);
CREATE INDEX IF NOT EXISTS clips_hmac ON clips(hmac);
CREATE VIRTUAL TABLE IF NOT EXISTS clips_fts USING fts5(id UNINDEXED, body);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, start_ts INTEGER, end_ts INTEGER, clip_ids TEXT,
  title TEXT, story TEXT, category TEXT, importance INTEGER,
  open_loops TEXT, entities TEXT, chains TEXT, fingerprint TEXT, model TEXT, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, period TEXT, start_ts INTEGER, end_ts INTEGER,
  created_at INTEGER, markdown TEXT, data TEXT, model TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
"""

_lock = threading.Lock()


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.executescript(SCHEMA)
    cols = {r["name"] for r in c.execute("PRAGMA table_info(clips)")}
    if "uses" not in cols:
        c.execute("ALTER TABLE clips ADD COLUMN uses TEXT")  # JSON [{domain, ts}] where the clip was pasted
    return c


_conn = None


def db():
    global _conn
    if _conn is None:
        _conn = connect()
    return _conn


def _fts_body(row):
    # Secrets are searchable only by where they were copied, never by value.
    parts = [row.get("title") or "", row.get("domain") or "", row.get("url") or "", row.get("kind") or ""]
    if not row.get("sensitive"):
        parts.insert(0, row.get("text") or "")
    return " ".join(parts)


FIELDS = ["id", "ts", "last_seen", "copy_count", "kind", "sensitive", "text", "sealed", "preview",
          "length", "hmac", "url", "title", "domain", "source", "pinned", "tags", "uses", "deleted"]


def upsert_clips(clips):
    now = int(time.time() * 1000)
    n = 0
    with _lock:
        c = db()
        for raw in clips:
            row = {f: raw.get(f) for f in FIELDS}
            if not row["id"] or not row["ts"]:
                continue
            row["sensitive"] = 1 if row["sensitive"] else 0
            if row["sensitive"]:
                row["text"] = None  # hard guarantee: plaintext of a secret is never stored here
            for k in ("sealed", "tags", "uses"):
                if row[k] is not None and not isinstance(row[k], str):
                    row[k] = json.dumps(row[k])
            row["pinned"] = 1 if row["pinned"] else 0
            row["deleted"] = 1 if row["deleted"] else 0
            row["updated_at"] = now
            cols = list(row.keys())
            c.execute(
                f"INSERT INTO clips ({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) "
                f"ON CONFLICT(id) DO UPDATE SET {','.join(f'{k}=excluded.{k}' for k in cols if k != 'id')}",
                [row[k] for k in cols],
            )
            c.execute("DELETE FROM clips_fts WHERE id=?", (row["id"],))
            if not row["deleted"]:
                c.execute("INSERT INTO clips_fts (id, body) VALUES (?,?)", (row["id"], _fts_body(row)))
            n += 1
        c.commit()
    return n


def row_dict(r):
    d = dict(r)
    for k in ("sealed", "tags", "uses", "clip_ids", "open_loops", "entities", "chains", "data"):
        if k in d and isinstance(d[k], str) and d[k][:1] in "[{":
            try:
                d[k] = json.loads(d[k])
            except ValueError:
                pass
    return d


def query_clips(q=None, since=None, until=None, kind=None, limit=200, ids=None):
    sql = "SELECT c.* FROM clips c"
    args = []
    where = ["c.deleted=0"]
    if q:
        sql += " JOIN clips_fts f ON f.id=c.id"
        where.append("clips_fts MATCH ?")
        args.append(" ".join('"' + t.replace('"', "") + '"*' for t in q.split() if t.strip()))
    if since:
        where.append("c.ts>=?"); args.append(int(since))
    if until:
        where.append("c.ts<?"); args.append(int(until))
    if kind:
        where.append("c.kind=?"); args.append(kind)
    if ids:
        where.append(f"c.id IN ({','.join('?' * len(ids))})"); args.extend(ids)
    sql += " WHERE " + " AND ".join(where) + " ORDER BY c.ts DESC LIMIT ?"
    args.append(int(limit))
    return [row_dict(r) for r in db().execute(sql, args)]


def kv_get(k, default=None):
    r = db().execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
    return json.loads(r["v"]) if r else default


def kv_set(k, v):
    with _lock:
        db().execute("INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, json.dumps(v)))
        db().commit()


def stats():
    c = db()
    total = c.execute("SELECT COUNT(*) n FROM clips WHERE deleted=0").fetchone()["n"]
    secrets = c.execute("SELECT COUNT(*) n FROM clips WHERE deleted=0 AND sensitive=1").fetchone()["n"]
    stories = c.execute("SELECT COUNT(*) n FROM sessions WHERE title IS NOT NULL").fetchone()["n"]
    reports = c.execute("SELECT COUNT(*) n FROM reports").fetchone()["n"]
    return {"clips": total, "secrets": secrets, "stories": stories, "reports": reports}
