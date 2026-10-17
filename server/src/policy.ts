// Safety rules, kept pure so they are easy to test. The server runs them on
// every poll.
//
// Charging and charger power are deliberately NOT here: they only ever change
// when the user flips them, even if the battery runs flat.

import type { MacState } from "./system.ts";

export type SafetyAction = { kind: "allow-lid-sleep"; reason: string };

export function safetyActions(state: MacState): SafetyAction[] {
  const actions: SafetyAction[] = [];

  // A closed laptop that cannot sleep and was physically unplugged is most
  // likely in a bag, where it would overheat and drain. When the user cut
  // charger power from the app, "unplugged" is expected and not a signal.
  if (state.lidSleepPrevented && !state.pluggedIn && !state.adapterDisabled) {
    actions.push({
      kind: "allow-lid-sleep",
      reason: "Charger was unplugged, so closed-lid sleep was allowed again",
    });
  }

  return actions;
}
