import type { PiContext, TDDPhase } from "./types.js";
import type { PhaseStateMachine } from "./phase.js";

const VALID_PHASES: TDDPhase[] = ["PLAN", "RED", "GREEN", "REFACTOR"];

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

    case "plan":
    case "red":
    case "green":
    case "refactor": {
      const target = sub.toUpperCase() as TDDPhase;
      if (!VALID_PHASES.includes(target)) {
        return `Unknown phase: ${sub}. Valid phases: ${VALID_PHASES.join(", ")}.`;
      }
      // When transitioning from REFACTOR to RED with a plan, advance the plan pointer
      if (machine.phase === "REFACTOR" && target === "RED" && machine.plan.length > 0) {
        machine.completePlanItem();
      }
      const ok = machine.transitionTo(target, "User forced via /tdd command", true);
      if (ok) {
        ctx.ui.setStatus(machine.statusText());
        ctx.ui.notify(`TDD phase → ${target} (user override)`, "success");
        return `Phase set to ${target}.`;
      }
      return `Already in ${target} phase.`;
    }

    case "plan-set": {
      // /tdd plan-set "Test 1" "Test 2" "Test 3"
      const items = args.slice(1).filter(Boolean);
      if (items.length === 0) {
        return "Usage: /tdd plan-set \"Test case 1\" \"Test case 2\" ...";
      }
      machine.setPlan(items);
      ctx.ui.notify(`Test plan set with ${items.length} item(s)`, "success");
      return formatPlan(machine);
    }

    case "plan-show":
      return formatPlan(machine);

    case "plan-done": {
      machine.completePlanItem();
      const next = machine.currentPlanItem();
      if (next) {
        return `Plan item completed. Next: ${next} (${machine.planCompleted}/${machine.plan.length})`;
      }
      return `All ${machine.plan.length} plan items completed!`;
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
  if (snap.plan.length > 0) {
    lines.push(`Plan:       ${snap.planCompleted}/${snap.plan.length} completed`);
  }
  return lines.join("\n");
}

function formatPlan(machine: PhaseStateMachine): string {
  const snap = machine.getSnapshot();
  if (snap.plan.length === 0) {
    return "No test plan set. Use /tdd plan-set \"Test 1\" \"Test 2\" ... to create one.";
  }
  const lines = [`Test plan (${snap.planCompleted}/${snap.plan.length} completed):`, ""];
  for (let i = 0; i < snap.plan.length; i++) {
    const marker = i < snap.planCompleted ? "[x]" : i === snap.planCompleted ? "[>]" : "[ ]";
    lines.push(`  ${marker} ${i + 1}. ${snap.plan[i]}`);
  }
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
  /tdd plan         Enter PLAN phase (read-only, outline tests)
  /tdd red          Force transition to RED phase
  /tdd green        Force transition to GREEN phase
  /tdd refactor     Force transition to REFACTOR phase
  /tdd plan-set     Set test plan: /tdd plan-set "Test 1" "Test 2" ...
  /tdd plan-show    Show the current test plan with progress
  /tdd plan-done    Mark current plan item as completed
  /tdd off          Disable TDD enforcement
  /tdd on           Re-enable TDD enforcement
  /tdd history      Show phase transition log`;
