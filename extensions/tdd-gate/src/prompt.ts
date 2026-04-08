import type { PhaseStateMachine } from "./phase.js";

/**
 * Build the system prompt fragment injected via before_agent_start.
 * Kept concise to minimize context overhead per the spec.
 */
export function buildSystemPrompt(machine: PhaseStateMachine): string {
  if (!machine.enabled) {
    return "[TDD MODE - DISABLED]\nTDD enforcement is currently disabled for this session.";
  }

  const phase = machine.phase;

  const allowed = machine.allowedActions();
  const prohibited = machine.prohibitedActions();

  const lines = [
    `[TDD MODE - Phase: ${phase}]`,
    `You are in strict TDD mode. Current phase: ${phase}.`,
    "",
  ];

  switch (phase) {
    case "RED":
      lines.push("- Write a failing test FIRST. Do not write implementation code.");
      lines.push("- Run the test to confirm it fails before moving on.");
      break;
    case "GREEN":
      lines.push("- Write the MINIMUM implementation to make the failing test pass.");
      lines.push("- Do not refactor or add features beyond what the test requires.");
      lines.push("- Run the test to confirm it passes.");
      break;
    case "REFACTOR":
      lines.push("- Improve code structure without changing behavior.");
      lines.push("- Run tests after each change to confirm they still pass.");
      lines.push("- Do not add new tests or change observable behavior.");
      break;
  }

  lines.push("");
  lines.push(`Allowed: ${allowed}`);
  lines.push(`Prohibited: ${prohibited}`);
  lines.push("");
  lines.push("Your tool calls are gated. Out-of-phase actions will be blocked.");

  if (machine.lastTestFailed !== null) {
    lines.push(`Last test result: ${machine.lastTestFailed ? "FAILING" : "PASSING"}`);
  }

  lines.push(`Cycle: ${machine.cycleCount}`);

  return lines.join("\n");
}
