#!/bin/bash
# Removes everything install.sh added and leaves the Mac charging and sleeping normally.
set -euo pipefail

LABEL=io.github.laptop-remote
HELPER=/usr/local/libexec/laptop-remote-helper

# Stopping the server allows lid sleep again; the power switches are restored below.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ -x "$HELPER" ]]; then
  sudo "$HELPER" adapter on || true
  sudo "$HELPER" charging on || true
  sudo "$HELPER" lid-sleep allow || true
fi
sudo rm -f "$HELPER" /etc/sudoers.d/laptop-remote

if command -v tailscale >/dev/null 2>&1; then
  tailscale serve --https=443 off 2>/dev/null || true
fi

echo "Removed. Your settings in ~/.config/laptop-remote were kept; delete that folder to remove them too."
