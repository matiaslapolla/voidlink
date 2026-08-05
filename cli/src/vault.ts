/**
 * Vault IO — the only module that touches the filesystem for reads.
 *
 * `core/` stays pure; everything that needs a disk or a git process lives here,
 * so the interesting logic (parsing, indexing, staleness) can be tested without
 * a fixture tree.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEntry, TYPE_FOLDER } from "./core/index.js";
import type { ParsedEntry } from "./core/index.js";

const INDEX_FOLDERS = ["projects", "labels", "tickets"] as const;

/** Every typed entry in the vault. Files that don't parse are skipped, not fatal. */
export function readEntries(vaultPath: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];

  for (const folder of Object.values(TYPE_FOLDER)) {
    const dir = join(vaultPath, folder);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue; // type folder doesn't exist yet (e.g. content/, training/)
    }
    for (const file of files) {
      const parsed = parseEntry(readFileSync(join(dir, file), "utf8"));
      if (parsed) entries.push(parsed);
    }
  }

  return entries;
}

/** Vault-relative paths of every existing index note. */
export function readIndexNotePaths(vaultPath: string): string[] {
  const paths: string[] = [];
  for (const folder of INDEX_FOLDERS) {
    let files: string[];
    try {
      files = readdirSync(join(vaultPath, folder)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) paths.push(`${folder}/${file}`);
  }
  return paths;
}

/**
 * `created` stamps of the index notes already on disk, so regeneration keeps
 * them instead of resetting every note's birth date on each run.
 */
export function readExistingCreated(vaultPath: string, paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of paths) {
    const full = join(vaultPath, path);
    if (!existsSync(full)) continue;
    const match = readFileSync(full, "utf8").match(/^created:\s*"?([^"\n]+)"?\s*$/m);
    const stamp = match?.[1];
    if (stamp) out.set(path, stamp.trim());
  }
  return out;
}

/**
 * Entry id -> ISO date of the commit that last touched its file. Without this,
 * staleness is measured from `created`, which calls a revised entry stale on
 * its original date.
 *
 * One `git log` over the whole vault rather than one per file: 146 entries
 * would otherwise be 146 process spawns. Returns an empty map if git fails —
 * the review still runs, just with `created` as the fallback.
 */
export function readLastTouched(vaultPath: string): Map<string, string> {
  const out = new Map<string, string>();
  let log: string;
  try {
    log = execFileSync(
      "git",
      ["-C", vaultPath, "log", "--name-only", "--format=%x00%aI", "--diff-filter=AMR"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return out;
  }

  // Records are NUL-delimited: "<iso>\n<path>\n<path>\n". git log is
  // newest-first, so the first sighting of a path is its latest change.
  for (const record of log.split("\0")) {
    const lines = record.split("\n").filter((l) => l.trim() !== "");
    const date = lines.shift();
    if (!date) continue;
    for (const path of lines) {
      const file = path.split("/").pop();
      if (!file?.endsWith(".md")) continue;
      const id = file.slice(0, -3);
      if (!out.has(id)) out.set(id, date.trim());
    }
  }

  return out;
}

/**
 * Append one line to `vault/log/YYYY-MM-DD.md`, creating the file with a
 * heading on the day's first write. Returns the vault-relative path.
 *
 * Deliberately append-only and commit-free: the SessionEnd hook fires as the
 * process is going away, and a git commit there would race every other session
 * ending at the same time. A scheduled task commits the day's log once.
 */
export function appendSessionLog(vaultPath: string, dateKey: string, line: string): string {
  const relative = `vault/log/${dateKey}.md`;
  const full = join(vaultPath, relative);
  mkdirSync(dirname(full), { recursive: true });
  if (!existsSync(full)) {
    writeFileSync(full, `# ${dateKey}\n\nRaw session log. Append-only, written by the SessionEnd hook.\n\n`, "utf8");
  }
  appendFileSync(full, `${line.replace(/\n/g, " ")}\n`, "utf8");
  return relative;
}

/**
 * Ticket id -> status, read from each ticket note's frontmatter. The board's
 * status lived in Postgres; once it's migrated into these files this is where
 * `brain review` picks it up. A ticket with no `status:` reports as unknown,
 * which `review` deliberately treats as open.
 */
export function readTicketStatus(vaultPath: string): Map<string, string> {
  const out = new Map<string, string>();
  let files: string[];
  try {
    files = readdirSync(join(vaultPath, "tickets")).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  for (const file of files) {
    const match = readFileSync(join(vaultPath, "tickets", file), "utf8").match(
      /^status:\s*"?([^"\n]+)"?\s*$/m,
    );
    const status = match?.[1];
    if (status) out.set(file.slice(0, -3), status.trim());
  }
  return out;
}
