// ---------------------------------------------------------------------------
// TDD Gate types
// ---------------------------------------------------------------------------

export type TDDPhase = "PLAN" | "RED" | "GREEN" | "REFACTOR";

export interface PhaseState {
  phase: TDDPhase;
  diffs: string[];
  lastTestOutput: string | null;
  lastTestFailed: boolean | null;
  cycleCount: number;
  enabled: boolean;
  plan: string[];
  planCompleted: number;
}

export interface PhaseTransitionLog {
  from: TDDPhase;
  to: TDDPhase;
  reason: string;
  timestamp: number;
  override: boolean;
}

export interface TDDConfig {
  enabled: boolean;
  judgeModel: string;
  judgeProvider: string;
  autoTransition: boolean;
  refactorTransition: "user" | "agent" | "timeout";
  allowReadInAllPhases: boolean;
  temperature: number;
  maxDiffsInContext: number;
  persistPhase: boolean;
  startInPlanMode: boolean;
  guidelines: GuidelinesConfig;
}

/**
 * Per-phase coding guidelines. Each key is a string injected into the
 * system prompt during that phase. Set a key to null to suppress the
 * default for that category. Set to a custom string to override.
 */
export interface GuidelinesConfig {
  plan: string | null;
  red: string | null;
  green: string | null;
  refactor: string | null;
  universal: string | null;
  security: string | null;
}

export interface JudgeVerdict {
  allowed: boolean;
  reason: string;
}

export interface TransitionVerdict {
  transition: TDDPhase | null;
  reason: string;
}

export interface TDDStateEntry {
  type: "tdd_state";
  phase: TDDPhase;
  cycleCount: number;
  lastTestFailed: boolean | null;
  plan: string[];
  planCompleted: number;
}

// ---------------------------------------------------------------------------
// Pi Extension API types (external contract)
// ---------------------------------------------------------------------------

export interface ToolCallInput {
  tool_name: string;
  input: Record<string, unknown>;
}

export interface ToolCallResult {
  block?: boolean;
  reason?: string;
}

export interface UIContext {
  confirm(message: string): Promise<boolean>;
  setStatus(text: string): void;
  notify(message: string, style?: "success" | "warning" | "error"): void;
}

export interface SessionEntry {
  type: string;
  [key: string]: unknown;
}

export interface PiContext {
  ui: UIContext;
  session: {
    entries(): SessionEntry[];
  };
}

export interface AgentMessage {
  role: string;
  content: string;
}

export interface AgentSession {
  send(messages: AgentMessage[], options?: { model?: string; temperature?: number }): Promise<string>;
}

export interface PiExtensionAPI {
  registerCommand(name: string, handler: CommandHandler): void;
  on(event: "before_agent_start", handler: BeforeAgentStartHandler): void;
  on(event: "tool_call", handler: ToolCallHandler): void;
  on(event: "turn_end", handler: TurnEndHandler): void;
  on(event: "session_start", handler: SessionStartHandler): void;
  appendEntry(entry: SessionEntry): void;
  getSettings<T>(key: string): T | undefined;
  createAgentSession(options?: { model?: string; provider?: string }): AgentSession;
}

export type CommandHandler = (args: string[], ctx: PiContext) => Promise<string | void>;
export type BeforeAgentStartHandler = (ctx: PiContext) => { systemMessage?: string } | void;
export type ToolCallHandler = (call: ToolCallInput, ctx: PiContext) => Promise<ToolCallResult | void>;
export type TurnEndHandler = (toolResults: ToolCallInput[], ctx: PiContext) => Promise<void>;
export type SessionStartHandler = (ctx: PiContext) => void;
