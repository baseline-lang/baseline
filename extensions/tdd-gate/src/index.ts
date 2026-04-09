import type {
  AgentSession,
  PiExtensionAPI,
  PiContext,
  ToolCallInput,
  ToolCallResult,
} from "./types.js";
import { PhaseStateMachine } from "./phase.js";
import { loadConfig } from "./config.js";
import { gateSingleToolCall } from "./gate.js";
import { evaluateTransition } from "./transition.js";
import { buildSystemPrompt } from "./prompt.js";
import { handleTddCommand } from "./commands.js";
import { persistState, restoreState } from "./persistence.js";

/**
 * TDD Enforcement Gate — pi coding agent extension.
 *
 * Enforces the RED/GREEN/REFACTOR cycle by:
 *   1. Injecting phase context into the agent system prompt (soft enforcement)
 *   2. Gating write/edit/bash tool calls via an LLM judge (hard enforcement)
 *   3. Automatically detecting phase transitions after each turn
 *   4. Persisting phase state across session resumes
 */
export default function activate(pi: PiExtensionAPI): void {
  const config = loadConfig(pi);
  if (!config.enabled) return;

  // Initialize phase state machine — defaults to PLAN if configured, else RED
  const initialPhase = config.startInPlanMode ? "PLAN" : "RED";
  const machine = new PhaseStateMachine({ phase: initialPhase });

  // Lazily create the judge session on first use
  let judgeSession: AgentSession | null = null;
  function getJudgeSession(): AgentSession {
    if (!judgeSession) {
      judgeSession = pi.createAgentSession({
        model: config.judgeModel,
        provider: config.judgeProvider,
      });
    }
    return judgeSession;
  }

  // ---------------------------------------------------------
  // session_start — restore persisted phase state
  // ---------------------------------------------------------
  pi.on("session_start", (ctx: PiContext) => {
    if (config.persistPhase) {
      const saved = restoreState(ctx);
      if (saved) {
        machine.transitionTo(saved.phase, "Restored from session", false);
        if (saved.lastTestFailed !== null) {
          machine.recordTestResult("(restored)", saved.lastTestFailed);
        }
        if (saved.plan.length > 0) {
          machine.setPlan(saved.plan);
          for (let i = 0; i < saved.planCompleted; i++) {
            machine.completePlanItem();
          }
        }
      }
    }
    ctx.ui.setStatus(machine.statusText());
  });

  // ---------------------------------------------------------
  // before_agent_start — inject TDD phase into system prompt
  // ---------------------------------------------------------
  pi.on("before_agent_start", (_ctx: PiContext) => {
    return { systemMessage: buildSystemPrompt(machine, config) };
  });

  // ---------------------------------------------------------
  // tool_call — gate write/edit/bash calls via LLM judge
  // ---------------------------------------------------------
  pi.on("tool_call", async (call: ToolCallInput, ctx: PiContext): Promise<ToolCallResult | void> => {
    return gateSingleToolCall(call, machine, getJudgeSession(), config, ctx);
  });

  // ---------------------------------------------------------
  // turn_end — evaluate phase transitions
  // ---------------------------------------------------------
  pi.on("turn_end", async (toolResults: ToolCallInput[], ctx: PiContext): Promise<void> => {
    await evaluateTransition(toolResults, machine, getJudgeSession(), config, ctx);

    // Persist after every turn so we survive crashes/restarts
    if (config.persistPhase) {
      persistState(pi, machine);
    }

    ctx.ui.setStatus(machine.statusText());
  });

  // ---------------------------------------------------------
  // /tdd command — manual phase control
  // ---------------------------------------------------------
  pi.registerCommand("tdd", async (args: string[], ctx: PiContext) => {
    const result = await handleTddCommand(args, machine, ctx);
    // Persist after command-driven phase changes
    if (config.persistPhase) {
      persistState(pi, machine);
    }
    return result;
  });
}

export { PhaseStateMachine } from "./phase.js";
export { loadConfig } from "./config.js";
export { judgeToolCalls, judgeTransition } from "./judge.js";
export { gateSingleToolCall, gateToolCalls } from "./gate.js";
export { evaluateTransition, extractTestSignals } from "./transition.js";
export { buildSystemPrompt } from "./prompt.js";
export { handleTddCommand } from "./commands.js";
export { guidelinesForPhase, resolveGuidelines, DEFAULTS as GUIDELINE_DEFAULTS } from "./guidelines.js";
export { persistState, restoreState } from "./persistence.js";
export type * from "./types.js";
