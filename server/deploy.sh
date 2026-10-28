#!/usr/bin/env bash
# Deploy Clip Story server to Hunter-A1-Flex (/mnt/data/clip-story only). Run from Git Bash on the laptop.
# Secrets are piped over ssh stdin, never printed or written on the laptop outside C:\Users\HP\.env.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ARM=Hunter-A1-Flex
ROOT=/mnt/data/clip-story
SSH="ssh -o BatchMode=yes $ARM"

$SSH -n "mkdir -p $ROOT/server $ROOT/data $ROOT/logs && chmod 700 $ROOT $ROOT/data"
scp -q "$HERE/store.py" "$HERE/story.py" "$HERE/server.py" "$ARM:$ROOT/server/"

# Create .env on ARM once (keeps the existing token on redeploy).
python - <<'PY' | $SSH "test -f $ROOT/.env && cat >/dev/null || (umask 077; cat > $ROOT/.env)"
import re, secrets
env = {}
for p in (r"C:\Users\HP\.env", r"C:\Users\HP\.gemini\.env"):
    try:
        for l in open(p, encoding="utf-8"):
            m = re.match(r'\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?', l)
            if m: env.setdefault(m[1], m[2].strip())
    except OSError: pass
print(f"CLIPSTORY_TOKEN={secrets.token_urlsafe(32)}")
print(f"VERTEX_API_KEY={env.get('VERTEX_API_KEY') or env.get('GEMINI_API_KEY')}")
print("CLIPSTORY_MODEL=gemini-3-flash-preview")
print("CLIPSTORY_FALLBACK_MODEL=gemini-2.5-flash")
print("CLIPSTORY_TZ_OFFSET_MIN=360")
PY
# Windows python writes CRLF; systemd and sh would keep the \r inside values.
$SSH -n "sed -i 's/\r\$//' $ROOT/.env"

$SSH "sudo tee /etc/systemd/system/clipstory.service >/dev/null" <<EOF
[Unit]
Description=Clip Story API (loopback only)
After=network-online.target
[Service]
User=ubuntu
WorkingDirectory=$ROOT/server
EnvironmentFile=$ROOT/.env
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/usr/bin/python3 $ROOT/server/server.py
Restart=always
RestartSec=5
StandardOutput=append:$ROOT/logs/server.log
StandardError=append:$ROOT/logs/server.log
[Install]
WantedBy=multi-user.target
EOF

for P in week month; do
$SSH "sudo tee /etc/systemd/system/clipstory-$P.service >/dev/null" <<EOF
[Unit]
Description=Clip Story $P report
[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=$ROOT/server
EnvironmentFile=$ROOT/.env
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/usr/bin/python3 $ROOT/server/story.py $P
StandardOutput=append:$ROOT/logs/story.log
StandardError=append:$ROOT/logs/story.log
EOF
done
# Sunday 21:00 Dhaka = Sunday 15:00 UTC. Monthly: 1st of month 15:30 UTC.
$SSH "sudo tee /etc/systemd/system/clipstory-week.timer >/dev/null" <<EOF
[Unit]
Description=Weekly Clip Story report
[Timer]
OnCalendar=Sun *-*-* 15:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
EOF
$SSH "sudo tee /etc/systemd/system/clipstory-month.timer >/dev/null" <<EOF
[Unit]
Description=Monthly Clip Story report
[Timer]
OnCalendar=*-*-01 15:30:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
EOF

$SSH -n "sudo systemctl daemon-reload && sudo systemctl enable --now clipstory.service clipstory-week.timer clipstory-month.timer && sudo systemctl restart clipstory.service && sleep 2 && systemctl is-active clipstory.service && curl -s http://127.0.0.1:8790/api/health"
echo
echo "Deployed. Token lives in $ARM:$ROOT/.env (CLIPSTORY_TOKEN)."
