import type {
  AgentSession,
  JudgeVerdict,
  PhaseState,
  TDDConfig,
  TDDPhase,
  ToolCallInput,
  TransitionVerdict,
} from "./types.js";

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function phaseRules(phase: TDDPhase): string {
  switch (phase) {
    case "PLAN":
      return `Phase: PLAN
ALLOWED: Reading files. Exploring the codebase. No modifications.
BLOCKED: Writing, editing, or creating any files. Running commands that modify state.`;
    case "RED":
      return `Phase: RED
ALLOWED: Writing or modifying test files. Running tests to confirm failure. Reading any file.
BLOCKED: Writing implementation code. Modifying non-test source files.`;
    case "GREEN":
      return `Phase: GREEN
ALLOWED: Writing the minimum implementation to pass the failing test. Running tests.
BLOCKED: Refactoring. Adding features beyond what the test requires.`;
    case "REFACTOR":
      return `Phase: REFACTOR
ALLOWED: Restructuring, renaming, extracting. Running tests to confirm they still pass.
BLOCKED: Changing observable behavior. Adding new tests (belongs to next RED phase).`;
  }
}

function summarizeToolCall(call: ToolCallInput): string {
  const input = call.input;
  const parts = [`Tool: ${call.tool_name}`];

  if (input.file_path || input.path) {
    parts.push(`Path: ${input.file_path ?? input.path}`);
  }
  if (input.command) {
    const cmd = String(input.command);
    parts.push(`Command: ${cmd.length > 300 ? cmd.slice(0, 300) + "..." : cmd}`);
  }
  if (input.content) {
    const content = String(input.content);
    parts.push(`Content preview: ${content.length > 300 ? content.slice(0, 300) + "..." : content}`);
  }
  if (input.old_string) {
    const old = String(input.old_string);
    parts.push(`Old text: ${old.length > 200 ? old.slice(0, 200) + "..." : old}`);
  }
  if (input.new_string) {
    const ns = String(input.new_string);
    parts.push(`New text: ${ns.length > 200 ? ns.slice(0, 200) + "..." : ns}`);
  }

  return parts.join("\n");
}

function contextBlock(state: PhaseState, maxDiffs: number): string {
  const lines: string[] = [];

  if (state.lastTestOutput) {
    const output = state.lastTestOutput;
    lines.push(
      `Last test output (truncated):\n${output.length > 500 ? output.slice(-500) : output}`
    );
  }
  if (state.lastTestFailed !== null) {
    lines.push(`Last test result: ${state.lastTestFailed ? "FAILED" : "PASSED"}`);
  }

  const diffs = state.diffs.slice(-maxDiffs);
  if (diffs.length > 0) {
    lines.push(`Recent diffs (${diffs.length}):\n${diffs.join("\n---\n")}`);
  }

  return lines.length > 0 ? lines.join("\n\n") : "No accumulated context yet.";
}

// ---------------------------------------------------------------------------
// Gate judge — decides whether a tool call is allowed in the current phase
// ---------------------------------------------------------------------------

function buildGatePrompt(
  calls: ToolCallInput[],
  state: PhaseState,
  config: TDDConfig
): string {
  const callSummaries = calls.map((c, i) => `[${i}] ${summarizeToolCall(c)}`).join("\n\n");

  return `You are a TDD enforcement judge. Your job is to decide whether proposed tool calls are consistent with the current TDD phase.

${phaseRules(state.phase)}

Context:
${contextBlock(state, config.maxDiffsInContext)}

Proposed tool calls:
${callSummaries}

For EACH tool call, decide whether it is ALLOWED or BLOCKED under the current phase rules.

Key guidelines:
- In PLAN phase: ALL writes and edits are blocked. Only reading is allowed. This phase is for planning only.
- In RED phase: only test files may be written/modified. Test files are identified by path patterns (test, spec, _test, .test, .spec) or by content that is clearly test code (assertions, test declarations).
- In GREEN phase: implementation files may be written to make tests pass. No refactoring beyond the minimum needed.
- In REFACTOR phase: restructuring is fine but behavior must not change. New tests are not allowed.
- Bash commands running tests (pytest, cargo test, npm test, go test, vitest, rspec, deno test, make test, zig test, blc check) are ALWAYS allowed in any phase except PLAN.
- Bash commands that modify files (echo >, sed -i, mv, cp, rm) follow the same rules as write/edit tools.

Respond with a JSON array of verdicts, one per tool call, in order. No markdown fences. Example:
[{"allowed": true, "reason": "Writing a test file during RED phase"}, {"allowed": false, "reason": "Modifying implementation file during RED phase"}]`;
}

