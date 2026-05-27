# Cursor Agent (Composer)

Optio can run **Cursor Composer** as a coding agent using the [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript) package inside agent pods.

## Requirements

| Secret           | Scope                                           |
| ---------------- | ----------------------------------------------- |
| `CURSOR_API_KEY` | Workspace global (or per-repo via secret proxy) |

Generate an API key from your Cursor account settings.

## Repo configuration

| Field              | Example        | Purpose                                     |
| ------------------ | -------------- | ------------------------------------------- |
| `defaultAgentType` | `cursor`       | Use Composer for implement tasks            |
| `cursorModel`      | `composer-2.5` | Model id passed to the SDK                  |
| `reviewAgentType`  | `claude-code`  | Review lane (Composer is coding-only today) |
| `reviewModel`      | `opus`         | Review model slug (Opus 4.7)                |

## Runtime

Agent pods invoke `/opt/optio/run-cursor-agent.mjs`, which calls `Agent.prompt()` with `local: { cwd: worktree }`. stdout is NDJSON for Optio log streaming.

## Limitations

- Review tasks still use Claude Code (or another supported review agent).
- Resume / multi-turn uses one-shot `Agent.prompt()` in v1.
- Requires the cursor-enabled agent image built from this fork.

## Building the agent image

```bash
docker build -f images/base.Dockerfile -t optio-agent-base:cursor .
```
