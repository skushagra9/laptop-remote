# Laptop Remote

Control your Mac's charging and sleep from your phone, from anywhere.

Leave the laptop plugged in at home, then from your phone:

- **Pause or resume charging.** With charging paused the Mac keeps running from the charger, and the battery just stops filling up.
- **Keep it awake** so your Claude Code Remote Control sessions (or anything else) stay reachable.
- **Keep it awake with the lid closed.**
- See the battery level, whether it is plugged in, and a log of what changed.

Everything runs on your own laptop.
There is no cloud service and no account besides Tailscale.

## How it works

```
phone (web app) --HTTPS--> tailscale serve --> server (127.0.0.1:7777) --sudo--> helper --> SMC
```

- `helper/laptop-remote-helper.c` is the only code that runs as root.
  It accepts a fixed list of commands (`status`, `charging on|off`, `lid-sleep allow|prevent`) and never an arbitrary SMC key or value.
  It switches charging with the `CHTE` SMC key on current Apple Silicon firmware, or `CH0B`/`CH0C` on older firmware.
- `server/` is a dependency-free Node.js server that serves the phone UI and a small JSON API protected by a token.
  It only listens on `127.0.0.1`, so it is reachable only through Tailscale.
- `install.sh` installs the helper with a sudo rule scoped to it, starts the server at login with launchd, and exposes it with `tailscale serve`.

## Safety rules

- Charging turns back on by itself when the battery drops to the floor (20% by default).
- Closed-lid awake turns off by itself when the charger is unplugged, since a closed, non-sleeping laptop off the charger is probably in a bag.
- When the server stops for any reason it turns charging back on and allows sleep again.
  The keep-awake process is tied to the server's PID, so it can't outlive a crash.

## Install

You need macOS on Apple Silicon, Node.js 24 or newer, and the Xcode command line tools (`xcode-select --install`).

1. Install Tailscale on the Mac (`brew install --cask tailscale`) and on your phone, and sign both in to the same account.
2. In a Terminal, run `./install.sh`.
   It asks for your password once, then prints a link.
3. Open the link on your phone and use **Share > Add to Home Screen**.

Change the floor or the port in `~/.config/laptop-remote/config.json`, then restart with `launchctl kickstart -k gui/$(id -u)/io.github.laptop-remote`.

To remove everything, run `./uninstall.sh`.

## Development

```
npm install
npm run build:helper
npm run dev        # runs against build/laptop-remote-helper
npm test
npm run typecheck
```

Logs go to `~/Library/Logs/laptop-remote.log`.
