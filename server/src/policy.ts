// Safety rules, kept pure so they are easy to test. The server runs them on
// every poll; they only ever turn protective behaviour back ON.

import type { MacState } from "./system.ts";

export type SafetyAction =
  | { kind: "enable-charging"; reason: string }
  | { kind: "allow-lid-sleep"; reason: string };

export function safetyActions(state: MacState, floorPercent: number): SafetyAction[] {
  const actions: SafetyAction[] = [];

  // A paused charger must never let the battery run flat while you are away.
  if (state.chargingInhibited && state.percent <= floorPercent) {
    actions.push({
      kind: "enable-charging",
      reason: `Battery reached ${state.percent}% (floor is ${floorPercent}%), so charging was turned back on`,
    });
  }

  // A closed laptop that cannot sleep and is off the charger is most likely
  // in a bag, where it would overheat and drain.
  if (state.lidSleepPrevented && !state.pluggedIn) {
    actions.push({
      kind: "allow-lid-sleep",
      reason: "Charger was unplugged, so closed-lid sleep was allowed again",
    });
  }

  return actions;
}
