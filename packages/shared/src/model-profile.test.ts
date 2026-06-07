import { afterEach, describe, expect, it } from "vitest";
import {
  modelProfileFromTriggerConfig,
  resetModelProfilesCache,
  resolveCodingModelsForTask,
  resolveReviewModelsForTask,
} from "./model-profile.js";

const PROFILES_JSON = JSON.stringify({
  profiles: {
    standard: {
      label: "agent-ready",
      coding: { provider: "cursor", model: "composer-2.5", agentType: "cursor" },
      review: { provider: "openai", model: "gpt-5.3-codex", agentType: "codex", effort: "xhigh" },
    },
    expert: {
      label: "expert-agent-ready",
      coding: { provider: "anthropic", model: "opus", agentType: "claude-code" },
      review: { provider: "anthropic", model: "sonnet", agentType: "claude-code" },
    },
  },
});

afterEach(() => {
  delete process.env.OPTIO_MODEL_PROFILES_JSON;
  resetModelProfilesCache();
});

describe("model-profile", () => {
  it("resolves standard coding and review models", () => {
    process.env.OPTIO_MODEL_PROFILES_JSON = PROFILES_JSON;
    expect(
      resolveCodingModelsForTask(
        "standard",
        {
          defaultAgentType: "cursor",
          cursorModel: "composer-2.5",
          claudeModel: "sonnet",
        },
        "cursor",
      ),
    ).toEqual({
      agentType: "cursor",
      cursorModel: "composer-2.5",
    });
    expect(
      resolveReviewModelsForTask("standard", {
        reviewModel: "haiku",
        reviewAgentType: "claude-code",
      }),
    ).toEqual({
      agentType: "codex",
      model: "gpt-5.3-codex",
      effort: "xhigh",
    });
  });

  it("resolves expert coding and review models", () => {
    process.env.OPTIO_MODEL_PROFILES_JSON = PROFILES_JSON;
    expect(
      resolveCodingModelsForTask(
        "expert",
        {
          defaultAgentType: "cursor",
          cursorModel: "composer-2.5",
          claudeModel: "sonnet",
        },
        "claude-code",
      ),
    ).toEqual({
      agentType: "claude-code",
      claudeModel: "opus",
    });
    expect(
      resolveReviewModelsForTask("expert", {
        reviewModel: "opus",
        reviewAgentType: "claude-code",
      }),
    ).toEqual({
      agentType: "claude-code",
      model: "sonnet",
      effort: undefined,
    });
  });

  it("derives profile name from trigger label config", () => {
    process.env.OPTIO_MODEL_PROFILES_JSON = PROFILES_JSON;
    expect(modelProfileFromTriggerConfig({ source: "jira", labels: ["expert-agent-ready"] })).toBe(
      "expert",
    );
    expect(modelProfileFromTriggerConfig({ modelProfile: "standard" })).toBe("standard");
  });
});
