# CLAUDE.md

Context and conventions for AI assistants working on the Optio codebase.

## What is Optio?

Optio is an orchestration system for AI coding agents. Think of it as "CI/CD where the build step is an AI agent." One primary user-facing concept (Tasks) with one attribute (has a repo) flipping the pipeline, plus shared primitives:

**Tasks** — a configured unit of agent work. A Task has a **Who** (agent type), **What** (prompt or template), **When** (trigger: manual / schedule / webhook / ticket), optional **Where** (repo + branch), and **Why** (description). Tasks come in three flavors:

- **Repo Task** — `Where` is set. The agent clones the repo into a worktree and opens a PR:
  1. Spins up an isolated Kubernetes pod for the repository (pod-per-repo)
  2. Creates a git worktree for the task (multiple run concurrently per repo)
  3. Runs Claude Code, OpenAI Codex, GitHub Copilot, Google Gemini, or OpenCode with the prompt
  4. Streams structured logs back to a web UI in real time
  5. Agent stops after opening a PR (no CI blocking)
  6. PR watcher tracks CI checks, review status, and merge state
  7. Auto-triggers code review agent on CI pass or PR open (if enabled)
  8. Auto-resumes agent when reviewer requests changes (if enabled)
  9. Auto-completes on merge, auto-fails on close

- **Standalone Task** — no `Where`. The agent runs in an isolated pod with no repo checkout, producing logs and side effects (e.g., queries Slack, posts to a database). Scheduled/webhook-driven runs of this flavor are the common case.

- **Persistent Agent** — long-lived, named, message-driven agent process that does _not_ terminate after running. Halts after each turn and waits to be re-woken by a user message, an agent message, a webhook, a cron tick, or a ticket event. Addressable by other agents in the same workspace via the inter-agent HTTP API (`/api/internal/persistent-agents/*`). Three configurable pod lifecycle modes: `always-on`, `sticky` (default, with idle warm window), and `on-demand`. UI at `/agents`. Schema: `persistent_agents`, `persistent_agent_turns`, `persistent_agent_messages`, `persistent_agent_pods`. See `docs/persistent-agents.md` and the demo in `demos/the-forge/`.

**Scheduled (Task Configs)** — a saved Task blueprint that spawns fresh Tasks on a trigger firing. Stored in `task_configs`. Each firing calls `instantiateTask()` which goes through the full Repo Task pipeline. Manageable at `/tasks/scheduled`. Standalone equivalents are stored in `workflows` (see backend-naming note below).

**Triggers** — polymorphic table `workflow_triggers` keyed by `(target_type, target_id)`. `target_type` is `"job"` (Standalone Tasks) or `"task_config"` (Repo Tasks). Trigger types: `manual`, `schedule` (cron), `webhook`, `ticket`. The `workflow-trigger-worker` polls due schedule triggers and dispatches to the correct target service.

**Templates** — reusable prompt templates in `prompt_templates` with a `kind` discriminator (`prompt` / `review` / `job` / `task`). Supports `{{param}}` substitution and `{{#if param}}...{{/if}}` blocks. Rendered lazily on trigger firing so params from the trigger payload substitute into the prompt.

**Connections** — external service integrations injected into agent pods at runtime via MCP (Model Context Protocol). Built-in providers: Notion, GitHub, Slack, Linear, PostgreSQL, Sentry, Filesystem. Also supports custom MCP servers and HTTP APIs. Fine-grained access control (per-repo, per-agent-type, permission levels).

