import type { AgentTaskInput, AgentContainerConfig, AgentResult } from "@optio/shared";
import { TASK_BRANCH_PREFIX } from "@optio/shared";
import type { AgentAdapter } from "./types.js";

/**
 * Cursor Agent via @cursor/sdk (headless Composer).
 * The runner script emits NDJSON lines compatible with the OpenClaw parser shape.
 */
export class CursorAdapter implements AgentAdapter {
  readonly type = "cursor";
  readonly displayName = "Cursor Composer";

  validateSecrets(availableSecrets: string[]): { valid: boolean; missing: string[] } {
    const required = ["CURSOR_API_KEY"];
    const missing = required.filter((s) => !availableSecrets.includes(s));
    return { valid: missing.length === 0, missing };
  }

  buildContainerConfig(input: AgentTaskInput): AgentContainerConfig {
    const prompt = input.renderedPrompt ?? input.prompt;

    const env: Record<string, string> = {
      OPTIO_TASK_ID: input.taskId,
      OPTIO_REPO_URL: input.repoUrl,
      OPTIO_REPO_BRANCH: input.repoBranch,
      OPTIO_PROMPT: prompt,
      OPTIO_AGENT_TYPE: "cursor",
      OPTIO_BRANCH_NAME: `${TASK_BRANCH_PREFIX}${input.taskId}`,
      OPTIO_CURSOR_MODEL: input.cursorModel ?? "composer-2.5",
    };

    const setupFiles: AgentContainerConfig["setupFiles"] = [];

    if (input.taskFileContent && input.taskFilePath) {
      setupFiles.push({
        path: input.taskFilePath,
        content: input.taskFileContent,
      });
    }

    return {
      command: ["/opt/optio/entrypoint.sh"],
      env,
      requiredSecrets: ["CURSOR_API_KEY"],
      setupFiles,
    };
  }

  parseResult(exitCode: number, logs: string): AgentResult {
    const prMatch = logs.match(
      /https:\/\/(?![\w.-]+\/api\/)[^\s"]+\/(?:pull\/\d+|-\/merge_requests\/\d+)/,
    );
    const { costUsd, errorMessage, hasError, summary, inputTokens, outputTokens, model } =
      this.parseLogs(logs);

    const success = exitCode === 0 && !hasError;

    return {
      success,
      prUrl: prMatch?.[0],
      costUsd,
      inputTokens,
      outputTokens,
      model,
      summary:
        summary ??
        (success ? "Agent completed successfully" : `Agent exited with code ${exitCode}`),
      error: !success ? (errorMessage ?? `Exit code: ${exitCode}`) : undefined,
    };
  }

  private parseLogs(logs: string): {
    costUsd?: number;
    errorMessage?: string;
    hasError: boolean;
    summary?: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  } {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let directCost: number | undefined;
    let model: string | undefined;
    let errorMessage: string | undefined;
    let hasError = false;
    let lastAssistantMessage: string | undefined;

    for (const line of logs.split("\n")) {
      if (!line.trim()) continue;

      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        if (!errorMessage && isRawTextError(line)) {
          errorMessage = line.trim();
          hasError = true;
        }
        continue;
      }

      if (event.model && !model) {
        model = event.model;
      }

      if (event.error && typeof event.error === "object" && event.error.message) {
        errorMessage = event.error.message;
        hasError = true;
        continue;
      }

      if (event.type === "error") {
        errorMessage = event.message ?? event.error ?? JSON.stringify(event);
        hasError = true;
        continue;
      }

      if (event.status === "error") {
        errorMessage = event.result ?? "Cursor agent failed";
        hasError = true;
      }

      if (event.type === "message" && event.role === "assistant" && event.content) {
        if (typeof event.content === "string") {
          lastAssistantMessage = event.content;
        }
      }

      if (event.type === "result" && event.result && event.status !== "error") {
        if (typeof event.result === "string") {
          lastAssistantMessage = event.result;
        }
      }

      const usage = event.usage ?? event.response?.usage;
      if (usage) {
        if (usage.input_tokens) totalInputTokens += usage.input_tokens;
        if (usage.output_tokens) totalOutputTokens += usage.output_tokens;
        if (usage.prompt_tokens) totalInputTokens += usage.prompt_tokens;
        if (usage.completion_tokens) totalOutputTokens += usage.completion_tokens;
      }

      if (event.total_cost_usd != null) {
        directCost = event.total_cost_usd;
      }
    }

    return {
      costUsd: directCost,
      errorMessage,
      hasError,
      summary: lastAssistantMessage ? truncate(lastAssistantMessage, 200) : undefined,
      inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
      outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
      model,
    };
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\u2026";
}

function isRawTextError(line: string): boolean {
  if (
    /error|failed|fatal/i.test(line) &&
    /CURSOR_API_KEY|cursor.*auth|authentication|unauthorized|forbidden/i.test(line)
  ) {
    return true;
  }
  if (/invalid.*api.?key|model.*not found|invalid.*model/i.test(line)) {
    return true;
  }
  return false;
}
