import { describe, it, expect } from "vitest";
import {
  buildCodexAgentCommandLines,
  buildCodexApiKeyLoginLines,
  buildCodexExecInvocation,
  buildCodexShellSetupLines,
  buildCodexTrustConfigLines,
} from "./codex-shell.js";

describe("codex-shell", () => {
  describe("buildCodexApiKeyLoginLines", () => {
    it("requires OPENAI_API_KEY and runs codex login --with-api-key", () => {
      const lines = buildCodexApiKeyLoginLines().join("\n");
      expect(lines).toContain("OPENAI_API_KEY");
      expect(lines).toContain("codex login --with-api-key");
      expect(lines).toContain('rm -f "${CODEX_HOME:-$HOME/.codex}/auth.json"');
    });
  });

  describe("buildCodexTrustConfigLines", () => {
    it("writes trust entries for repo, tasks root, and current worktree", () => {
      const script = buildCodexTrustConfigLines().join("\n");
      expect(script).toContain("/workspace/repo");
      expect(script).toContain("/workspace/tasks");
      expect(script).toContain("worktree = os.getcwd()");
      expect(script).toContain("trust_level");
    });
  });

  describe("buildCodexExecInvocation", () => {
    it("uses danger-full-access sandbox (bubblewrap workspace-write fails in k8s pods)", () => {
      const cmd = buildCodexExecInvocation({ OPTIO_PROMPT: "review PR" });
      expect(cmd).toContain("--sandbox danger-full-access");
      expect(cmd).not.toContain("--full-auto");
      expect(cmd).not.toContain("workspace-write");
      expect(cmd).toContain("--json");
      expect(cmd).toContain("</dev/null");
    });

    it("passes model from COPILOT_MODEL", () => {
      const cmd = buildCodexExecInvocation({
        OPTIO_PROMPT: "x",
        COPILOT_MODEL: "gpt-5.3-codex",
      });
      expect(cmd).toContain('--model "gpt-5.3-codex"');
    });

    it("passes Codex reasoning effort from CODEX_REASONING_EFFORT", () => {
      const cmd = buildCodexExecInvocation({
        OPTIO_PROMPT: "x",
        CODEX_REASONING_EFFORT: "xhigh",
      });
      expect(cmd).toContain('-c "model_reasoning_effort=\\"xhigh\\""');
    });

    it("includes app-server flag when configured", () => {
      const cmd = buildCodexExecInvocation({
        OPTIO_PROMPT: "x",
        OPTIO_CODEX_AUTH_MODE: "app-server",
        OPTIO_CODEX_APP_SERVER_URL: "ws://localhost:3900/v1/connect",
      });
      expect(cmd).toContain("--app-server");
      expect(cmd).toContain("ws://localhost:3900/v1/connect");
    });
  });

  describe("buildCodexAgentCommandLines", () => {
    it("runs login, trust setup, then codex exec", () => {
      const joined = buildCodexAgentCommandLines({ OPTIO_PROMPT: "Do work" }).join("\n");
      expect(joined).toContain("codex login --with-api-key");
      expect(joined).toContain("Codex trust configured");
      expect(joined).toContain("Running OpenAI Codex");
      expect(joined).toContain("--sandbox danger-full-access");
    });

    it("includes full setup from buildCodexShellSetupLines", () => {
      const setup = buildCodexShellSetupLines().join("\n");
      const full = buildCodexAgentCommandLines({ OPTIO_PROMPT: "x" }).join("\n");
      expect(full).toContain(setup);
    });
  });
});
