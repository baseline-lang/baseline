import type { PhaseState, PhaseTransitionLog, TDDPhase } from "./types.js";

const CYCLE_ORDER: TDDPhase[] = ["RED", "GREEN", "REFACTOR"];

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
      plan: initial?.plan ?? [],
      planCompleted: initial?.planCompleted ?? 0,
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

  get plan(): string[] {
    return this.state.plan;
  }

  get planCompleted(): number {
    return this.state.planCompleted;
  }

  getSnapshot(): Readonly<PhaseState> {
    return { ...this.state, diffs: [...this.state.diffs], plan: [...this.state.plan] };
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
   * PLAN phase advances to RED (starting the first cycle).
   */
  advance(reason: string): boolean {
    if (this.state.phase === "PLAN") {
      return this.transitionTo("RED", reason);
    }
    const idx = CYCLE_ORDER.indexOf(this.state.phase);
    const next = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
    return this.transitionTo(next, reason);
  }

  /**
   * Set the test plan (list of test case descriptions).
   */
  setPlan(items: string[]): void {
    this.state.plan = items;
    this.state.planCompleted = 0;
  }

  /**
   * Mark the current plan item as done and advance the pointer.
   */
  completePlanItem(): void {
    if (this.state.planCompleted < this.state.plan.length) {
      this.state.planCompleted++;
    }
  }

  /**
   * The current plan item the agent should be working on, or null if
   * the plan is empty or fully completed.
   */
  currentPlanItem(): string | null {
    if (this.state.planCompleted < this.state.plan.length) {
      return this.state.plan[this.state.planCompleted];
    }
    return null;
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
      case "PLAN":
        return "Read code. Explore the codebase. Outline test cases. Discuss the plan.";
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
      case "PLAN":
        return "Write or modify any files. Run commands that change state. Only planning.";
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
    if (this.state.phase === "PLAN") {
      const planCount = this.state.plan.length;
      return `[TDD: PLAN] | Tests planned: ${planCount}`;
    }
    const testStatus =
      this.state.lastTestFailed === null
        ? "UNKNOWN"
        : this.state.lastTestFailed
          ? "FAILING"
          : "PASSING";
    const planProgress =
      this.state.plan.length > 0
        ? ` | Plan: ${this.state.planCompleted}/${this.state.plan.length}`
        : "";
    return `[TDD: ${this.state.phase}] | Tests: ${testStatus} | Cycle: ${this.state.cycleCount}${planProgress}`;
  }
}
