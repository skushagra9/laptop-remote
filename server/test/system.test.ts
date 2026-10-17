import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBattery, parseHelperStatus, parseSleepDisabled } from "../src/system.ts";

// Trimmed from real `ioreg -rc AppleSmartBattery` output on a Mac17,8.
// The nested BatteryData dictionary repeats some key names, which is why
// the parser only matches whole top-level lines.
const IOREG = `+-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000ae1>
    {
      "CurrentCapacity" = 17
      "ExternalConnected" = No
      "BatteryData" = {"Ra03"=13,"MaxCapacity"=100,"StateOfCharge"=17}
      "FullyCharged" = No
      "MaxCapacity" = 100
      "IsCharging" = No
    }
`;

test("parseBattery reads top-level values", () => {
  assert.deepEqual(parseBattery(IOREG), { percent: 17, pluggedIn: false, charging: false, fullyCharged: false });
});

test("parseBattery reads a plugged-in, charging battery", () => {
  const charging = IOREG.replace('"ExternalConnected" = No', '"ExternalConnected" = Yes').replace(
    '"IsCharging" = No',
    '"IsCharging" = Yes',
  );
  assert.deepEqual(parseBattery(charging), { percent: 17, pluggedIn: true, charging: true, fullyCharged: false });
});

test("parseBattery refuses output without a percentage", () => {
  assert.throws(() => parseBattery("no battery here"), /battery percentage not found/);
});

test("parseSleepDisabled detects pmset disablesleep", () => {
  assert.equal(parseSleepDisabled(" sleep                1\n SleepDisabled        1\n"), true);
  assert.equal(parseSleepDisabled(" sleep                1\n SleepDisabled        0\n"), false);
  assert.equal(parseSleepDisabled(" sleep                1\n"), false);
});

test("parseHelperStatus reads both power switches", () => {
  assert.deepEqual(parseHelperStatus('{"backend":"CHTE","chargingInhibited":true,"adapterDisabled":false}\n'), {
    backend: "CHTE",
    chargingInhibited: true,
    adapterDisabled: false,
  });
});

test("parseHelperStatus treats fields an older helper omits as unknown", () => {
  assert.deepEqual(parseHelperStatus('{"backend":"none","chargingInhibited":null}\n'), {
    backend: "none",
    chargingInhibited: null,
    adapterDisabled: null,
  });
});
