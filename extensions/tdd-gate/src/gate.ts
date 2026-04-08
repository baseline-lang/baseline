import type {
  AgentSession,
  PiContext,
  TDDConfig,
  ToolCallInput,
  ToolCallResult,
} from "./types.js";
import type { PhaseStateMachine } from "./phase.js";
import { judgeToolCalls } from "./judge.js";

// ---------------------------------------------------------------------------
// Read-only tools that are always allowed (observation is free in every phase)
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set([
  "user_read",
  "user_grep",
  "user_find",
  "user_ls",
  // Common aliases in different pi configurations
  "Read",
  "Grep",
  "Glob",
  "Ls",
]);

// ---------------------------------------------------------------------------
// Tools that require gating
// ---------------------------------------------------------------------------

const GATED_TOOLS = new Set([
  "user_write",
  "user_edit",
  "user_bash",
  "Write",
  "Edit",
  "Bash",
]);

function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}

function isGatedTool(name: string): boolean {
  return GATED_TOOLS.has(name);
}

// ---------------------------------------------------------------------------
// Tool call gate
// ---------------------------------------------------------------------------

/**
 * Gate a batch of tool calls for a single turn. Returns a result per call.
 * Calls that are not gated get an implicit allow (undefined).
 */
export async function gateToolCalls(
  calls: ToolCallInput[],
  machine: PhaseStateMachine,
  session: AgentSession,
  config: TDDConfig,
  ctx: PiContext
): Promise<(ToolCallResult | undefined)[]> {
  if (!machine.enabled) {
    return calls.map(() => undefined);
  }

  // Partition into gated vs. passthrough
  const gatedIndices: number[] = [];
  const gatedCalls: ToolCallInput[] = [];

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (config.allowReadInAllPhases && isReadTool(call.tool_name)) {
      continue; // always allowed
    }
    if (isGatedTool(call.tool_name)) {
      gatedIndices.push(i);
      gatedCalls.push(call);
    }
    // Unknown tools pass through ungated
  }

  if (gatedCalls.length === 0) {
    return calls.map(() => undefined);
  }

  // Ask the LLM judge
  let verdicts;
  try {
    verdicts = await judgeToolCalls(session, gatedCalls, machine.getSnapshot(), config);
  } catch (err) {
    // Judge failed — fall back to human confirmation
    const errMsg = err instanceof Error ? err.message : String(err);
    const override = await ctx.ui.confirm(
      `TDD judge failed (${errMsg}). Allow all ${gatedCalls.length} gated tool call(s)?`
    );
    return calls.map((_, i) => {
      if (gatedIndices.includes(i)) {
        return override ? undefined : { block: true, reason: `Judge failed and user denied override: ${errMsg}` };
      }
      return undefined;
    });
  }

  // Map verdicts back to results
  const results: (ToolCallResult | undefined)[] = calls.map(() => undefined);

  for (let j = 0; j < gatedIndices.length; j++) {
    const idx = gatedIndices[j];
    const verdict = verdicts[j];

    if (verdict.allowed) {
      // Allowed — record diff summary for context
      const call = calls[idx];
      machine.addDiff(
        summarizeDiff(call),
        config.maxDiffsInContext
      );
      continue;
    }

    // Blocked — offer human override
    ctx.ui.notify(
      `Blocked: ${calls[idx].tool_name} during ${machine.phase} phase. ${verdict.reason}`,
      "warning"
    );

    const override = await ctx.ui.confirm(
      `TDD gate blocked ${calls[idx].tool_name}: ${verdict.reason}\nOverride and allow?`
    );

    if (override) {
      machine.addDiff(
        summarizeDiff(calls[idx]),
        config.maxDiffsInContext
      );
      // Allowed via override, no block result
    } else {
      results[idx] = { block: true, reason: verdict.reason };
    }
  }

  return results;
}

/**
 * Gate a single tool call. Convenience wrapper for the tool_call event handler.
 */
export async function gateSingleToolCall(
  call: ToolCallInput,
  machine: PhaseStateMachine,
  session: AgentSession,
  config: TDDConfig,
  ctx: PiContext
): Promise<ToolCallResult | void> {
  if (!machine.enabled) return;

  if (config.allowReadInAllPhases && isReadTool(call.tool_name)) {
    return;
  }

  if (!isGatedTool(call.tool_name)) {
    return;
  }

  const results = await gateToolCalls([call], machine, session, config, ctx);
  return results[0];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeDiff(call: ToolCallInput): string {
  const parts = [call.tool_name];
  const input = call.input;

  if (input.file_path || input.path) {
    parts.push(String(input.file_path ?? input.path));
  }
  if (input.command) {
    const cmd = String(input.command);
    parts.push(cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd);
  }

  return parts.join(" | ");
}
