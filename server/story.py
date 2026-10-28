"""Story engine: sessionize clips, redact, ask Gemini to connect them, write weekly/monthly reports.

Run directly for the scheduled job:  python3 story.py week|month|day
"""
import collections
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import urllib.request

import store

MODEL = os.environ.get("CLIPSTORY_MODEL", "gemini-3-flash-preview")
FALLBACK_MODEL = os.environ.get("CLIPSTORY_FALLBACK_MODEL", "gemini-2.5-flash")
SESSION_GAP_MS = int(os.environ.get("CLIPSTORY_SESSION_GAP_MIN", "10")) * 60_000
TZ = dt.timezone(dt.timedelta(minutes=int(os.environ.get("CLIPSTORY_TZ_OFFSET_MIN", "360"))))  # Asia/Dhaka
SESSIONS_PER_CALL = 12
MAX_CLIP_CHARS = 400

# Second line of defence: anything that still looks like a credential is masked before it leaves ARM.
REDACTIONS = [
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{10,}"), "[ANTHROPIC_KEY]"),
    (re.compile(r"sk-[A-Za-z0-9_\-]{16,}"), "[API_KEY]"),
    (re.compile(r"AIza[0-9A-Za-z_\-]{30,}"), "[GOOGLE_KEY]"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "[GITHUB_TOKEN]"),
    (re.compile(r"hf_[A-Za-z0-9]{20,}"), "[HF_TOKEN]"),
    (re.compile(r"xox[abpr]-[A-Za-z0-9\-]{10,}"), "[SLACK_TOKEN]"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "[AWS_KEY]"),
    (re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"), "[JWT]"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[PRIVATE_KEY]"),
    (re.compile(r"\b(?:\d[ -]?){13,19}\b"), "[CARD_OR_LONG_NUMBER]"),
    (re.compile(r"(?i)(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+"), r"\1=[REDACTED]"),
]


def redact(s):
    for rx, rep in REDACTIONS:
        s = rx.sub(rep, s)
    return s


def fmt_time(ms):
    return dt.datetime.fromtimestamp(ms / 1000, TZ).strftime("%a %d %b %H:%M")


def clip_line(c):
    t = fmt_time(c["ts"])[-5:]
    where = f" on {c['domain']}" if c.get("domain") else " (outside browser)"
    page = f" | page: \"{(c.get('title') or '')[:80]}\"" if c.get("title") else ""
    rep = f" (copied {c['copy_count']}x)" if (c.get("copy_count") or 1) > 1 else ""
    uses = c.get("uses") or []
    if isinstance(uses, str):
        uses = json.loads(uses or "[]")
    if uses:
        rep += " -> pasted on " + ", ".join(sorted({u.get("domain") or "?" for u in uses}))
    if c.get("sensitive"):
        body = f"[{(c.get('kind') or 'secret').upper()} hidden, {c.get('length') or '?'} chars]"
    else:
        txt = (c.get("text") or "").replace("\n", " \\n ")
        if len(txt) > MAX_CLIP_CHARS:
            txt = txt[:MAX_CLIP_CHARS] + f"... (+{len(txt) - MAX_CLIP_CHARS} chars)"
        body = redact(txt)
    return f"  #{c['id'][:8]} {t} [{c.get('kind') or 'text'}]{where}{page}{rep}: {body}"


def sessionize(clips):
    clips = sorted(clips, key=lambda c: c["ts"])
    sessions, cur = [], []
    for c in clips:
        if cur and c["ts"] - cur[-1]["ts"] > SESSION_GAP_MS:
            sessions.append(cur); cur = []
        cur.append(c)
    if cur:
        sessions.append(cur)
    out = []
    for s in sessions:
        ids = [c["id"] for c in s]
        out.append({
            "id": "s_" + hashlib.sha1(ids[0].encode()).hexdigest()[:12],
            "start_ts": s[0]["ts"], "end_ts": s[-1]["ts"], "clips": s, "clip_ids": ids,
            "fingerprint": hashlib.sha1("|".join(ids).encode()).hexdigest(),
        })
    return out


