#!/bin/bash
# Installs laptop-remote for the current user. Run it as yourself (not with
# sudo); it asks for your password once for the two root-owned pieces.
set -euo pipefail

cd "$(dirname "$0")"
REPO_DIR="$(pwd)"
USER_NAME="$(id -un)"

HELPER_DEST=/usr/local/libexec/laptop-remote-helper
SUDOERS_FILE=/etc/sudoers.d/laptop-remote
LABEL=io.github.laptop-remote
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/laptop-remote.log"

if [[ $EUID -eq 0 ]]; then
  echo "Run ./install.sh as your normal user, not with sudo." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]] || ! "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "Node.js 24 or newer is required (brew install node)." >&2
  exit 1
fi

echo "==> Building the helper"
mkdir -p build
clang -O2 -Wall -Wextra -framework IOKit -o build/laptop-remote-helper helper/laptop-remote-helper.c

echo "==> Installing the helper and its sudo rule (asks for your password)"
# The helper must be root-owned in a root-owned directory, or the sudo rule
# would let anyone who can write the file run arbitrary code as root.
sudo install -d -o root -g wheel -m 755 /usr/local/libexec
sudo install -o root -g wheel -m 755 build/laptop-remote-helper "$HELPER_DEST"
SUDOERS_TMP="$(mktemp)"
echo "$USER_NAME ALL=(root) NOPASSWD: $HELPER_DEST" > "$SUDOERS_TMP"
sudo visudo -cf "$SUDOERS_TMP" >/dev/null
sudo install -o root -g wheel -m 440 "$SUDOERS_TMP" "$SUDOERS_FILE"
rm -f "$SUDOERS_TMP"

echo "==> Starting the server at login"
mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/server/src/server.ts</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# The server writes the config (with a fresh token) on its first start.
CONFIG="$HOME/.config/laptop-remote/config.json"
for _ in $(seq 1 50); do [[ -f "$CONFIG" ]] && break; sleep 0.1; done
TOKEN="$("$NODE_BIN" -p "require('$CONFIG').token")"
PORT="$("$NODE_BIN" -p "require('$CONFIG').port")"

echo "==> Checking the charging switch"
"$HELPER_DEST" status

TAILSCALE=""
for candidate in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  if command -v "$candidate" >/dev/null 2>&1; then TAILSCALE="$candidate"; break; fi
done

echo
if [[ -n "$TAILSCALE" ]] && "$TAILSCALE" status >/dev/null 2>&1; then
  echo "==> Exposing it to your devices with Tailscale (HTTPS, private to your tailnet)"
  "$TAILSCALE" serve --bg "$PORT" >/dev/null
  HOST="$("$TAILSCALE" status --json | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"
  echo
  echo "Done. Open this on your phone (it is signed in to the same Tailscale account):"
  echo
  echo "  https://$HOST/#token=$TOKEN"
  echo
  echo "Then use Share > Add to Home Screen to install it as an app."
else
  echo "Done. The server is running on http://127.0.0.1:$PORT"
  echo
  echo "To reach it from your phone:"
  echo "  1. Install Tailscale on this Mac (brew install --cask tailscale) and on your phone, same account."
  echo "  2. Run ./install.sh again. It prints the link to open on your phone."
fi
