#!/usr/bin/env node
/**
 * brain CLI — entry point
 *
 * Commands:
 *   brain add --type <t> --title "..." [flags]   non-interactive flags
 *   brain add --json '<json>'                     raw JSON passthrough
 *   brain search <query>                          search the local vault
 *   brain index                                   regenerate the index notes
 *   brain review                                  report staleness
 *
 * Interactivity (rich prompts) and digest live in the Claude skills that call
 * this CLI — the binary itself stays a thin, scriptable client. Use --yes to
 * skip the confirmation prompt in automated contexts.
 *
 * Local-first: this process writes markdown directly into the vault and
 * commits it there. No server, no token, no network call.
 *
 * Config resolution: --vault-path flag > BRAIN_VAULT_PATH env
 * > ~/.config/brain/config.json > fail loud if unset.
 */

import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs, printHelp } from "./args.js";
import { requireVaultPath, resolveConfig } from "./config.js";
import { renderPreview } from "./preview.js";
import { validateInput } from "./validate.js";
import { runLocalRegister } from "./local-register.js";
import { buildIndexNotes, orphanedIndexNotes, review, TYPE_FOLDER } from "./core/index.js";
import type { Finding, ReviewThresholds } from "./core/index.js";
import {
  readEntries,
  readExistingCreated,
  readIndexNotePaths,
  readLastTouched,
  readTicketStatus,
} from "./vault.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help || args.command === undefined) {
    printHelp();
    process.exit(0);
  }

  const config = resolveConfig({ vaultPath: args.vaultPath });

  if (args.command === "add") {
    await runAdd(args, config);
    return;
  }

  if (args.command === "search") {
    runSearch(args, config);
    return;
  }

  if (args.command === "index") {
    runIndex(args, config);
    return;
  }

  if (args.command === "review") {
    runReview(args, config);
    return;
  }

  console.error(`Unknown command: ${args.command}`);
  console.error('Run "brain --help" for usage.');
  process.exit(1);
}

