#!/usr/bin/env node
/**
 * Headless Cursor Composer runner for Optio agent pods.
 * Emits NDJSON events on stdout for the task worker log parser.
 */
import { Agent } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY;
const model = process.env.OPTIO_CURSOR_MODEL || "composer-2.5";
const prompt = process.env.OPTIO_PROMPT;

function emit(event) {
  console.log(JSON.stringify(event));
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

  emit({ type: "system", subtype: "init", model });

  try {
    const result = await Agent.prompt(prompt, {
      apiKey,
      model: { id: model },
      local: { cwd: process.cwd() },
    });

    if (result.result) {
      emit({ type: "message", role: "assistant", content: result.result, model });
    }

    emit({
      type: "result",
      result: result.result ?? "",
      status: result.status,
      model,
      is_error: result.status === "error",
    });

    process.exit(result.status === "error" ? 1 : 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message });
    emit({ type: "result", result: message, status: "error", is_error: true, model });
    process.exit(1);
  }
}

main();
