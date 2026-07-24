/**
 * Local register pipeline — writes markdown directly into a local git-cloned
 * vault and commits it there. This process is the single writer now; there is
 * no server, no Neon index, no GitHub API round-trip.
 *
 * Ported from apps/web/lib/register-core.ts, with the Neon-backed idempotency
 * check replaced by a filesystem existence check and the GitHub Git Data API
 * commit replaced by a local git commit. Commit-only — no push. Pushing to the
 * vault's remote stays a manual/periodic step so a bad local write can't
 * silently diverge from what's on GitHub.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildMarkdown, makeId, TYPE_FOLDER } from "./core/index.js";
import type { RegisterInput } from "./core/index.js";

export interface RegisterResult {
  id: string;
  path: string;
  commitSha: string;
  url: string;
}

/** Stamp the current moment as an ISO-8601 string in the -03:00 offset. */
function stampCreatedISO(): string {
  const OFFSET_MS = -3 * 60 * 60 * 1000;
  const shifted = new Date(Date.now() + OFFSET_MS);
  return shifted.toISOString().replace(/Z$/, "-03:00");
}

/**
 * Idempotency suffix: find the first id not already present on disk,
 * ANYWHERE in the vault (not just the current type's folder). ids are a
 * global key the old Neon-backed system enforced uniqueness on — reindexing
 * relies on that, so a same-id file in two type folders would silently
 * collapse into one entry.
 */
function resolveId(baseId: string, vaultPath: string): string {
  const folders = Object.values(TYPE_FOLDER);
  const exists = (id: string) => folders.some((f) => existsSync(join(vaultPath, f, `${id}.md`)));
  if (!exists(baseId)) return baseId;

  let n = 2;
  while (true) {
    const candidate = `${baseId}-${n}`;
    if (!exists(candidate)) return candidate;
    n++;
  }
}

/** Run a git subcommand against the vault. Array args — no shell involved. */
function git(vaultPath: string, args: string[]): string {
  return execFileSync("git", ["-C", vaultPath, ...args], { encoding: "utf8" }).trim();
}

/**
 * Execute the full local register pipeline for a pre-validated RegisterInput.
 * Writes the markdown file into `vaultPath` and creates a commit scoped to
 * just that file. If the git steps fail after the file is written, the file
 * is removed so a retry doesn't see a phantom "already exists" and skip an
 * id — the write is all-or-nothing from the caller's perspective.
 */
export function runLocalRegister(input: RegisterInput, vaultPath: string): RegisterResult {
  const createdISO = stampCreatedISO();
  const baseId = makeId({ type: input.type, title: input.title, createdISO });
  const finalId = resolveId(baseId, vaultPath);

  const { path: typePath, contents } = buildMarkdown(input, { id: finalId, createdISO });
  const fullPath = join(vaultPath, typePath);

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents, "utf8");

  try {
    git(vaultPath, ["add", typePath]);
    // Pathspec-scoped: commit exactly this file, not whatever else happens
    // to be staged in the vault (e.g. a manual Obsidian edit in progress).
    git(vaultPath, ["commit", "-m", `register: ${input.type} ${finalId}`, "--", typePath]);
  } catch (err) {
    rmSync(fullPath, { force: true });
    throw err;
  }

  const commitSha = git(vaultPath, ["rev-parse", "HEAD"]);

  return { id: finalId, path: typePath, commitSha, url: fullPath };
}
