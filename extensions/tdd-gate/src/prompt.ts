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
    case "PLAN":
      lines.push("- You are in PLANNING mode. Read the codebase and outline test cases.");
      lines.push("- List the tests you intend to write as a numbered plan.");
      lines.push("- Do NOT write any code or modify any files yet.");
      lines.push("- Once your plan is complete, the user will run /tdd red to start.");
      if (machine.plan.length > 0) {
        lines.push("");
        lines.push("Current test plan:");
        for (let i = 0; i < machine.plan.length; i++) {
          const marker = i < machine.planCompleted ? "[x]" : "[ ]";
          lines.push(`  ${marker} ${i + 1}. ${machine.plan[i]}`);
        }
      }
      break;
    case "RED":
      lines.push("- Write a failing test FIRST. Do not write implementation code.");
      lines.push("- Run the test to confirm it fails before moving on.");
      // On the first cycle with no plan, prompt the agent to assess whether planning is needed
      if (machine.cycleCount === 0 && machine.plan.length === 0) {
        lines.push("");
        lines.push("IMPORTANT: Before writing your first test, assess whether this task would benefit from a planning phase.");
        lines.push("Suggest /tdd plan to the user if ANY of these apply:");
        lines.push("  - The request is a PRD, spec, or feature with multiple acceptance criteria");
        lines.push("  - The task touches unfamiliar or complex parts of the codebase that need investigation");
        lines.push("  - There are industry-standard patterns or prior art worth researching first");
        lines.push("  - The scope is ambiguous and needs decomposition into concrete test cases");
        lines.push("If the task is well-defined (clear bug, single behavior, obvious test), skip planning and write the test directly.");
      }
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

  // Show what test to work on next if we have a plan and we're in a cycle phase
  if (phase !== "PLAN" && machine.plan.length > 0) {
    const current = machine.currentPlanItem();
    if (current) {
      lines.push("");
      lines.push(`Current plan item (${machine.planCompleted + 1}/${machine.plan.length}): ${current}`);
    }
  }

  lines.push("");
  lines.push(`Allowed: ${allowed}`);
  lines.push(`Prohibited: ${prohibited}`);
  lines.push("");
  lines.push("Your tool calls are gated. Out-of-phase actions will be blocked.");

  if (machine.lastTestFailed !== null) {
    lines.push(`Last test result: ${machine.lastTestFailed ? "FAILING" : "PASSING"}`);
  }

  if (phase !== "PLAN") {
    lines.push(`Cycle: ${machine.cycleCount}`);
  }

  return lines.join("\n");
}
