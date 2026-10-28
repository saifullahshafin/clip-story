# Clip Story

A clipboard history that never forgets, keeps your passwords one click away, and tells you the story of your week.

Every copy is a clue. You copy a link, then an email, then a password: you were logging in somewhere. You copy a prompt, then code, then an error: you were debugging with an AI. Clip Story links those copies into stories. It flags what you left unfinished, and every week Gemini writes up a report of what you actually did.

## What it does
- **Captures every copy**, from any app, while the browser is open. Copies made in the browser also keep their page URL and title. Each clip records where you later pasted it.
- **Keeps secrets usable and private.** Passwords, API keys and card numbers are detected and encrypted in the browser (RSA-OAEP-3072 + AES-256-GCM) with an automatic device key. Click one and it is copied. The server stores ciphertext only. The AI only ever sees `[PASSWORD hidden, 14 chars] on gmail.com`.
- **Story engine.** Copies are grouped into work sessions. Gemini labels each session (title, story, category, linked chains, open loops) and writes weekly and monthly reports, including password reuse it can spot without ever seeing a password.
- **Ask your clipboard.** "What was the PNR I copied last week?" The AI points to the exact clip, even a hidden password, and your browser decrypts it locally.
- **Login Recall.** Paste an email and password into a site once. Next time, a chip under the login field fills both in one click. Only the exact same origin gets it.
- **Unfinished.** Open loops become a badge count and a checklist.
- **Reopen a story.** Reopen every link from a past session in one click.

## Architecture
```
Browser extension (MV3)                         Your server (any Linux box)
  offscreen.js   polls the system clipboard       server.py   stdlib HTTP API, bearer token, 127.0.0.1 only
  content.js     page context, paste trail,       store.py    SQLite + FTS5, secure_delete
                 Login Recall chip                story.py    sessionize -> redact -> Gemini -> reports
  background.js  classify, encrypt, dedupe,       systemd     weekly + monthly timers
                 60 s hold, sync               <-- SSH tunnel --
  popup / dashboard  search, ask, vault, stories
```

## Setup
1. **Server.** Copy `server/` to a Linux host and create `.env` beside it containing `CLIPSTORY_TOKEN`, `VERTEX_API_KEY`, `CLIPSTORY_MODEL` (default `gemini-3-flash-preview`) and `CLIPSTORY_TZ_OFFSET_MIN`. Run `python3 server.py`. `server/deploy.sh` is a reference deploy over SSH with systemd units.
2. **Tunnel.** Run `ssh -N -L 8790:127.0.0.1:8790 <your-host>`. `tunnel/` has a Windows logon task that keeps it running.
3. **Extension.** Open `chrome://extensions`, turn on Developer mode, click Load unpacked and select `extension/`. Paste the token in Settings.

No third-party Python or JS dependencies.

## Privacy model
- Secret values never leave the browser unencrypted, and are never sent to the AI.
- A second regex redaction pass on the server masks key-like strings before any AI call.
- Dedupe uses an HMAC whose key stays in the browser, so the server cannot brute-force passwords from hashes.
- An optional backup passphrase (PBKDF2, 310k iterations) wraps the device key on the server, so it can be restored in another browser.
