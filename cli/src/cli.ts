#!/usr/bin/env node
/**
 * brain CLI — entry point
 *
 * Commands:
 *   brain add --type <t> --title "..." [flags]   non-interactive flags
 *   brain add --json '<json>'                     raw JSON passthrough
 *   brain search <query>                          search the local vault
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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, printHelp } from "./args.js";
import { requireVaultPath, resolveConfig } from "./config.js";
import { renderPreview } from "./preview.js";
import { validateInput } from "./validate.js";
import { runLocalRegister } from "./local-register.js";
import { TYPE_FOLDER } from "./core/index.js";

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

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Unexpected error: ${msg}`);
  process.exit(1);
});
