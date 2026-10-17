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
  adapterDisabled: false,
  chargingBackend: "CHTE",
  lidSleepPrevented: false,
  stayAwake: false,
};

test("does nothing in a normal state", () => {
  assert.deepEqual(safetyActions(base), []);
});

test("never turns charging or charger power back on, even at 1%", () => {
  assert.deepEqual(safetyActions({ ...base, percent: 1, chargingInhibited: true, adapterDisabled: true }), []);
});

test("allows lid sleep again once the charger is physically unplugged", () => {
  const actions = safetyActions({ ...base, lidSleepPrevented: true, pluggedIn: false });
  assert.deepEqual(actions.map((a) => a.kind), ["allow-lid-sleep"]);
});

test("keeps the lid awake while charger power is cut from the app", () => {
  assert.deepEqual(safetyActions({ ...base, lidSleepPrevented: true, pluggedIn: false, adapterDisabled: true }), []);
});

test("keeps the lid awake while plugged in", () => {
  assert.deepEqual(safetyActions({ ...base, lidSleepPrevented: true }), []);
});
