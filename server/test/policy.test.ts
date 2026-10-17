import assert from "node:assert/strict";
import { test } from "node:test";
import { safetyActions } from "../src/policy.ts";
import type { MacState } from "../src/system.ts";

const base: MacState = {
  percent: 60,
  pluggedIn: true,
  charging: false,
  fullyCharged: false,
  chargingInhibited: false,
  chargingBackend: "CHTE",
  lidSleepPrevented: false,
  stayAwake: false,
};

test("does nothing in a normal state", () => {
  assert.deepEqual(safetyActions(base, 20), []);
});

test("keeps charging paused above the floor", () => {
  assert.deepEqual(safetyActions({ ...base, chargingInhibited: true, percent: 21 }, 20), []);
});

test("turns charging back on at the floor", () => {
  const actions = safetyActions({ ...base, chargingInhibited: true, percent: 20 }, 20);
  assert.deepEqual(actions.map((a) => a.kind), ["enable-charging"]);
});

test("does not touch charging when its state is unknown", () => {
  assert.deepEqual(safetyActions({ ...base, chargingInhibited: null, percent: 5 }, 20), []);
});

test("allows lid sleep again once the charger is unplugged", () => {
  const actions = safetyActions({ ...base, lidSleepPrevented: true, pluggedIn: false }, 20);
  assert.deepEqual(actions.map((a) => a.kind), ["allow-lid-sleep"]);
});

test("keeps the lid awake while plugged in", () => {
  assert.deepEqual(safetyActions({ ...base, lidSleepPrevented: true }, 20), []);
});
