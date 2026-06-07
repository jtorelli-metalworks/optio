export interface ModelProfileLane {
  provider?: string;
  model?: string;
  agentType?: string;
  effort?: string;
}

export interface ModelProfile {
  coding: ModelProfileLane;
  review: ModelProfileLane;
}

export interface ModelProfilesDocument {
  profiles: Record<
    string,
    ModelProfile & { label?: string; taskConfigName?: string; description?: string }
  >;
  repoDefaults?: ModelProfile;
}

export interface ResolvedCodingModels {
  agentType?: string;
  claudeModel?: string;
  cursorModel?: string;
  copilotModel?: string;
}

export interface ResolvedReviewModels {
  agentType?: string;
  model?: string;
  effort?: string;
}

let cachedProfiles: ModelProfilesDocument | null | undefined;

export function resetModelProfilesCache(): void {
  cachedProfiles = undefined;
}

export function loadModelProfiles(): ModelProfilesDocument | null {
  if (cachedProfiles !== undefined) return cachedProfiles;
  const raw = process.env.OPTIO_MODEL_PROFILES_JSON;
  if (!raw?.trim()) {
    cachedProfiles = null;
    return cachedProfiles;
  }
  try {
    cachedProfiles = JSON.parse(raw) as ModelProfilesDocument;
  } catch {
    cachedProfiles = null;
  }
  return cachedProfiles;
}

export function resolveModelProfile(name: string | null | undefined): ModelProfile | null {
  if (!name) return null;
  const doc = loadModelProfiles();
  if (!doc?.profiles?.[name]) return null;
  const entry = doc.profiles[name];
  return { coding: entry.coding, review: entry.review };
}

export function resolveCodingModelsForTask(
  profileName: string | null | undefined,
  repoConfig: {
    defaultAgentType?: string | null;
    claudeModel?: string | null;
    cursorModel?: string | null;
    copilotModel?: string | null;
  } | null,
  taskAgentType?: string | null,
): ResolvedCodingModels {
  const profile = resolveModelProfile(profileName);
  const coding = profile?.coding;
  const agentType = taskAgentType ?? coding?.agentType ?? repoConfig?.defaultAgentType ?? undefined;

  const resolved: ResolvedCodingModels = { agentType };
  if (agentType === "cursor") {
    resolved.cursorModel = coding?.model ?? repoConfig?.cursorModel ?? undefined;
  } else if (agentType === "claude-code") {
    resolved.claudeModel = coding?.model ?? repoConfig?.claudeModel ?? undefined;
  } else if (agentType === "codex" || agentType === "copilot") {
    resolved.copilotModel = coding?.model ?? repoConfig?.copilotModel ?? undefined;
  }
  return resolved;
}

export function resolveReviewModelsForTask(
  profileName: string | null | undefined,
  repoConfig: {
    reviewAgentType?: string | null;
    reviewModel?: string | null;
    defaultAgentType?: string | null;
  } | null,
): ResolvedReviewModels {
  const profile = resolveModelProfile(profileName);
  const review = profile?.review;
  return {
    agentType:
      review?.agentType ?? repoConfig?.reviewAgentType ?? repoConfig?.defaultAgentType ?? undefined,
    model: review?.model ?? repoConfig?.reviewModel ?? undefined,
    effort: review?.effort,
  };
}

export function modelProfileFromTriggerConfig(
  config: Record<string, unknown> | null | undefined,
): string | null {
  if (!config) return null;
  const explicit = config.modelProfile;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const labels = Array.isArray(config.labels) ? (config.labels as string[]) : [];
  const doc = loadModelProfiles();
  if (!doc?.profiles) return null;
  for (const [name, profile] of Object.entries(doc.profiles)) {
    if (profile.label && labels.includes(profile.label)) return name;
  }
  return null;
}
