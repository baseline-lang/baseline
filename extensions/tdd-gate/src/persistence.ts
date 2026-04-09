import type { PiExtensionAPI, PiContext, TDDStateEntry, TDDPhase } from "./types.js";
import type { PhaseStateMachine } from "./phase.js";

/**
 * Persist the current phase state to the session journal.
 */
export function persistState(pi: PiExtensionAPI, machine: PhaseStateMachine): void {
  pi.appendEntry({
    type: "tdd_state",
    phase: machine.phase,
    cycleCount: machine.cycleCount,
    lastTestFailed: machine.lastTestFailed,
    plan: machine.plan,
    planCompleted: machine.planCompleted,
  });
}

/**
 * Restore phase state from the most recent tdd_state session entry.
 * Returns partial state suitable for initializing the PhaseStateMachine,
 * or null if no saved state is found.
 */
export function restoreState(
  ctx: PiContext
): { phase: TDDPhase; cycleCount: number; lastTestFailed: boolean | null; plan: string[]; planCompleted: number } | null {
  const entries = ctx.session.entries();

  // Walk backwards to find the most recent tdd_state entry
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "tdd_state") {
      const state = entry as unknown as TDDStateEntry;
      if (isValidPhase(state.phase)) {
        return {
          phase: state.phase,
          cycleCount: state.cycleCount ?? 0,
          lastTestFailed: state.lastTestFailed ?? null,
          plan: Array.isArray(state.plan) ? state.plan : [],
          planCompleted: state.planCompleted ?? 0,
        };
      }
    }
  }

  return null;
}

function isValidPhase(phase: unknown): phase is TDDPhase {
  return phase === "PLAN" || phase === "RED" || phase === "GREEN" || phase === "REFACTOR";
}