def _api_key():
    return os.environ.get("VERTEX_API_KEY") or os.environ.get("GEMINI_API_KEY")


def gemini(prompt, json_mode=True, model=None):
    model = model or MODEL
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.4},
    }
    if json_mode:
        body["generationConfig"]["responseMimeType"] = "application/json"
    # Key goes in a header, never the URL, so it can't leak through error messages or logs.
    url = f"https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:generateContent"
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "x-goog-api-key": _api_key()})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=180))
    except Exception as e:
        if model != FALLBACK_MODEL:
            return gemini(prompt, json_mode, FALLBACK_MODEL)
        raise RuntimeError(f"Gemini call failed ({model}): {type(e).__name__} {getattr(e, 'code', '')}") from None
    text = "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"])
    return (json.loads(text) if json_mode else text), model


SESSION_PROMPT = """You analyse someone's clipboard history to reconstruct the STORY behind it.
People copy things in sequences that belong together: a website link, then an email, then a password
means they were logging in; a prompt, then code, then an error means they were debugging with an AI;
an address then a phone number means they were filling a form or contacting someone.
Some copies are unrelated noise. Secrets are hidden as [PASSWORD hidden] etc. Never guess their values.

For EACH session below, work out what the person was doing. Link clips that belong to the same thread
(a session can hold more than one thread). Note "open loops": things that look started but not finished
(copied a tracking number, an invoice, a meeting link, a TODO, an unanswered question, a login with no
password copied yet).

Return JSON: {{"sessions": [{{
  "id": "<session id>",
  "title": "<= 8 words, specific, e.g. 'Logged into Gmail with second account'",
  "story": "2-3 sentences, plain English, second person ('You...')",
  "category": one of ["login","research","coding","ai-prompting","writing","shopping","travel","finance","communication","work-admin","media","other"],
  "importance": 1-5,
  "chains": [{{"label": "<short>", "clip_ids": ["#abcd1234", ...]}}],
  "open_loops": ["<short actionable reminder>", ...],
  "entities": ["<sites, accounts, people, projects mentioned>"]
}}]}}

SESSIONS:
{body}
"""


def label_sessions(sessions, force=False):
    c = store.db()
    todo = []
    for s in sessions:
        old = c.execute("SELECT fingerprint, title FROM sessions WHERE id=?", (s["id"],)).fetchone()
        if force or not old or old["fingerprint"] != s["fingerprint"] or not old["title"]:
            todo.append(s)
    labelled = 0
    for i in range(0, len(todo), SESSIONS_PER_CALL):
        batch = todo[i:i + SESSIONS_PER_CALL]
        body = "\n\n".join(
            f"SESSION {s['id']} ({fmt_time(s['start_ts'])} to {fmt_time(s['end_ts'])[-5:]}, {len(s['clips'])} copies)\n"
            + "\n".join(clip_line(x) for x in s["clips"])
            for s in batch
        )
        result, model = gemini(SESSION_PROMPT.format(body=body))
        by_id = {r.get("id"): r for r in result.get("sessions", [])}
        now = int(time.time() * 1000)
        with store._lock:
            for s in batch:
                r = by_id.get(s["id"], {})
                prefix_map = {x["id"][:8]: x["id"] for x in s["clips"]}
                chains = [{"label": ch.get("label"),
                           "clip_ids": [prefix_map.get(cid.lstrip("#")[:8]) for cid in ch.get("clip_ids", [])
                                        if prefix_map.get(cid.lstrip("#")[:8])]}
                          for ch in r.get("chains", [])]
                c.execute(
                    "INSERT INTO sessions (id,start_ts,end_ts,clip_ids,title,story,category,importance,open_loops,entities,chains,fingerprint,model,updated_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET start_ts=excluded.start_ts,end_ts=excluded.end_ts,"
                    "clip_ids=excluded.clip_ids,title=excluded.title,story=excluded.story,category=excluded.category,importance=excluded.importance,"
                    "open_loops=excluded.open_loops,entities=excluded.entities,chains=excluded.chains,fingerprint=excluded.fingerprint,model=excluded.model,updated_at=excluded.updated_at",
                    (s["id"], s["start_ts"], s["end_ts"], json.dumps(s["clip_ids"]), r.get("title"), r.get("story"),
                     r.get("category"), r.get("importance"), json.dumps(r.get("open_loops", [])),
                     json.dumps(r.get("entities", [])), json.dumps(chains), s["fingerprint"], model, now))
                for cid in s["clip_ids"]:
                    c.execute("UPDATE clips SET session_id=? WHERE id=?", (s["id"], cid))
            c.commit()
        labelled += len(batch)
    return labelled


