import type { TDDPhase } from "./types.js";
import type { PhaseStateMachine } from "./phase.js";

// ---------------------------------------------------------------------------
// Coding guidelines — phase-specific subset to keep prompt concise
// ---------------------------------------------------------------------------

const UNIVERSAL_GUIDELINES = `Coding guidelines (all phases):
- Show your work: explain key decisions and non-obvious choices.
- Think security: consider implications even when not mentioned. NEVER commit secrets, API keys, or credentials.
- Validate inputs at system boundaries, especially user data.
- Ask questions to clarify ambiguous requirements before proceeding.`;

function phaseGuidelines(phase: TDDPhase): string {
  switch (phase) {
    case "PLAN":
      return `Coding guidelines (PLAN phase):
- Reason then code: show logic before implementing complex solutions.
- Default to established, proven technologies unless newer approaches are requested.
- Contract-first: define interfaces and contracts before implementation when building integrations.
- Offer alternatives with trade-offs when appropriate.
- Break down complex problems incrementally.
- Ask about backwards compatibility rather than assuming — it can add unnecessary code.`;
    case "RED":
      return `Coding guidelines (RED phase):
- Tests as specifications: structure tests to articulate WHAT the code should do, not HOW.
- New developers should understand functionality by reading your tests.
- Use unit tests for domain logic, integration tests for API contracts and component interactions.
- Start with the happy path test. Handle edge cases in subsequent RED cycles unless security concerns.`;
    case "GREEN":
      return `Coding guidelines (GREEN phase):
- Simplicity first: generate the most direct solution that meets the test.
- Implement ONLY what's asked. No extra features, no future-proofing unless requested.
- Write explicit, straightforward code. Avoid clever one-liners.
- Favor pure functions, minimize side effects.
- Functions: 25-30 lines max. Use early returns / guard clauses to reduce complexity.
- Skip retry logic and other complexity unless explicitly needed.
- Use built-in features when sufficient; add packages only when they save significant time.`;
    case "REFACTOR":
      return `Coding guidelines (REFACTOR phase):
- Limit nesting: keep conditionals/loops under 3 layers.
- Unix philosophy: each function does one thing well. Prefer composition.
- Concrete over abstract: avoid abstraction unless it adds real value.
- Feature-first organization: group by functionality, then by type.
- Functions: 25-30 lines max. Break up longer functions.
- No unnecessary complexity. Clean, focused code only.`;
  }
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

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

  // Coding guidelines — phase-specific + universal
  lines.push("");
  lines.push(phaseGuidelines(phase));
  lines.push("");
  lines.push(UNIVERSAL_GUIDELINES);

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
