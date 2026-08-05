/**
 * Minimal hand-rolled arg parser for `brain add` / `search` / `index` / `review`.
 *
 * Supports:
 *   --type <value>
 *   --title <value>
 *   --body <value>
 *   --label <value>   (repeatable, accumulates into string[])
 *   --project <value>
 *   --ticket <value>
 *   --json <value>
 *   --vault-path <value>
 *   --stale-days <n>  (review threshold)
 *   --ticket-days <n> (review threshold)
 *   --dry-run         (boolean flag)
 *   --yes / -y        (boolean flag)
 *   --help / -h       (boolean flag)
 *
 * Non-flag args after the command (e.g. `brain search foo bar`) accumulate
 * into `positionals`.
 */

export interface ParsedArgs {
  command: string | undefined; // e.g. "add", "search", "index", "review"
  positionals: string[];
  type?: string;
  title?: string;
  body?: string;
  labels: string[];
  project?: string;
  ticket?: string;
  json?: string;
  vaultPath?: string;
  staleDays?: number;
  ticketDays?: number;
  dryRun: boolean;
  yes: boolean;
  help: boolean;
}

/** Parse a non-negative integer flag, ignoring anything that isn't one. */
function intFlag(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  return Number.parseInt(raw, 10);
}

export function parseArgs(argv: string[]): ParsedArgs {
  // argv starts after "node cli.js"
  const args = argv.slice(2);
  const result: ParsedArgs = {
    command: undefined,
    positionals: [],
    labels: [],
    dryRun: false,
    yes: false,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;

    if (arg === "--yes" || arg === "-y") {
      result.yes = true;
      i++;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      i++;
      continue;
    }

    if (arg === "--dry-run") {
      result.dryRun = true;
      i++;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        // boolean flag with no value — ignore unknown
        i++;
        continue;
      }
      switch (key) {
        case "type":
          result.type = next;
          break;
        case "title":
          result.title = next;
          break;
        case "body":
          result.body = next;
          break;
        case "label":
          result.labels.push(next);
          break;
        case "project":
          result.project = next;
          break;
        case "ticket":
          result.ticket = next;
          break;
        case "json":
          result.json = next;
          break;
        case "vault-path":
          result.vaultPath = next;
          break;
        case "stale-days":
          result.staleDays = intFlag(next);
          break;
        case "ticket-days":
          result.ticketDays = intFlag(next);
          break;
        // unknown flags: silently skip both key and value
      }
      i += 2;
      continue;
    }

    // first positional → sub-command ("add", "search", "index", "review").
    if (result.command === undefined) {
      result.command = arg;
    } else {
      result.positionals.push(arg);
    }
    i++;
  }

  return result;
}

export function printHelp(): void {
  console.log(`
brain — Second Brain CLI

Usage:
  brain add --type <type> --title "..." [flags]      Non-interactive
  brain add --json '<RegisterInput JSON>'            Raw passthrough
  brain search <query>                               Search the local vault
  brain index                                        Regenerate projects/ labels/ tickets/
  brain review                                       Report stale entries and dropped threads

Types: decision, shipped, note, discovery, content, training

Flags:
  --type <type>        Entry type
  --title <text>       Entry title
  --body <text>        Markdown body (optional)
  --label <label>      Label (repeatable: --label foo --label bar)
  --project <name>     Project name (required for decision/shipped)
  --ticket <PROJ-123>  Brain board card id (required for shipped)
  --json <json>        Raw RegisterInput JSON (skips flag parsing)
  --vault-path <path>  Override the local vault path
  --dry-run            index: report what would change, write nothing
  --stale-days <n>     review: days before an entry is stale (default 90)
  --ticket-days <n>    review: days before an open ticket is overdue (default 30)
  --yes / -y           Skip confirmation prompt (add), skip commit prompt (index)
  --help / -h          Show this help

Config (priority: flag > env > ~/.config/brain/config.json > no default):
  BRAIN_VAULT_PATH     Local path to the brain-kb clone (required)
`);
}
