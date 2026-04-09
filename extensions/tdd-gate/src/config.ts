import type { TDDConfig, PiExtensionAPI, GuidelinesConfig } from "./types.js";
import { resolveGuidelines } from "./guidelines.js";

const DEFAULTS: Omit<TDDConfig, "guidelines"> = {
  enabled: true,
  judgeModel: "haiku",
  judgeProvider: "anthropic",
  autoTransition: true,
  refactorTransition: "user",
  allowReadInAllPhases: true,
  temperature: 0,
  maxDiffsInContext: 5,
  persistPhase: true,
  startInPlanMode: false,
};

export function loadConfig(pi: PiExtensionAPI): TDDConfig {
  const user = pi.getSettings<Partial<TDDConfig> & { guidelines?: Partial<GuidelinesConfig> }>("tddGate");
  const guidelines = resolveGuidelines(user?.guidelines);
  if (!user) return { ...DEFAULTS, guidelines };
  const { guidelines: _, ...rest } = user;
  return { ...DEFAULTS, ...rest, guidelines };
}
