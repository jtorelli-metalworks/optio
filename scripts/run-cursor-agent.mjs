#!/usr/bin/env node
/**
 * Headless Cursor Composer runner for Optio agent pods.
 * Emits NDJSON on stdout for the OpenClaw-compatible log parser.
 */
import { Agent, CursorAgentError } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY;
const model = process.env.OPTIO_CURSOR_MODEL || "composer-2.5";
const prompt = process.env.OPTIO_PROMPT;
const worktreeCwd = process.env.OPTIO_WORKTREE_CWD || process.cwd();
// Optio's task worker keys off session_id to detect agent startup (see agent_no_output).
const sessionId = process.env.OPTIO_TASK_ID || `cursor-${Date.now()}`;

function emit(event) {
  console.log(JSON.stringify(event));
}

function emitStreamEvent(event) {
  switch (event.type) {
    case "assistant":
      for (const block of event.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          emit({ type: "message", role: "assistant", content: block.text, model });
        }
        if (block.type === "tool_use") {
          emit({
            type: "tool_call",
            name: block.name,
            call_id: block.id,
            arguments: block.input,
          });
        }
      }
      break;
    case "thinking":
      if (event.text?.trim()) {
        emit({ type: "reasoning", content: event.text });
      }
      break;
    case "tool_call":
      if (event.status === "running") {
        emit({
          type: "tool_call",
          name: event.name,
          call_id: event.call_id,
          arguments: event.args,
        });
      } else {
        emit({
          type: "tool_result",
          call_id: event.call_id,
          output:
            event.result !== undefined
              ? typeof event.result === "string"
                ? event.result
                : JSON.stringify(event.result)
              : event.status,
        });
      }
      break;
    case "status":
      emit({ type: "message", role: "system", content: `Status: ${event.status}` });
      break;
    case "task":
      if (event.text?.trim()) {
        emit({ type: "message", role: "system", content: event.text });
      }
      break;
    case "system":
      if (event.model) {
        emit({ type: "system", subtype: "init", model: event.model, session_id: sessionId });
      }
      break;
    default:
      break;
  }
}

async function main() {
  if (!apiKey) {
    emit({ type: "error", message: "CURSOR_API_KEY is required" });
    process.exit(1);
  }
  if (!prompt) {
    emit({ type: "error", message: "OPTIO_PROMPT is required" });
    process.exit(1);
  }

  emit({ type: "system", subtype: "init", model, session_id: sessionId });
  emit({
    type: "message",
    role: "system",
    content: `Worktree: ${worktreeCwd}`,
    session_id: sessionId,
  });

  let agent;
  try {
    agent = await Agent.create({
      apiKey,
      model: { id: model },
      local: { cwd: worktreeCwd },
    });

    const run = await agent.send(prompt);

    for await (const event of run.stream()) {
      emitStreamEvent(event);
    }

    const result = await run.wait();

    if (result.result) {
      emit({ type: "message", role: "assistant", content: result.result, model });
    }

    emit({
      type: "result",
      result: result.result ?? "",
      status: result.status,
      model,
      session_id: sessionId,
      is_error: result.status === "error" || result.status === "cancelled",
    });

    process.exit(result.status === "error" || result.status === "cancelled" ? 1 : 0);
  } catch (err) {
    const message =
      err instanceof CursorAgentError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    emit({ type: "error", message });
    emit({ type: "result", result: message, status: "error", is_error: true, model });
    process.exit(1);
  } finally {
    if (agent) {
      await agent.dispose();
    }
  }
}

main();
