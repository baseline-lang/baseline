import type { TDDConfig, PiExtensionAPI } from "./types.js";

const DEFAULTS: TDDConfig = {
  enabled: true,
  judgeModel: "haiku",
  judgeProvider: "anthropic",
  autoTransition: true,
  refactorTransition: "user",
  allowReadInAllPhases: true,
  temperature: 0,
  maxDiffsInContext: 5,
  persistPhase: true,
};

export function loadConfig(pi: PiExtensionAPI): TDDConfig {
  const user = pi.getSettings<Partial<TDDConfig>>("tddGate");
  if (!user) return { ...DEFAULTS };
  return { ...DEFAULTS, ...user };
}