def period_bounds(period, ref=None):
    now = ref or dt.datetime.now(TZ)
    if period == "day":
        start = now - dt.timedelta(days=1)
    elif period == "month":
        start = now - dt.timedelta(days=30)
    else:
        start = now - dt.timedelta(days=7)
    return int(start.timestamp() * 1000), int(now.timestamp() * 1000)


def deterministic_stats(clips):
    kinds = collections.Counter(c.get("kind") or "text" for c in clips)
    domains = collections.Counter(c.get("domain") for c in clips if c.get("domain"))
    hours = collections.Counter(dt.datetime.fromtimestamp(c["ts"] / 1000, TZ).hour for c in clips)
    repeated = [c for c in clips if not c.get("sensitive") and (c.get("copy_count") or 1) >= 3]
    # Password reuse: same keyed hash seen on different sites. ARM never learns the password itself.
    by_hmac = collections.defaultdict(set)
    for c in store.query_clips(kind=None, limit=100000):
        if c.get("sensitive") and c.get("kind") == "password" and c.get("hmac") and c.get("domain"):
            by_hmac[c["hmac"]].add(c["domain"])
    reuse = [sorted(d) for d in by_hmac.values() if len(d) > 1]
    return {
        "total": len(clips),
        "secrets": sum(1 for c in clips if c.get("sensitive")),
        "kinds": kinds.most_common(),
        "top_domains": domains.most_common(10),
        "busiest_hours": sorted(hours.most_common(3)),
        "repeated": [{"id": c["id"], "preview": redact((c.get("text") or "")[:80]), "count": c["copy_count"]} for c in
                     sorted(repeated, key=lambda c: -c["copy_count"])[:8]],
        "password_reuse": reuse,
    }


REPORT_PROMPT = """You are writing someone's {period_name} clipboard intelligence report. It turns what they
copied into a clear account of what they did, what they might forget, and what they could improve.
The reader is the person themselves. Write warmly but plainly. No emojis. No hype.

Period: {start} to {end}
Deterministic stats (exact, trust these): {stats}

Stories found in this period (one per work session, AI-labelled):
{stories}
{previous}
Write a Markdown report with these sections (skip a section only if it is truly empty):
# <a specific headline for the {period_name}>
## The {period_name} in one paragraph
## Main threads  (group related stories into 3-6 threads: what you were working toward)
## Accounts and logins  (sites logged into; say where the hidden credential is, never a value)
## Open loops  (a checklist "- [ ]" of things that look unfinished; most important first)
## Patterns  (when you work, what you copy most, repeated copies worth saving as snippets)
## Security notes  (password reuse across sites, secrets copied outside the vault, risky habits)
## Suggestions for next {period_name}  (3-5 concrete, specific to this data)

Return JSON: {{"markdown": "<the report>", "headline": "<headline>", "open_loops": ["..."], "threads": [{{"name": "...", "story_ids": ["..."]}}]}}
"""


