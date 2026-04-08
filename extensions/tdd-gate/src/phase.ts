import type { PhaseState, PhaseTransitionLog, TDDPhase } from "./types.js";

const PHASE_ORDER: TDDPhase[] = ["RED", "GREEN", "REFACTOR"];

export class PhaseStateMachine {
  private state: PhaseState;
  private history: PhaseTransitionLog[] = [];

  constructor(initial?: Partial<PhaseState>) {
    this.state = {
      phase: initial?.phase ?? "RED",
      diffs: initial?.diffs ?? [],
      lastTestOutput: initial?.lastTestOutput ?? null,
      lastTestFailed: initial?.lastTestFailed ?? null,
      cycleCount: initial?.cycleCount ?? 0,
      enabled: initial?.enabled ?? true,
    };
  }

  get phase(): TDDPhase {
    return this.state.phase;
  }

  get enabled(): boolean {
    return this.state.enabled;
  }

  set enabled(value: boolean) {
    this.state.enabled = value;
  }

  get cycleCount(): number {
    return this.state.cycleCount;
  }

  get lastTestFailed(): boolean | null {
    return this.state.lastTestFailed;
  }

  get lastTestOutput(): string | null {
    return this.state.lastTestOutput;
  }

  get diffs(): string[] {
    return this.state.diffs;
  }

  getSnapshot(): Readonly<PhaseState> {
    return { ...this.state, diffs: [...this.state.diffs] };
  }

  getHistory(): readonly PhaseTransitionLog[] {
    return this.history;
  }

  /**
   * Transition to a specific phase. Returns true if the transition occurred.
   */
  transitionTo(target: TDDPhase, reason: string, override = false): boolean {
    if (target === this.state.phase) return false;

    const log: PhaseTransitionLog = {
      from: this.state.phase,
      to: target,
      reason,
      timestamp: Date.now(),
      override,
    };

    this.history.push(log);

    // Increment cycle count when completing REFACTOR -> RED
    if (this.state.phase === "REFACTOR" && target === "RED") {
      this.state.cycleCount++;
    }

    this.state.phase = target;
    this.state.diffs = [];
    return true;
  }

  /**
   * Advance to the next phase in RED -> GREEN -> REFACTOR order.
   */
  advance(reason: string): boolean {
    const idx = PHASE_ORDER.indexOf(this.state.phase);
    const next = PHASE_ORDER[(idx + 1) % PHASE_ORDER.length];
    return this.transitionTo(next, reason);
  }

  addDiff(summary: string, maxDiffs: number): void {
    this.state.diffs.push(summary);
    if (this.state.diffs.length > maxDiffs) {
      this.state.diffs = this.state.diffs.slice(-maxDiffs);
    }
  }

  recordTestResult(output: string, failed: boolean): void {
    this.state.lastTestOutput = output;
    this.state.lastTestFailed = failed;
  }

  /**
   * What the agent MAY do in the current phase.
   */
  allowedActions(): string {
    switch (this.state.phase) {
      case "RED":
        return "Write/modify test files. Run tests to confirm failure. Read any file.";
      case "GREEN":
        return "Write the minimum implementation to pass the failing test. Run tests.";
      case "REFACTOR":
        return "Restructure, rename, extract. Run tests to confirm they still pass.";
    }
  }

  /**
   * What the agent may NOT do in the current phase.
   */
  prohibitedActions(): string {
    switch (this.state.phase) {
      case "RED":
        return "Write implementation code. Modify non-test source files.";
      case "GREEN":
        return "Refactor. Add features beyond what the test requires.";
      case "REFACTOR":
        return "Change behavior. Add new tests (that belongs to the next RED).";
    }
  }

  /**
   * Format a human-readable status string.
   */
  statusText(): string {
    const testStatus =
      this.state.lastTestFailed === null
        ? "UNKNOWN"
        : this.state.lastTestFailed
          ? "FAILING"
          : "PASSING";
    return `[TDD: ${this.state.phase}] | Tests: ${testStatus} | Cycle: ${this.state.cycleCount}`;
  }
}
