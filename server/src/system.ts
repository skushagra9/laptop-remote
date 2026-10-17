// Everything that touches the Mac lives here: reading battery state and
// running the root helper. Parsers are exported separately so they can be
// tested without a Mac.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Overridable so the server can run against a locally built helper in development.
export const HELPER_PATH = process.env.LAPTOP_REMOTE_HELPER ?? "/usr/local/libexec/laptop-remote-helper";

export type Battery = {
  percent: number;
  pluggedIn: boolean;
  charging: boolean;
  fullyCharged: boolean;
};

export type MacState = Battery & {
  chargingInhibited: boolean | null;
  chargingBackend: string;
  lidSleepPrevented: boolean;
  stayAwake: boolean;
};

function ioregValue(text: string, key: string): string | undefined {
  // Top-level keys are indented once and look like:  "CurrentCapacity" = 17
  const match = text.match(new RegExp(`^\\s*"${key}" = (\\S+)\\s*$`, "m"));
  return match?.[1];
}

export function parseBattery(ioreg: string): Battery {
  const percent = Number(ioregValue(ioreg, "CurrentCapacity"));
  if (!Number.isFinite(percent)) throw new Error("battery percentage not found in ioreg output");
  return {
    percent,
    pluggedIn: ioregValue(ioreg, "ExternalConnected") === "Yes",
    charging: ioregValue(ioreg, "IsCharging") === "Yes",
    fullyCharged: ioregValue(ioreg, "FullyCharged") === "Yes",
  };
}

export function parseSleepDisabled(pmset: string): boolean {
  return /^\s*SleepDisabled\s+1\s*$/m.test(pmset);
}

export function parseHelperStatus(json: string): { backend: string; chargingInhibited: boolean | null } {
  const parsed = JSON.parse(json) as { backend: string; chargingInhibited: boolean | null };
  return { backend: parsed.backend, chargingInhibited: parsed.chargingInhibited };
}

export async function readBattery(): Promise<Battery> {
  const { stdout } = await run("/usr/sbin/ioreg", ["-rc", "AppleSmartBattery"]);
  return parseBattery(stdout);
}

async function readLidSleepPrevented(): Promise<boolean> {
  const { stdout } = await run("/usr/bin/pmset", ["-g"]);
  return parseSleepDisabled(stdout);
}

async function readHelperStatus() {
  // Reading SMC keys does not need root, so status skips sudo.
  const { stdout } = await run(HELPER_PATH, ["status"]);
  return parseHelperStatus(stdout);
}

async function helperAsRoot(args: string[]): Promise<void> {
  try {
    // -n: fail instead of prompting when the sudoers entry is missing.
    await run("/usr/bin/sudo", ["-n", HELPER_PATH, ...args]);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (stderr.includes("a password is required")) {
      throw new Error("The laptop is not set up for this yet. Run ./install.sh on the Mac.");
    }
    throw new Error(stderr.trim() || "The laptop could not apply that change.");
  }
}

// The user-facing name ("Kushagra's MacBook Pro"); os.hostname() is often a
// DHCP placeholder on macOS.
export async function readComputerName(): Promise<string> {
  const { stdout } = await run("/usr/sbin/scutil", ["--get", "ComputerName"]);
  return stdout.trim();
}

export async function setCharging(enabled: boolean): Promise<void> {
  await helperAsRoot(["charging", enabled ? "on" : "off"]);
}

export async function setLidSleepPrevented(prevent: boolean): Promise<void> {
  await helperAsRoot(["lid-sleep", prevent ? "prevent" : "allow"]);
}

// Keeps the Mac from idle-sleeping by holding a caffeinate child process.
// `-w` ties it to this server's pid, so it cannot outlive a crash.
export class StayAwake {
  #child: ChildProcess | null = null;

  get active(): boolean {
    return this.#child !== null;
  }

  set(enabled: boolean): void {
    if (enabled && !this.#child) {
      const child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
      child.on("exit", () => {
        if (this.#child === child) this.#child = null;
      });
      this.#child = child;
    } else if (!enabled && this.#child) {
      this.#child.kill();
      this.#child = null;
    }
  }
}

export async function readMacState(stayAwake: StayAwake): Promise<MacState> {
  const [battery, helper, lidSleepPrevented] = await Promise.all([
    readBattery(),
    readHelperStatus(),
    readLidSleepPrevented(),
  ]);
  return {
    ...battery,
    chargingInhibited: helper.chargingInhibited,
    chargingBackend: helper.backend,
    lidSleepPrevented,
    stayAwake: stayAwake.active,
  };
}
