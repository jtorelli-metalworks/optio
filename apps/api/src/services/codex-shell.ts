/**
 * Shell fragments for headless Codex CLI execution inside repo pods.
 *
 * Codex 0.136+ no longer authenticates from OPENAI_API_KEY alone — the CLI
 * reads cached credentials from ~/.codex/auth.json. In api-key mode we must
 * run `codex login --with-api-key` before exec. Worktrees under
 * /workspace/tasks/* also need explicit trust in config.toml.
 */

export const CODEX_REPO_TRUST_PATH = "/workspace/repo";
export const CODEX_TASKS_TRUST_PATH = "/workspace/tasks";

/** Bash lines run before `codex exec` when OPTIO_CODEX_AUTH_MODE is api-key (default). */
export function buildCodexApiKeyLoginLines(): string[] {
  return [
    `if [ "\${OPTIO_CODEX_AUTH_MODE:-api-key}" = "api-key" ]; then`,
    `  if [ -z "\${OPENAI_API_KEY:-}" ]; then`,
    `    echo "[optio] ERROR: OPENAI_API_KEY is required for Codex api-key mode" >&2`,
    `    exit 1`,
    `  fi`,
    `  mkdir -p "\${CODEX_HOME:-$HOME/.codex}"`,
    `  rm -f "\${CODEX_HOME:-$HOME/.codex}/auth.json"`,
    `  printf '%s' "\$OPENAI_API_KEY" | codex login --with-api-key`,
    `  echo "[optio] Codex API key login complete"`,
    `fi`,
  ];
}

/** Ensure the current worktree and shared task paths are trusted by Codex. */
export function buildCodexTrustConfigLines(): string[] {
  return [
    `mkdir -p "\${CODEX_HOME:-$HOME/.codex}"`,
    `WORKTREE="$(pwd)"`,
    `python3 - <<'PY'`,
    `import os`,
    `from pathlib import Path`,
    ``,
    `home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))`,
    `home.mkdir(parents=True, exist_ok=True)`,
    `cfg = home / "config.toml"`,
    `worktree = os.getcwd()`,
    `paths = {`,
    `    "/workspace/repo": "trusted",`,
    `    "/workspace/tasks": "trusted",`,
    `    worktree: "trusted",`,
    `}`,
    `lines = cfg.read_text().splitlines() if cfg.exists() else []`,
    `for path, level in paths.items():`,
    `    header = f'[projects."{path}"]'`,
    `    if any(l.strip() == header for l in lines):`,
    `        continue`,
    `    if lines and lines[-1].strip():`,
    `        lines.append("")`,
    `    lines.extend([header, f"trust_level = \\"{level}\\""])`,
    `cfg.write_text("\\n".join(lines) + ("\\n" if lines else ""))`,
    `print(f"[optio] Codex trust configured for {worktree}")`,
    `PY`,
  ];
}

/** Full pre-exec setup: login (api-key mode) + worktree trust. */
export function buildCodexShellSetupLines(): string[] {
  return [...buildCodexApiKeyLoginLines(), ...buildCodexTrustConfigLines()];
}

/** Sandbox for headless Codex in repo pods. `workspace-write` uses bubblewrap, which fails in
 *  typical K8s containers (`bwrap: Failed to make / slave: Permission denied`), blocking `gh`
 *  and other tools. Pods are already isolated — use full access inside the worktree. */
export const CODEX_HEADLESS_SANDBOX = "danger-full-access";

/** Build the `codex exec` invocation (sandbox + optional model/app-server). */
export function buildCodexExecInvocation(env: Record<string, string>): string {
  const appServerFlag =
    env.OPTIO_CODEX_AUTH_MODE === "app-server" && env.OPTIO_CODEX_APP_SERVER_URL
      ? ` --app-server ${JSON.stringify(env.OPTIO_CODEX_APP_SERVER_URL)}`
      : "";
  const model = env.COPILOT_MODEL ?? env.OPTIO_CODEX_MODEL;
  const modelFlag = model ? ` --model ${JSON.stringify(model)}` : "";
  const reasoningEffort = env.CODEX_REASONING_EFFORT ?? env.OPTIO_CODEX_REASONING_EFFORT;
  const reasoningFlag = reasoningEffort
    ? ` -c ${JSON.stringify(`model_reasoning_effort="${reasoningEffort}"`)}`
    : "";
  // Codex 0.136+ reads optional follow-up input from stdin after the argv prompt.
  // K8s exec keeps stdin open as an empty pipe — without EOF, codex blocks forever.
  return `codex exec --sandbox ${CODEX_HEADLESS_SANDBOX}${modelFlag}${reasoningFlag} "$OPTIO_PROMPT"${appServerFlag} --json </dev/null`;
}

/** Echo + setup + exec lines for buildAgentCommand and sibling workers. */
export function buildCodexAgentCommandLines(
  env: Record<string, string>,
  label = "OpenAI Codex",
): string[] {
  const appServerHint =
    env.OPTIO_CODEX_AUTH_MODE === "app-server" && env.OPTIO_CODEX_APP_SERVER_URL
      ? " (app-server)"
      : "";
  return [
    ...buildCodexShellSetupLines(),
    `echo "[optio] Running ${label}${appServerHint}..."`,
    buildCodexExecInvocation(env),
  ];
}
