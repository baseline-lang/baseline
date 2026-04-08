import type { PiContext, TDDPhase } from "./types.js";
import type { PhaseStateMachine } from "./phase.js";

const VALID_PHASES: TDDPhase[] = ["RED", "GREEN", "REFACTOR"];

/**
 * Handle the /tdd command. Returns a message to display to the user.
 */
export async function handleTddCommand(
  args: string[],
  machine: PhaseStateMachine,
  ctx: PiContext
): Promise<string> {
  const sub = (args[0] ?? "status").toLowerCase();

  switch (sub) {
    case "status":
      return formatStatus(machine);

    case "red":
    case "green":
    case "refactor": {
      const target = sub.toUpperCase() as TDDPhase;
      if (!VALID_PHASES.includes(target)) {
        return `Unknown phase: ${sub}. Valid phases: RED, GREEN, REFACTOR.`;
      }
      const ok = machine.transitionTo(target, "User forced via /tdd command", true);
      if (ok) {
        ctx.ui.setStatus(machine.statusText());
        ctx.ui.notify(`TDD phase → ${target} (user override)`, "success");
        return `Phase set to ${target}.`;
      }
      return `Already in ${target} phase.`;
    }

    case "off":
      machine.enabled = false;
      ctx.ui.setStatus("[TDD: OFF]");
      ctx.ui.notify("TDD enforcement disabled", "warning");
      return "TDD enforcement disabled for this session.";

    case "on":
      machine.enabled = true;
      ctx.ui.setStatus(machine.statusText());
      ctx.ui.notify("TDD enforcement enabled", "success");
      return `TDD enforcement enabled. Phase: ${machine.phase}.`;

    case "history":
      return formatHistory(machine);

    default:
      return HELP_TEXT;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatStatus(machine: PhaseStateMachine): string {
  const snap = machine.getSnapshot();
  const lines = [
    machine.statusText(),
    "",
    `Phase:      ${snap.phase}`,
    `Enabled:    ${snap.enabled}`,
    `Cycle:      ${snap.cycleCount}`,
    `Test state: ${snap.lastTestFailed === null ? "unknown" : snap.lastTestFailed ? "failing" : "passing"}`,
    `Diffs:      ${snap.diffs.length} accumulated`,
  ];
  return lines.join("\n");
}

function formatHistory(machine: PhaseStateMachine): string {
  const history = machine.getHistory();
  if (history.length === 0) {
    return "No phase transitions recorded yet.";
  }

  const lines = ["Phase transition history:", ""];
  for (const entry of history) {
    const ts = new Date(entry.timestamp).toLocaleTimeString();
    const override = entry.override ? " [OVERRIDE]" : "";
    lines.push(`  ${ts} ${entry.from} → ${entry.to}${override}: ${entry.reason}`);
  }
  return lines.join("\n");
}

const HELP_TEXT = `Usage: /tdd [subcommand]

  /tdd              Show current phase and status
  /tdd status       Same as above
  /tdd red          Force transition to RED phase
  /tdd green        Force transition to GREEN phase
  /tdd refactor     Force transition to REFACTOR phase
  /tdd off          Disable TDD enforcement
  /tdd on           Re-enable TDD enforcement
  /tdd history      Show phase transition log`;