/** Prompt for a yes/no confirmation on stdin. Defaults to yes on empty input. */
async function confirmWrite(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Register this entry? [Y/n] ")).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function runAdd(
  args: ReturnType<typeof parseArgs>,
  config: ReturnType<typeof resolveConfig>,
): Promise<void> {
  let rawInput: unknown;

  // ── Path A: --json passthrough ───────────────────────────────────────────
  if (args.json !== undefined) {
    try {
      rawInput = JSON.parse(args.json);
    } catch {
      console.error("Error: --json value is not valid JSON.");
      process.exit(1);
    }
  } else if (args.type !== undefined) {
    // ── Path B: non-interactive flags ──────────────────────────────────────
    const obj: Record<string, unknown> = {
      type: args.type,
      title: args.title ?? "",
      body: args.body ?? "",
    };
    if (args.project !== undefined) obj["project"] = args.project;
    if (args.ticket !== undefined) obj["ticket"] = args.ticket;
    if (args.labels.length > 0) obj["labels"] = args.labels;
    rawInput = obj;
  } else {
    console.error(
      "Error: provide --type <type> (with --title …) or --json '<RegisterInput>'.",
    );
    console.error('Run "brain --help" for usage.');
    process.exit(1);
  }

  const validated = validateInput(rawInput);
  if (!validated.ok) {
    process.exit(1);
  }

  if (!args.yes) {
    console.log(renderPreview(validated.data));
    const ok = await confirmWrite();
    if (!ok) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  doLocalWrite(config, validated.data);
}

function doLocalWrite(
  config: ReturnType<typeof resolveConfig>,
  input: import("./core/index.js").RegisterInput,
): void {
  const vaultPath = requireVaultPath(config);

  try {
    const result = runLocalRegister(input, vaultPath);
    console.log(`\n  id:   ${result.id}`);
    console.log(`  path: ${result.path}`);
    console.log(`  url:  ${result.url}`);
    console.log("");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nWrite failed: ${msg}`);
    process.exit(1);
  }
}

/**
 * `brain search <query>` — case-insensitive substring match over each
 * entry's whole raw markdown file (frontmatter included: id, type, created,
 * labels, links — not just title/body), since there's no parsed index to
 * search against locally. Prints matching type/id. This is a local
 * replacement for the MCP brain_search tool, which required a cloud-hosted
 * index this local-first setup no longer has.
 */
function runSearch(
  args: ReturnType<typeof parseArgs>,
  config: ReturnType<typeof resolveConfig>,
): void {
  const query = args.positionals.join(" ").trim().toLowerCase();
  if (!query) {
    console.error("Error: provide a search query, e.g. `brain search idempotency`.");
    process.exit(1);
  }

  const vaultPath = requireVaultPath(config);
  const folders = new Set(Object.values(TYPE_FOLDER));
  let matches = 0;

  for (const folder of folders) {
    const dir = join(vaultPath, folder);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue; // folder doesn't exist yet (e.g. content/, training/)
    }
    for (const file of files) {
      const path = join(dir, file);
      const contents = readFileSync(path, "utf8");
      if (contents.toLowerCase().includes(query)) {
        const id = file.replace(/\.md$/, "");
        console.log(`${folder}/${id}`);
        matches++;
      }
    }
  }

  if (matches === 0) {
    console.log("No matches.");
  }
}

/**
 * `brain index` — regenerate `projects/`, `labels/` and `tickets/` from entry
 * frontmatter.
 *
 * These index notes used to be stubs backed by Postgres. Now the backlinks are
 * written into the markdown, so the same file is readable from GitHub,
 * Obsidian, the terminal, and by an agent with only a checkout.
 *
 * Writes only the notes whose contents actually changed, so a no-op reindex
 * produces an empty diff rather than touching every file. Commits unless
 * `--dry-run`.
 */
function runIndex(
  args: ReturnType<typeof parseArgs>,
  config: ReturnType<typeof resolveConfig>,
): void {
  const vaultPath = requireVaultPath(config);

  const entries = readEntries(vaultPath);
  if (entries.length === 0) {
    console.error("No entries found — is the vault path correct?");
    process.exit(1);
  }

  const existingPaths = readIndexNotePaths(vaultPath);
  const notes = buildIndexNotes(entries, readExistingCreated(vaultPath, existingPaths));
  const orphans = orphanedIndexNotes(existingPaths, notes);

  const changed: string[] = [];
  const created: string[] = [];
  for (const note of notes) {
    const full = join(vaultPath, note.path);
    let before: string | undefined;
    try {
      before = readFileSync(full, "utf8");
    } catch {
      before = undefined;
    }
    if (before === note.contents) continue;
    (before === undefined ? created : changed).push(note.path);
    if (!args.dryRun) {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, note.contents, "utf8");
    }
  }

  console.log(
    `\n  ${entries.length} entries → ${notes.length} index notes ` +
      `(${created.length} new, ${changed.length} updated, ${orphans.length} orphaned)`,
  );
  for (const p of created) console.log(`    + ${p}`);
  for (const p of changed) console.log(`    ~ ${p}`);
  for (const p of orphans) console.log(`    ? ${p}  (no entry references it)`);

  // Orphans are reported, never deleted. A ref can vanish because an entry was
  // legitimately retyped, or because a file is mid-edit — and an index note
  // silently deleted by a routine run is exactly the kind of surprise that
  // makes a tool untrustworthy. Delete them by hand.
  if (orphans.length > 0) {
    console.log("\n  Orphans are left in place. Remove them yourself if they're really dead.");
  }

  if (args.dryRun) {
    console.log("\n  --dry-run: nothing written.\n");
    return;
  }

  const touched = [...created, ...changed];
  if (touched.length === 0) {
    console.log("\n  Already up to date.\n");
    return;
  }

  try {
    execFileSync("git", ["-C", vaultPath, "add", ...touched], { encoding: "utf8" });
    execFileSync(
      "git",
      ["-C", vaultPath, "commit", "-m", `index: regenerate ${touched.length} index notes`, "--", ...touched],
      { encoding: "utf8" },
    );
    console.log(`\n  committed ${touched.length} index notes\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nIndex written but commit failed: ${msg}`);
    process.exit(1);
  }
}

const SEVERITY_MARK: Record<Finding["severity"], string> = {
  high: "!!",
  medium: " !",
  low: "  ",
};

/**
 * `brain review` — what did I start and not finish?
 *
 * Read-only. Exits 0 whether or not it finds anything: staleness is a report,
 * not a failure, and a non-zero exit would make this useless in a routine that
 * treats a bad exit code as a broken run.
 */
function runReview(
  args: ReturnType<typeof parseArgs>,
  config: ReturnType<typeof resolveConfig>,
): void {
  const vaultPath = requireVaultPath(config);

  const entries = readEntries(vaultPath);
  if (entries.length === 0) {
    console.error("No entries found — is the vault path correct?");
    process.exit(1);
  }

  const thresholds: Partial<ReviewThresholds> = {};
  if (args.staleDays !== undefined) thresholds.staleEntryDays = args.staleDays;
  if (args.ticketDays !== undefined) thresholds.openTicketDays = args.ticketDays;

  const findings = review({
    entries,
    now: new Date(),
    lastTouched: readLastTouched(vaultPath),
    ticketStatus: readTicketStatus(vaultPath),
    thresholds,
  });

  if (findings.length === 0) {
    console.log(`\n  ${entries.length} entries, nothing stale.\n`);
    return;
  }

  const groups: Finding["kind"][] = ["unfinished-decision", "open-ticket", "stale-entry"];
  const heading: Record<Finding["kind"], string> = {
    "unfinished-decision": "Decisions with nothing shipped after them",
    "open-ticket": "Tickets open with no shipped entry",
    "stale-entry": "Entries nobody has touched",
  };

  console.log(`\n  ${entries.length} entries · ${findings.length} findings\n`);
  for (const kind of groups) {
    const group = findings.filter((f) => f.kind === kind);
    if (group.length === 0) continue;
    console.log(`  ${heading[kind]} (${group.length})`);
    for (const f of group) {
      console.log(`   ${SEVERITY_MARK[f.severity]} ${f.ref}`);
      console.log(`        ${f.title}`);
      console.log(`        ${f.detail}`);
    }
    console.log("");
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Unexpected error: ${msg}`);
  process.exit(1);
});