**Backend-naming note.** For historical reasons the tables are `tasks` (Repo Tasks' one-time runs), `task_configs` (Repo Task blueprints), and `workflows` / `workflow_runs` / `workflow_triggers` (Standalone Tasks and their shared trigger surface). The v0.4 UI settled on these user-facing names:

- **Tasks** — Repo Tasks (formerly "Repo Tasks" in copy; now just "Tasks")
- **Jobs** — Standalone Tasks (matches the `/api/jobs` URL and `/jobs/*` web routes)
- **Reviews** — code-review subtasks + external PR reviews (formerly "PR Reviews"; promoted out of `/tasks` into its own top-level slot)
- **Issues** — GitHub Issues queue (promoted to its own top-level nav item)
- **Agents** — Persistent Agents (the third tier; long-lived, message-driven)
- **Prompts** — reusable prompt templates (was "Templates" in the Library)

The sidebar groups these as **Run** (Tasks · Jobs · Reviews · Issues · Scheduled) and **Live** (Agents · Sessions). The `/tasks` hub-with-tabs from earlier versions is gone — each section is its own page now. Legacy `/tasks?tab=...` URLs redirect to the dedicated routes.

For the long-form explanation of how the two flavors map to the three internal types, the polymorphic HTTP layer, and how the UI presents them, see `docs/tasks.md`.

**Unified `/api/tasks` HTTP layer.** All three kinds (`repo-task`, `repo-blueprint`, `standalone`) are reachable through one polymorphic HTTP resource:

- `GET /api/tasks?type=repo-task|repo-blueprint|standalone|all` — unified list
- `POST /api/tasks` — body takes `{ type, ... }`; dispatches to taskService, taskConfigService, or workflowService based on type
- `GET /api/tasks/:id` — resolves the id across all three tables; returns native row tagged with `type` discriminator
- `GET/POST /api/tasks/:id/runs[/:runId]` — polymorphic runs (spawned `tasks` for blueprints, `workflow_runs` for standalone, 405 for ad-hoc)
- `GET/POST/PATCH/DELETE /api/tasks/:id/triggers[/:triggerId]` — polymorphic triggers (405 for ad-hoc repo-task)
- Resolver: `unified-task-service.resolveAnyTaskById()` checks tasks → task_configs → workflows; UUIDs are globally unique so no collision

Legacy `/api/jobs/*` and `/api/task-configs/*` endpoints still work as thin aliases for back-compat.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────────────┐
│   Web UI    │────→│  API Server  │────→│   K8s Pods                  │
│  Next.js    │     │   Fastify    │     │                             │
│  :30310     │     │   :30400     │     │  ┌─ Repo Pod A ──────────┐  │
│             │←ws──│              │     │  │ clone + sleep          │  │
│  Run        │     │ - BullMQ     │     │  │ ├─ worktree 1          │  │
│   Tasks     │     │ - Drizzle    │     │  │ ├─ worktree 2          │  │
│   Jobs      │     │ - WebSocket  │     │  │ └─ worktree N          │  │
│   Reviews   │     │ - PR Watcher │     │  └────────────────────────┘  │
│   Issues    │     │ - Workflow Q │     │  ┌─ Job Pod ─────────────┐  │
│   Scheduled │     │ - PA Worker  │     │  │ isolated agent         │  │
│  Live       │     │ - Reconciler │     │  └────────────────────────┘  │
│   Agents    │     │ - Health Mon │     │  ┌─ Persistent Agent Pod ┐  │
│   Sessions  │     │ - Connection │     │  │ long-lived; turns      │  │
│             │     │   Service    │     │  │ wake on messages       │  │
└─────────────┘     └──────┬───────┘     │  └────────────────────────┘  │
                           │             └──────────────────────────────┘
                    ┌──────┴───────┐
                    │  Postgres    │  State, logs, workflows, persistent agents,
                    │              │  inboxes, connections, secrets
                    │  Redis       │  Job queue, pub/sub
                    └──────────────┘

All services run in Kubernetes (including API and web). Local dev uses
Docker Desktop K8s with Helm. See setup-local.sh.
```

### Pod-per-repo with worktrees

Central optimization. Instead of one pod per task (slow, wasteful), one long-lived pod per repository:

- Pod clones repo once, runs `sleep infinity`. Tasks `exec` in: `git worktree add` → run agent → cleanup
- Multiple tasks run concurrently per pod (one per worktree)
- Pods use persistent volumes; idle for 10 min (`OPTIO_REPO_POD_IDLE_MS`) before cleanup
- Entrypoints: `scripts/repo-init.sh` (pod), `scripts/agent-entrypoint.sh` (legacy)

**Multi-pod scaling**: repos can have multiple pod instances for higher throughput.

- `maxPodInstances` (default 1, max 20) — pod replicas per repo
- `maxAgentsPerPod` (default 2, max 50) — concurrent agents per pod
- Total capacity = `maxPodInstances × maxAgentsPerPod`
- Pod scheduling: same-pod retry affinity → least-loaded → dynamic scale-up → queue overflow
- LIFO scaling: higher-index pods removed first on idle cleanup

### Worktree lifecycle

Tasks track worktree state via `tasks.worktreeState`: `active`, `dirty`, `reset`, `preserved`, `removed`. `tasks.lastPodId` enables same-pod retry affinity. See `repo-cleanup-worker` for cleanup rules.

### Task lifecycle (state machine)

```
pending → queued → provisioning → running → pr_opened → completed
                                    ↓  ↑        ↓  ↑
                               needs_attention   needs_attention
                                    ↓                ↓
                                 cancelled         cancelled
                               running → failed → queued (retry)
```

State machine in `packages/shared/src/utils/state-machine.ts`. All transitions validated — invalid ones throw `InvalidTransitionError`. Always use `taskService.transitionTask()`.

### Priority queue and concurrency

Tasks have integer `priority` (lower = higher). Two concurrency limits:

1. **Global**: `OPTIO_MAX_CONCURRENT` (default 5) — total running/provisioning tasks
2. **Per-repo**: `repos.maxConcurrentTasks` (default 2) — effective limit is `max(maxConcurrentTasks, maxPodInstances × maxAgentsPerPod)`

When a limit is hit, task is re-queued with 10s delay.

### Authentication

**Web UI**: Multi-provider OAuth (GitHub, Google, GitLab, generic OIDC). Enable by setting `<PROVIDER>_OAUTH_CLIENT_ID` + `<PROVIDER>_OAUTH_CLIENT_SECRET` (or `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET` for generic OIDC). Sessions use SHA256-hashed tokens (30-day TTL). Local dev bypass: `OPTIO_AUTH_DISABLED=true`.

**Claude Code** (four modes, selected in setup wizard):

- **API Key**: `ANTHROPIC_API_KEY` env var injected into agent pods
- **OAuth Token** (recommended for k8s): `CLAUDE_CODE_OAUTH_TOKEN` encrypted secret injected into pods
- **Vertex AI** (GCP workloads): Routes through Google Cloud Vertex AI. Uses `CLAUDE_VERTEX_PROJECT_ID`, `CLAUDE_VERTEX_REGION`, and optional `CLAUDE_VERTEX_SERVICE_ACCOUNT_KEY` (encrypted, global scope). Falls back to workload identity when no service account key provided. Service account keys written to `/home/agent/.config/gcloud/gsa-key.json` with chmod 600
- **Max Subscription** (legacy, local dev only): reads from host macOS Keychain

### Key subsystems

These are well-documented in code; read the relevant service files for details:

- **PR watcher** (`pr-watcher-worker.ts`): polls PRs every 30s, tracks CI/review, triggers reviews, auto-resumes, handles merge/close
- **Code review agent** (`review-service.ts`): launches review as blocking subtask, uses `repos.reviewModel` (defaults to sonnet)
- **Subtask system**: three types (child, step, review) via `parentTaskId`, with `blocksParent` for synchronization
- **Prompt templates**: `{{VARIABLE}}` + `{{#if VAR}}...{{/if}}` syntax. Priority: repo override → global default → hardcoded fallback
- **Shared cache directories**: per-repo persistent PVCs for tool caches (npm, pip, cargo, etc.), managed via `/api/repos/:id/shared-directories`
- **Interactive sessions**: persistent workspaces with terminal + agent chat, at `/sessions`
- **Workspaces**: multi-tenancy via `workspaceId` column. Roles (admin/member/viewer) in schema but not fully enforced
- **Standalone Tasks / Jobs** (`workflow-service.ts`, `workflow-worker.ts`): top-level **Jobs** nav item under "Run" (list at `/jobs`, detail at `/jobs/:id`, runs at `/jobs/:id/runs/:runId`). Agent runs with no repo, `{{PARAM}}` prompt templates, four trigger types (manual/schedule/webhook/ticket), pooled pod execution, real-time log streaming, auto-retry with exponential backoff. Pods are **shared across runs within a workflow**, keyed on `(workflow_id, instance_index)`: each workflow has `workflows.maxPodInstances` pod replicas (default 1, max 20) and `workflows.maxAgentsPerPod` concurrent runs per pod (default 2, max 50) — mirrors repo pod scaling. Runs track their assigned pod via `workflow_runs.pod_id` and remember it for retry affinity via `last_pod_id`. Schema: `workflows`, `workflow_triggers`, `workflow_runs`, `workflow_run_logs`, `workflow_pods`
- **Repo Task Configs** (`task-config-service.ts`, routes in `task-configs.ts`): reusable Repo Task blueprints that spawn tasks when triggers fire. `instantiateTask(configId, { triggerId, params })` creates a task with rendered prompt + title, transitions it to QUEUED, and enqueues the BullMQ job. UI at `/tasks/scheduled`. Schema: `task_configs`
- **Triggers** (`workflow-trigger-service.ts`, `workflow-trigger-worker.ts`): polymorphic trigger table (`workflow_triggers`) keyed by `(target_type, target_id)`. `target_type="job"` dispatches to `createWorkflowRun`; `target_type="task_config"` dispatches to `instantiateTask`. Schedule trigger worker polls every 60s (`OPTIO_WORKFLOW_TRIGGER_INTERVAL`).
- **Prompts / Templates** (`prompt-template-service.ts`, routes in `prompt-templates.ts`): reusable prompt templates with `kind` discriminator (`prompt` / `review` / `job` / `task`). `renderTemplateString(template, params)` handles `{{param}}` substitution + `{{#if}}` blocks. UI at `/templates` (labeled **Prompts** in the Library nav as of v0.4 — the "Templates" name was freed for other use).
- **Persistent Agents** (`persistent-agent-service.ts`, workers `persistent-agent-worker.ts` / `persistent-agent-cleanup-worker.ts`, routes in `persistent-agents.ts` and `internal/persistent-agents.ts`): the third Task tier — long-lived, named, message-driven. Cyclic state machine (`idle → queued → provisioning → running → idle`), per-agent pod lifecycle modes (`always-on` / `sticky` / `on-demand`). Wake sources: user/agent messages, webhook, cron tick, ticket event, system. Inter-agent HTTP API at `/api/internal/persistent-agents/*` (auth via `X-Optio-Agent-Token`). UI at `/agents` (under "Live"). Schema: `persistent_agents`, `persistent_agent_turns`, `persistent_agent_turn_logs`, `persistent_agent_messages`, `persistent_agent_pods`. See `docs/persistent-agents.md` and the demo in `demos/the-forge/`.
- **Connections** (`connection-service.ts`): external service integrations via MCP. Built-in providers: Notion, GitHub, Slack, Linear, PostgreSQL, Sentry, Filesystem. Also supports custom MCP servers and HTTP APIs. Three-layer model: providers (catalog) → connections (configured instances) → assignments (per-repo/agent-type rules). Injected into agent pods at task runtime via `getConnectionsForTask()` in task-worker
- **Reconciliation control plane** (`workers/reconcile-worker.ts`, `services/reconcile-{snapshot,executor,queue}.ts`, `packages/shared/src/reconcile/`): K8s-style reconciler with four `RunKind`s — `repo` (Repo Task runs in `tasks`), `standalone` (Job runs in `workflow_runs`), `pr-review` (external PR reviews), and `persistent-agent` (Persistent Agents in `persistent_agents`). Pure decision functions consume a frozen `WorldSnapshot` and return a typed `Action`; the executor applies it under CAS so concurrent passes can't trample each other. Producers — `taskService.transitionTask`, `workflow-worker`'s `transitionRun`, `pr-watcher` poll cycle, `repo-cleanup` pod-health detection, `wakeAgent()` (PA inbox + trigger dispatch) — wake the reconciler via `enqueueReconcile`. Periodic resync (`OPTIO_RECONCILE_RESYNC_INTERVAL`, 5 min) catches anything missed. The reconciler owns: PR-driven transitions (auto-merge, complete-on-merge, fail-on-close), auto-resume on CI/conflict/review (capped by `OPTIO_MAX_AUTO_RESUMES`), review launch, stall + pod-death detection, control-intent (cancel/retry/resume/restart), and the Persistent Agent turn cycle. Schema: `control_intent`, `reconcile_backoff_until`, `reconcile_attempts` columns on `tasks`, `workflow_runs`, and `persistent_agents`. See `docs/reconciliation.md`
- **Task dependencies**: `task_dependencies` table for multi-step pipelines
- **Cost tracking**: `GET /api/analytics/costs` with daily/repo/type breakdowns, UI at `/costs`
- **Error classification**: `packages/shared/src/error-classifier.ts` pattern-matches errors into categories with remedies

## Tech Stack

| Layer      | Technology                       | Notes                                                                          |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------ |
| Monorepo   | Turborepo + pnpm 10              | 6 packages, workspace protocol                                                 |
| API        | Fastify 5                        | Plugins, schema validation, WebSocket                                          |
| ORM        | Drizzle                          | PostgreSQL, migrations in `apps/api/src/db/migrations/`                        |
| Queue      | BullMQ + Redis                   | Also used for pub/sub (log streaming to WebSocket clients)                     |
| Web        | Next.js 15 App Router            | Tailwind CSS v4, Zustand, Lucide icons, sonner toasts, Recharts                |
| K8s client | @kubernetes/client-node          | Pod lifecycle, exec, log streaming, metrics                                    |
| Validation | Zod                              | API request schemas                                                            |
| Testing    | Vitest                           | Test files across shared + api                                                 |
| CI         | GitHub Actions                   | Format, typecheck, test, build-web, build-image                                |
| Deploy     | Helm                             | Chart at `helm/optio/`, local dev via `setup-local.sh`                         |
| Hooks      | Husky + lint-staged + commitlint | Pre-commit: lint-staged + format + typecheck. Commit-msg: conventional commits |

## Commands

```bash
# Setup (first time — builds everything, deploys to local k8s via Helm)
./scripts/setup-local.sh

# Update (pull + rebuild + redeploy)
./scripts/update-local.sh

# Manual rebuild + redeploy
docker build -t optio-api:latest -f Dockerfile.api .
docker build -t optio-web:latest -f Dockerfile.web .
kubectl rollout restart deployment/optio-api deployment/optio-web -n optio

# Quality (these are what CI runs, and pre-commit hooks mirror them)
pnpm format:check                     # Check formatting (Prettier)
pnpm turbo typecheck                  # Typecheck all 6 packages
pnpm turbo test                       # Run tests (Vitest)
cd apps/web && npx next build         # Verify production build

# Database
cd apps/api && npx drizzle-kit generate  # Generate migration after schema change
cd apps/api && npx tsx src/db/migrate.ts  # Apply migrations (standalone runner)
bash scripts/check-migration-prefixes.sh  # Check for duplicate prefixes

# Agent images
./images/build.sh                     # Build all presets (base, node, python, go, rust, full)

# Helm
helm lint helm/optio --set encryption.key=test
helm upgrade optio helm/optio -n optio --reuse-values

# Teardown
helm uninstall optio -n optio
```

## Conventions

- **ESM everywhere**: all packages use `"type": "module"` with `.js` extensions in imports (TypeScript resolves them to `.ts`)
- **Conventional commits**: enforced by commitlint (e.g., `feat:`, `fix:`, `refactor:`)
- **Pre-commit hooks**: lint-staged (eslint + prettier), then `pnpm format:check` and `pnpm turbo typecheck`
- **Tailwind CSS v4**: `@import "tailwindcss"` + `@theme` block in CSS, no `tailwind.config` file
- **Drizzle ORM**: schema in `apps/api/src/db/schema.ts`, run `drizzle-kit generate` after changes. **New migrations use unix-timestamp prefixes** (`migrations.prefix: "unix"` in `drizzle.config.ts`). Existing `00xx_*` files are frozen — never rename them
- **Zustand**: use `useStore.getState()` in callbacks/effects, not hook selectors (avoids infinite re-renders)
- **Next.js webpack**: `extensionAlias` in `next.config.ts` resolves `.js` → `.ts` for workspace packages
- **State transitions**: always go through `taskService.transitionTask()` — validates, updates DB, records event, publishes WebSocket
- **Secrets**: never log or return secret values. Encrypted at rest with AES-256-GCM
- **Cost tracking**: stored as string (`costUsd`) to avoid float precision issues
- **K8s RBAC**: namespace-scoped Role (pods, exec, secrets, PVCs) + ClusterRole (nodes, namespaces, metrics)

## Helm Chart

Key `values.yaml` settings:

- Image defaults point to GHCR (`ghcr.io/jtorelli-metalworks/optio-*`). Set `agent.image.prefix` to `optio-` for local dev
- `postgresql.enabled` / `redis.enabled` — set to `false` and use `externalDatabase.url` / `externalRedis.url` for managed services
- `encryption.key` — **required**, generate with `openssl rand -hex 32`
- `serviceAccount.name` / `serviceAccount.annotations` — used by API/web pods (K8s API access) and agent pods (workload identity). Example for GKE: `iam.gke.io/gcp-service-account: optio@PROJECT_ID.iam.gserviceaccount.com`
- Local dev overrides in `helm/optio/values.local.yaml` (`setup-local.sh` applies automatically)

## Troubleshooting

**Pod won't start**: check `kubectl get pods -n optio`, verify agent image exists (`docker images | grep optio-agent`), check `OPTIO_IMAGE_PULL_POLICY=Never` for local images.

**Auth errors**: verify `CLAUDE_AUTH_MODE` secret, check `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` exists, check `GET /api/auth/status`.

**Tasks stuck in `queued`**: check concurrency limits (`OPTIO_MAX_CONCURRENT`, per-repo `maxConcurrentTasks`), look for stuck provisioning/running tasks.

**WebSocket drops**: ensure Redis is running, check `REDIS_URL` and `INTERNAL_API_URL` config.

**Pod OOM/crash**: check `pod_health_events`, increase resource limits. Cleanup worker auto-detects and fails associated tasks.

**OAuth login fails**: verify `PUBLIC_URL` matches deployment URL, check provider callback URLs are registered.

**Migration errors**: migrations auto-run on startup. Historical duplicate prefixes (0016, 0018, 0019, 0026, 0039, 0042) are allowlisted. New migrations use unix-timestamp prefixes.

**Repo init timeout**: large repos may exceed 120s default. Increase `OPTIO_REPO_INIT_TIMEOUT_MS`.

## Production Deployment Checklist

1. Generate encryption key: `openssl rand -hex 32`
2. Configure at least one OAuth provider (`*_CLIENT_ID` + `*_CLIENT_SECRET`)
3. Ensure `OPTIO_AUTH_DISABLED` is NOT set
4. Use managed PostgreSQL/Redis (`externalDatabase.url`, `externalRedis.url`)
5. Set `PUBLIC_URL` to actual deployment URL
6. Enable ingress with TLS
7. Set `GITHUB_TOKEN` secret for PR watching, issue sync, repo detection
8. Install `metrics-server` in cluster

## Known Issues

- Workspace RBAC roles are in schema but not fully enforced in all routes
- API container runs via `tsx` rather than compiled JS (workspace packages export `./src/index.ts`)
- OAuth tokens from `claude setup-token` have limited scopes vs Keychain-extracted tokens
