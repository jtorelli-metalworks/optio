import type { AgentLogEntry } from "@optio/shared";

/**
 * Parse a single NDJSON line from the Codex CLI's --json output.
 *
 * Codex outputs events as one JSON object per line:
 * - { type: "message", role: "assistant"|"system", content: "..." }
 * - { type: "function_call", name: "shell"|"...", call_id: "...", arguments: "..." }
 * - { type: "function_call_output", call_id: "...", output: "..." }
 * - { type: "error", message: "..." }
 * - Events with usage data (input_tokens, output_tokens)
 *
 * Returns multiple entries per line when a message contains structured content.
 */
export function parseCodexEvent(
  line: string,
  taskId: string,
): { entries: AgentLogEntry[]; sessionId?: string; isTerminal?: boolean } {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    // Not JSON — raw text from shell/git
    if (!line.trim()) return { entries: [] };
    const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]|\r/g, "").trim();
    if (!clean || clean.length < 2) return { entries: [] };
    return {
      entries: [{ taskId, timestamp: new Date().toISOString(), type: "text", content: clean }],
    };
  }

  const timestamp = new Date().toISOString();
  const entries: AgentLogEntry[] = [];

  // Extract session/conversation ID if present
  const sessionId = (event.id ?? event.session_id ?? event.conversation_id) as string | undefined;

  // System message or init
  if (event.type === "message" && event.role === "system") {
    const content =
      typeof event.content === "string" ? event.content : JSON.stringify(event.content);
    if (content?.trim()) {
      entries.push({
        taskId,
        timestamp,
        sessionId,
        type: "system",
        content,
      });
    }
    return { entries, sessionId };
  }

  // Assistant message
  if (event.type === "message" && event.role === "assistant") {
    const content =
      typeof event.content === "string"
        ? event.content
        : Array.isArray(event.content)
          ? event.content
              .map((block: any) => {
                if (typeof block === "string") return block;
                if (block.type === "text") return block.text;
                if (block.type === "output_text") return block.text;
                return "";
              })
              .filter(Boolean)
              .join("\n")
          : "";
    if (content?.trim()) {
      entries.push({
        taskId,
        timestamp,
        sessionId,
        type: "text",
        content,
      });
    }

    // Check for usage data in the message event
    const usage = event.usage ?? event.response?.usage;
    if (usage) {
      const meta: string[] = [];
      const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
      if (inputTokens) meta.push(`${inputTokens} input tokens`);
      if (outputTokens) meta.push(`${outputTokens} output tokens`);
      if (event.total_cost_usd) meta.push(`$${event.total_cost_usd.toFixed(4)}`);
      if (meta.length) {
        entries.push({
          taskId,
          timestamp,
          sessionId,
          type: "info",
          content: `Usage: ${meta.join(" · ")}`,
          metadata: {
            inputTokens,
            outputTokens,
            cost: event.total_cost_usd,
          },
        });
      }
    }
    return { entries, sessionId };
  }

  // Function call (tool use)
  if (event.type === "function_call") {
    const args = parseArgs(event.arguments);
    const formatted = formatCodexToolUse(event.name, args);
    entries.push({
      taskId,
      timestamp,
      sessionId,
      type: "tool_use",
      content: formatted,
      metadata: {
        toolName: event.name,
        toolInput: args,
        toolUseId: event.call_id,
      },
    });
    return { entries, sessionId };
  }

  // Function call output (tool result)
  if (event.type === "function_call_output") {
    const output = typeof event.output === "string" ? event.output : JSON.stringify(event.output);
    const trimmed = output.length > 300 ? output.slice(0, 300) + "…" : output;
    if (trimmed.trim()) {
      entries.push({
        taskId,
        timestamp,
        sessionId,
        type: "tool_result",
        content: trimmed,
        metadata: { toolUseId: event.call_id },
      });
    }
    return { entries, sessionId };
  }

  // Codex exec JSONL protocol (v0.13+): thread.turn.item.* events
  if (event.type === "thread.started") {
    const threadId = (event.thread_id ?? event.threadId) as string | undefined;
    return { entries, sessionId: threadId ?? sessionId };
  }

  if (event.type === "turn.failed") {
    const msg =
      event.message ??
      event.error?.message ??
      (typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? event));
    entries.push({
      taskId,
      timestamp,
      sessionId,
      type: "error",
      content: msg,
    });
    return { entries, sessionId, isTerminal: true };
  }

  if (event.type === "turn.completed") {
    const usage = event.usage;
    if (usage) {
      const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
      const meta: string[] = [];
      if (inputTokens) meta.push(`${inputTokens} input tokens`);
      if (outputTokens) meta.push(`${outputTokens} output tokens`);
      if (meta.length) {
        entries.push({
          taskId,
          timestamp,
          sessionId,
          type: "info",
          content: `Usage: ${meta.join(" · ")}`,
          metadata: { inputTokens, outputTokens },
        });
      }
    }
    return { entries, sessionId, isTerminal: true };
  }

  if (event.type === "item.started" || event.type === "item.updated") {
    const item = event.item ?? {};
    const itemType = item.type ?? item.item_type;
    if (itemType === "command_execution") {
      const cmd = item.command ?? item.cmd ?? "";
      if (cmd) {
        entries.push({
          taskId,
          timestamp,
          sessionId,
          type: "tool_use",
          content: `$ ${String(cmd).split("\n")[0].slice(0, 120)}`,
          metadata: { toolName: "shell" },
        });
      }
    }
    return { entries, sessionId };
  }

  if (event.type === "item.completed") {
    const item = event.item ?? {};
    const itemType = item.type ?? item.item_type;
    const text = item.text ?? item.content ?? "";
    if (
      (itemType === "agent_message" || itemType === "assistant_message") &&
      typeof text === "string" &&
      text.trim()
    ) {
      entries.push({
        taskId,
        timestamp,
        sessionId,
        type: "text",
        content: text,
      });
    } else if (itemType === "command_execution") {
      const cmd = item.command ?? item.cmd ?? "";
      const output = item.output ?? item.result ?? "";
      if (cmd) {
        entries.push({
          taskId,
          timestamp,
          sessionId,
          type: "tool_use",
          content: `$ ${String(cmd).split("\n")[0].slice(0, 120)}`,
          metadata: { toolName: "shell" },
        });
      }
      if (output && String(output).trim()) {
        const trimmed =
          String(output).length > 300 ? `${String(output).slice(0, 300)}…` : String(output);
        entries.push({
          taskId,
          timestamp,
          sessionId,
          type: "tool_result",
          content: trimmed,
        });
      }
    }
    return { entries, sessionId };
  }

  // Error event (legacy + thread.error)
  if (event.type === "error") {
    const msg = event.message ?? event.error?.message ?? event.error ?? JSON.stringify(event);
    entries.push({
      taskId,
      timestamp,
      sessionId,
      type: "error",
      content: typeof msg === "string" ? msg : JSON.stringify(msg),
    });
    return { entries, sessionId, isTerminal: true };
  }

  // Reasoning/thinking event (some Codex models output this)
  if (event.type === "reasoning") {
    const content = typeof event.content === "string" ? event.content : "";
    if (content.trim()) {
      entries.push({
        taskId,
        timestamp,
        sessionId,
        type: "thinking",
        content,
      });
    }
    return { entries, sessionId };
  }

  // Generic event with usage data (summary)
  if (event.usage || event.response?.usage) {
    const usage = event.usage ?? event.response.usage;
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
    const meta: string[] = [];
    if (inputTokens) meta.push(`${inputTokens} input tokens`);
    if (outputTokens) meta.push(`${outputTokens} output tokens`);
    if (event.total_cost_usd) meta.push(`$${event.total_cost_usd.toFixed(4)}`);
    if (meta.length) {
      entries.push({
        taskId,
        timestamp,
        sessionId,
        type: "info",
        content: `Usage: ${meta.join(" · ")}`,
        metadata: {
          inputTokens,
          outputTokens,
          cost: event.total_cost_usd,
        },
      });
    }
    return { entries, sessionId };
  }

  // Unknown JSON event — skip
  return { entries: [], sessionId };
}

/** Parse function call arguments (may be a JSON string or object) */
function parseArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args) return undefined;
  if (typeof args === "object") return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return { raw: args };
    }
  }
  return undefined;
}

/** Format a Codex tool use into a concise human-readable string */
function formatCodexToolUse(name: string, args: Record<string, unknown> | undefined): string {
  if (!name) return "unknown tool";
  if (!args) return name;

  switch (name) {
    case "shell":
    case "bash":
    case "terminal":
      return `$ ${String(args.command ?? args.cmd ?? "")
        .split("\n")[0]
        .slice(0, 120)}`;
    case "read_file":
    case "readFile":
      return `Read ${args.path ?? args.file_path ?? ""}`;
    case "write_file":
    case "writeFile":
    case "create_file":
      return `Write ${args.path ?? args.file_path ?? ""}`;
    case "edit_file":
    case "editFile":
    case "apply_diff":
      return `Edit ${args.path ?? args.file_path ?? ""}`;
    case "search":
    case "grep":
      return `Search: ${args.query ?? args.pattern ?? ""}`;
    case "list_dir":
    case "listDir":
      return `List ${args.path ?? args.dir ?? "."}`;
    default:
      return name;
  }
}
