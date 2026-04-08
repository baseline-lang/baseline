import type {
  AgentSession,
  PiContext,
  TDDConfig,
  ToolCallInput,
} from "./types.js";
import type { PhaseStateMachine } from "./phase.js";
import { judgeTransition } from "./judge.js";

// ---------------------------------------------------------------------------
// Heuristic test-command detection
// ---------------------------------------------------------------------------

const TEST_COMMAND_PATTERNS = [
  /\bpytest\b/,
  /\bcargo\s+test\b/,
  /\bnpm\s+test\b/,
  /\byarn\s+test\b/,
  /\bpnpm\s+test\b/,
  /\bgo\s+test\b/,
  /\bvitest\b/,
  /\brspec\b/,
  /\bdeno\s+test\b/,
  /\bmake\s+test\b/,
  /\bzig\s+test\b/,
  /\bjest\b/,
  /\bmocha\b/,
  /\bnpx\s+jest\b/,
  /\bnpx\s+vitest\b/,
  /\bblc\s+check\b/,
  /\bblc\s+test\b/,
  /\bscripts\/test\b/,
];

/**
 * Returns true if a bash command looks like it runs tests.
 * This is intentionally loose — it flags candidates for the LLM to evaluate.
 */
function isTestCommand(command: string): boolean {
  return TEST_COMMAND_PATTERNS.some((pat) => pat.test(command));
}

// ---------------------------------------------------------------------------
// Test result extraction from bash tool calls
// ---------------------------------------------------------------------------

interface TestSignal {
  command: string;
  output: string;
  exitCode: number;
  failed: boolean;
}

/**
 * Scan tool call results from the turn for test-run signals.
 * For bash calls, check if the command matches a test pattern and extract
 * the result.
 */
export function extractTestSignals(toolCalls: ToolCallInput[]): TestSignal[] {
  const signals: TestSignal[] = [];

  for (const call of toolCalls) {
    if (call.tool_name !== "user_bash" && call.tool_name !== "Bash") continue;

    const command = String(call.input.command ?? "");
    if (!isTestCommand(command)) continue;

    // The tool result output is attached to the input for the turn_end event
    const output = String(call.input._output ?? call.input.output ?? "");
    const exitCode = Number(call.input._exit_code ?? call.input.exit_code ?? 0);
    const failed = exitCode !== 0;

    signals.push({ command, output, exitCode, failed });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Phase transition evaluator — runs on turn_end
// ---------------------------------------------------------------------------

export async function evaluateTransition(
  toolCalls: ToolCallInput[],
  machine: PhaseStateMachine,
  session: AgentSession,
  config: TDDConfig,
  ctx: PiContext
): Promise<void> {
  if (!machine.enabled || !config.autoTransition) return;

  // Record any test signals
  const signals = extractTestSignals(toolCalls);
  for (const sig of signals) {
    machine.recordTestResult(sig.output, sig.failed);
  }

  // REFACTOR -> RED requires user/agent explicit signal by default
  if (machine.phase === "REFACTOR" && config.refactorTransition === "user") {
    return;
  }

  // Ask the LLM transition judge
  let verdict;
  try {
    verdict = await judgeTransition(session, machine.getSnapshot(), config);
  } catch {
    // Transition evaluation is non-critical; skip on failure
    return;
  }

  if (verdict.transition && verdict.transition !== machine.phase) {
    const transitioned = machine.transitionTo(verdict.transition, verdict.reason);
    if (transitioned) {
      ctx.ui.notify(
        `TDD phase → ${verdict.transition} (${verdict.reason})`,
        "success"
      );
      ctx.ui.setStatus(machine.statusText());
    }
  }
}