def build_report(period="week"):
    start, end = period_bounds(period)
    clips = list(reversed(store.query_clips(since=start, until=end, limit=100000)))
    if not clips:
        return None
    sessions = sessionize(clips)
    label_sessions(sessions)
    rows = store.db().execute("SELECT * FROM sessions WHERE start_ts>=? AND start_ts<? ORDER BY start_ts",
                              (start, end)).fetchall()
    stories = "\n".join(
        f"- [{r['id']}] {fmt_time(r['start_ts'])} | {r['category']} | importance {r['importance']} | {r['title']}: {r['story']}"
        f" | open loops: {r['open_loops']}"
        for r in rows)
    previous = ""
    if period == "month":
        weeks = store.db().execute("SELECT markdown FROM reports WHERE period='week' AND created_at>=? ORDER BY created_at",
                                   (start,)).fetchall()
        if weeks:
            previous = "\nWeekly reports already written this month (build on them, do not repeat them):\n" + \
                       "\n---\n".join(w["markdown"][:3000] for w in weeks) + "\n"
    stats = deterministic_stats(clips)
    names = {"day": "day", "week": "week", "month": "month"}
    result, model = gemini(REPORT_PROMPT.format(period_name=names[period], start=fmt_time(start), end=fmt_time(end),
                                                stats=json.dumps(stats), stories=stories, previous=previous))
    rid = f"r_{period}_{dt.datetime.now(TZ).strftime('%Y%m%d_%H%M')}"
    data = {"stats": stats, "headline": result.get("headline"), "open_loops": result.get("open_loops", []),
            "threads": result.get("threads", []), "session_ids": [r["id"] for r in rows]}
    with store._lock:
        store.db().execute("INSERT OR REPLACE INTO reports (id,period,start_ts,end_ts,created_at,markdown,data,model) VALUES (?,?,?,?,?,?,?,?)",
                           (rid, period, start, end, int(time.time() * 1000), result.get("markdown", ""), json.dumps(data), model))
        store.db().commit()
    return rid


if __name__ == "__main__":
    period = sys.argv[1] if len(sys.argv) > 1 else "week"
    rid = build_report(period)
    print("report:", rid or "no clips in period")


ASK_PROMPT = """You are the memory of someone's clipboard. Answer their question using ONLY the clips and
stories below. Secrets appear as [PASSWORD hidden] etc: you cannot see them, but you CAN point to them by id,
and the person's browser will reveal them locally. Prefer pointing to the exact clip(s) that answer.
In the answer text never write clip ids; for a hidden secret say "the password (shown below)" and list its id in clip_ids.
If nothing matches, say so plainly. Keep the answer to 1-3 sentences. No emojis.

Question: {question}

Stories (most recent first):
{stories}

Clips (most recent first, id shown as #xxxxxxxx):
{clips}

Return JSON: {{"answer": "...", "clip_ids": ["#xxxxxxxx", ...]}}
"""


def ask(question, days=120, max_clips=900):
    since = int((time.time() - days * 86400) * 1000)
    clips = store.query_clips(since=since, limit=max_clips)
    # Keyword hits from full history first, so old clips are still findable.
    words = [w for w in re.findall(r"\w{3,}", question.lower())][:6]
    hits = []
    for w in words:
        try:
            hits += store.query_clips(q=w, limit=40)
        except Exception:
            pass
    seen, ordered = set(), []
    for c in hits + clips:
        if c["id"] not in seen:
            seen.add(c["id"]); ordered.append(c)
    rows = store.db().execute("SELECT start_ts,title,story,open_loops FROM sessions WHERE start_ts>=? ORDER BY start_ts DESC LIMIT 80",
                              (since,)).fetchall()
    stories = "\n".join(f"- {fmt_time(r['start_ts'])}: {r['title']}: {r['story']}" for r in rows)
    result, model = gemini(ASK_PROMPT.format(question=question[:500], stories=stories or "(none yet)",
                                             clips="\n".join(clip_line(c) for c in ordered[:max_clips])))
    prefix = {c["id"][:8]: c["id"] for c in ordered}
    ids = [prefix[x.lstrip("#")[:8]] for x in result.get("clip_ids", []) if prefix.get(x.lstrip("#")[:8])]
    return {"answer": result.get("answer", ""), "clip_ids": ids, "model": model}


def loops(days=21):
    since = int((time.time() - days * 86400) * 1000)
    done = store.kv_get("loops_done", {})
    out = []
    for r in store.db().execute("SELECT id,start_ts,title,open_loops FROM sessions WHERE start_ts>=? ORDER BY start_ts DESC", (since,)):
        for i, text in enumerate(json.loads(r["open_loops"] or "[]")):
            key = f"{r['id']}:{i}"
            out.append({"key": key, "text": text, "session": r["title"], "ts": r["start_ts"], "done": key in done})
    return out
