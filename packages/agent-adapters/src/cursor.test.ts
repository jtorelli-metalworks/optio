import { describe, it, expect } from "vitest";
import { CursorAdapter } from "./cursor.js";

describe("CursorAdapter", () => {
  const adapter = new CursorAdapter();

  describe("metadata", () => {
    it("has correct type and display name", () => {
      expect(adapter.type).toBe("cursor");
      expect(adapter.displayName).toBe("Cursor Composer");
    });
  });

  describe("validateSecrets", () => {
    it("requires CURSOR_API_KEY", () => {
      const result = adapter.validateSecrets([]);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["CURSOR_API_KEY"]);
    });

    it("passes when CURSOR_API_KEY is present", () => {
      const result = adapter.validateSecrets(["CURSOR_API_KEY"]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });
  });

  describe("buildContainerConfig", () => {
    it("sets cursor env vars and defaults model to composer-2.5", () => {
      const config = adapter.buildContainerConfig({
        taskId: "task-1",
        prompt: "Fix the bug",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "main",
      });

      expect(config.env.OPTIO_AGENT_TYPE).toBe("cursor");
      expect(config.env.OPTIO_CURSOR_MODEL).toBe("composer-2.5");
      expect(config.env.OPTIO_PROMPT).toBe("Fix the bug");
      expect(config.requiredSecrets).toEqual(["CURSOR_API_KEY"]);
    });

    it("uses configured cursorModel", () => {
      const config = adapter.buildContainerConfig({
        taskId: "task-1",
        prompt: "Build feature",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "main",
        cursorModel: "composer-2-fast",
      });

      expect(config.env.OPTIO_CURSOR_MODEL).toBe("composer-2-fast");
    });
  });

  describe("parseResult", () => {
    it("extracts PR URL and success from NDJSON logs", () => {
      const logs = [
        '{"type":"system","subtype":"init","model":"composer-2.5"}',
        '{"type":"message","role":"assistant","content":"Opened PR"}',
        '{"type":"result","result":"Done","status":"completed","model":"composer-2.5"}',
        "https://github.com/org/repo/pull/42",
      ].join("\n");

      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(true);
      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
      expect(result.model).toBe("composer-2.5");
    });

    it("marks failure on error events", () => {
      const logs = '{"type":"error","message":"Invalid API key"}';
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid API key");
    });
  });
});
