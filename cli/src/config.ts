/**
 * Config resolution for the brain CLI.
 *
 * Priority order (highest to lowest):
 *   1. CLI flags (--vault-path)
 *   2. Env vars (BRAIN_VAULT_PATH)
 *   3. ~/.config/brain/config.json
 *   4. No default — fail loud if unset.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".config", "brain", "config.json");

interface FileConfig {
  vaultPath?: string;
}

function readFileConfig(): FileConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const cfg = parsed as Record<string, unknown>;
    return {
      vaultPath: typeof cfg["vaultPath"] === "string" ? cfg["vaultPath"] : undefined,
    };
  } catch {
    return {};
  }
}

export interface ResolvedConfig {
  vaultPath: string | undefined;
}

/**
 * Resolve config from all sources. `overrides` come from CLI flags.
 * vaultPath may be undefined here — callers that need it must call
 * `requireVaultPath()` to get a clear error message.
 */
export function resolveConfig(overrides: { vaultPath?: string }): ResolvedConfig {
  const file = readFileConfig();

  const vaultPath =
    overrides.vaultPath ?? process.env["BRAIN_VAULT_PATH"] ?? file.vaultPath ?? undefined;

  return { vaultPath };
}

/**
 * Assert a vault path is present AND real, printing a helpful message and
 * exiting if not. Without the existence check, a typo'd path fails silently
 * downstream instead: `brain add` would happily `mkdir -p` a new folder tree
 * at the wrong location, and `brain search` would just print "No matches."
 */
export function requireVaultPath(config: ResolvedConfig): string {
  if (!config.vaultPath) {
    console.error(
      "Error: a vault path is required.\n" +
        "  Set it via:\n" +
        "    • flag: --vault-path <path>\n" +
        "    • env var: BRAIN_VAULT_PATH=<path>\n" +
        `    • config file: ${CONFIG_PATH}  { "vaultPath": "<path>" }`,
    );
    process.exit(1);
  }
  if (!existsSync(join(config.vaultPath, ".git"))) {
    console.error(
      `Error: ${config.vaultPath} doesn't look like a git repository (no .git found).\n` +
        "  Check the vault path is correct and cloned.",
    );
    process.exit(1);
  }
  return config.vaultPath;
}
