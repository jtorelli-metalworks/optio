import { TASK_BRANCH_PREFIX, parseRepoUrl } from "@optio/shared";
import { getGitPlatformForRepo } from "./git-token-service.js";
import { logger } from "../logger.js";

export interface ExistingPr {
  url: string;
  number: number;
  state: string;
}

/**
 * Extract owner and repo from a normalized repo URL.
 * e.g. "https://github.com/owner/repo" → { owner: "owner", repo: "repo" }
 */
export function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  const ri = parseRepoUrl(repoUrl);
  if (!ri) return null;
  return { owner: ri.owner, repo: ri.repo };
}

/**
 * Check if an open PR already exists for a task's branch.
 *
 * Uses the GitPlatform abstraction to list open PRs filtered by branch.
 * Branch naming is deterministic: `optio/task-{taskId}`
 *
 * Returns the PR info if found, or null if no PR exists.
 */
export async function checkExistingPr(
  repoUrl: string,
  taskId: string,
  workspaceId: string | null,
): Promise<ExistingPr | null> {
  const ri = parseRepoUrl(repoUrl);
  if (!ri) {
    logger.debug({ repoUrl }, "Cannot parse repo URL — skipping PR check");
    return null;
  }

  let platform;
  try {
    const result = await getGitPlatformForRepo(repoUrl, { server: true, workspaceId });
    platform = result.platform;
  } catch {
    logger.debug("No git token available — skipping existing PR check");
    return null;
  }

  const branch = `${TASK_BRANCH_PREFIX}${taskId}`;

  try {
    const pulls = await platform.listOpenPullRequests(ri, { branch });

    if (pulls.length === 0) return null;

    const pr = pulls[0];
    return {
      url: pr.url,
      number: pr.number,
      state: pr.state,
    };
  } catch (err) {
    logger.debug({ err }, "Failed to check for existing PR");
    return null;
  }
}

export async function checkExistingPrWithRetry(
  repoUrl: string,
  taskId: string,
  workspaceId: string | null,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<ExistingPr | null> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delayMs = Math.max(0, opts.delayMs ?? 1_500);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const existingPr = await checkExistingPr(repoUrl, taskId, workspaceId);
    if (existingPr) return existingPr;

    if (attempt < attempts && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
