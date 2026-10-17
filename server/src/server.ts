import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { safetyActions } from "./policy.ts";
import { readComputerName, readMacState, setCharging, setLidSleepPrevented, StayAwake } from "./system.ts";

const POLL_MS = 30_000;
const MAX_EVENTS = 30;

class BadRequest extends Error {}

const config = loadConfig();
const computerName = await readComputerName().catch(() => hostname());
const stayAwake = new StayAwake();
const events: { at: string; message: string }[] = [];

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/icon-512.png": { file: "icon-512.png", type: "image/png" },
};

function log(message: string): void {
  events.unshift({ at: new Date().toISOString(), message });
  events.length = Math.min(events.length, MAX_EVENTS);
  console.log(message);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.replace(/^Bearer /, ""));
  const expected = Buffer.from(config.token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new BadRequest("body too large");
  }
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    throw new BadRequest("body is not valid JSON");
  }
}

function requireBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw new BadRequest(`"${key}" must be true or false`);
  return value;
}

async function status() {
  const state = await readMacState(stayAwake);
  return { host: computerName, floorPercent: config.floorPercent, state, events };
}

async function enforceSafety(): Promise<void> {
  const state = await readMacState(stayAwake);
  for (const action of safetyActions(state, config.floorPercent)) {
    if (action.kind === "enable-charging") await setCharging(true);
    if (action.kind === "allow-lid-sleep") await setLidSleepPrevented(false);
    log(action.reason);
  }
}

const actions: Record<string, (body: Record<string, unknown>) => Promise<void>> = {
  "/api/charging": async (body) => {
    const enabled = requireBoolean(body, "enabled");
    await setCharging(enabled);
    log(enabled ? "Charging turned on" : "Charging paused");
  },
  "/api/stay-awake": async (body) => {
    const enabled = requireBoolean(body, "enabled");
    stayAwake.set(enabled);
    log(enabled ? "Stay awake turned on" : "Stay awake turned off");
  },
  "/api/lid-sleep": async (body) => {
    const prevent = requireBoolean(body, "prevent");
    await setLidSleepPrevented(prevent);
    log(prevent ? "Awake with lid closed turned on" : "Awake with lid closed turned off");
  },
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  const asset = req.method === "GET" ? STATIC_FILES[path] : undefined;
  if (asset) {
    res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache" });
    res.end(readFileSync(join(PUBLIC_DIR, asset.file)));
    return;
  }

  if (!path.startsWith("/api/")) return send(res, 404, { error: "not found" });
  if (!authorized(req)) return send(res, 401, { error: "wrong or missing token" });

  try {
    if (req.method === "GET" && path === "/api/status") return send(res, 200, await status());
    const action = req.method === "POST" ? actions[path] : undefined;
    if (!action) return send(res, 404, { error: "not found" });
    await action(await readJson(req));
    send(res, 200, await status());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${req.method} ${path} failed: ${message}`);
    send(res, error instanceof BadRequest ? 400 : 500, { error: message });
  }
});

// Leave the Mac in its normal state whenever the server stops, so a stopped
// server can never strand a laptop that is not charging.
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, restoring charging and lid sleep`);
  stayAwake.set(false);
  await Promise.allSettled([setCharging(true), setLidSleepPrevented(false)]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

setInterval(() => {
  enforceSafety().catch((error: unknown) => console.error("safety check failed:", error));
}, POLL_MS);

// Loopback only: remote access goes through `tailscale serve`, never an open port.
server.listen(config.port, "127.0.0.1", () => {
  console.log(`laptop-remote listening on http://127.0.0.1:${config.port}`);
});