export async function judgeToolCalls(
  session: AgentSession,
  calls: ToolCallInput[],
  state: PhaseState,
  config: TDDConfig
): Promise<JudgeVerdict[]> {
  const prompt = buildGatePrompt(calls, state, config);

  const raw = await session.send(
    [{ role: "user", content: prompt }],
    { model: config.judgeModel, temperature: config.temperature }
  );

  return parseVerdictArray(raw, calls.length);
}

// ---------------------------------------------------------------------------
// Transition judge — decides whether the phase should advance
// ---------------------------------------------------------------------------

function buildTransitionPrompt(
  state: PhaseState,
  config: TDDConfig
): string {
  return `You are a TDD phase transition evaluator. Based on the current phase and accumulated context, decide whether the TDD cycle should advance to the next phase.

Current phase: ${state.phase}
Cycle count: ${state.cycleCount}

Transition rules:
- PLAN -> RED: The agent has outlined all planned test cases and is ready to start. (Usually user-initiated via /tdd red.)
- RED -> GREEN: A test was written and confirmed failing (test ran with failure output).
- GREEN -> REFACTOR: The previously failing test now passes (test ran with success output).
- REFACTOR -> RED: Refactoring is complete and tests still pass. Only transition if there is clear signal the agent is done refactoring.

Context:
${contextBlock(state, config.maxDiffsInContext)}

Should the phase transition? Respond with JSON only, no markdown fences.
If yes: {"transition": "<next phase>", "reason": "..."}
If no: {"transition": null, "reason": "..."}`;
}

export async function judgeTransition(
  session: AgentSession,
  state: PhaseState,
  config: TDDConfig
): Promise<TransitionVerdict> {
  const prompt = buildTransitionPrompt(state, config);

  const raw = await session.send(
    [{ role: "user", content: prompt }],
    { model: config.judgeModel, temperature: config.temperature }
  );

  return parseTransitionVerdict(raw);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function extractJSON(raw: string): string {
  // Strip markdown fences if present
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return raw.trim();
}

function parseVerdictArray(raw: string, expectedCount: number): JudgeVerdict[] {
  try {
    const parsed = JSON.parse(extractJSON(raw));
    if (Array.isArray(parsed)) {
      return parsed.map((v: unknown) => {
        if (typeof v === "object" && v !== null && "allowed" in v) {
          const obj = v as Record<string, unknown>;
          return {
            allowed: Boolean(obj.allowed),
            reason: String(obj.reason ?? ""),
          };
        }
        return { allowed: true, reason: "Malformed verdict entry, defaulting to allow" };
      });
    }
    // Single verdict returned instead of array — wrap it
    if (typeof parsed === "object" && parsed !== null && "allowed" in parsed) {
      const verdict: JudgeVerdict = {
        allowed: Boolean(parsed.allowed),
        reason: String(parsed.reason ?? ""),
      };
      return Array.from({ length: expectedCount }, () => verdict);
    }
  } catch {
    // Fall through to default
  }
  return Array.from({ length: expectedCount }, () => ({
    allowed: true,
    reason: "Judge response unparseable, defaulting to allow",
  }));
}

function parseTransitionVerdict(raw: string): TransitionVerdict {
  try {
    const parsed = JSON.parse(extractJSON(raw));
    if (typeof parsed === "object" && parsed !== null) {
      const transition = parsed.transition as TDDPhase | null;
      if (
        transition === null ||
        transition === "PLAN" ||
        transition === "RED" ||
        transition === "GREEN" ||
        transition === "REFACTOR"
      ) {
        return { transition, reason: String(parsed.reason ?? "") };
      }
    }
  } catch {
    // Fall through
  }
  return { transition: null, reason: "Transition verdict unparseable, staying in current phase" };
}
