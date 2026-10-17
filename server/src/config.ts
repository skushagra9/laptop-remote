import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  port: number;
  token: string;
};

export const CONFIG_DIR = join(homedir(), ".config", "laptop-remote");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULTS = { port: 7777 };

// Creates the config with a fresh random token on first run.
export function loadConfig(): Config {
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config: Config = {
    port: stored.port ?? DEFAULTS.port,
    token: stored.token ?? randomBytes(24).toString("base64url"),
  };
  if (!stored.token) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  }
  return config;
}
