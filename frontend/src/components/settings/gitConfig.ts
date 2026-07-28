/// The pure half of the Settings → Git config pane: which keys voidlink
/// offers, how they render, and — the part that actually carries the risk —
/// what the cascade means for one key at one scope.
///
/// It lives outside the component because provenance is the thing a naive
/// implementation gets wrong (it drops the "set here *and* also set lower
/// down" case), and because a rule you can't test is a rule you don't have.
/// Nothing here touches Tauri, the DOM or Solid.
import type { ConfigEntry, ConfigLevel, ConfigScope } from "@/types/git";

// ─── The curated key set ─────────────────────────────────────────────────────

export type ConfigGroup =
  | "Identity"
  | "Commit"
  | "Branching & sync"
  | "Diff & merge"
  | "Core";

/// Group order in the pane. Identity first because it is what people come
/// here for; Core last because it is the one nobody should need to change.
export const CONFIG_GROUPS: ConfigGroup[] = [
  "Identity",
  "Commit",
  "Branching & sync",
  "Diff & merge",
  "Core",
];

export interface ConfigField {
  /// The git key, spelled exactly as git spells it.
  key: string;
  /// Row label. Short — the key itself is shown underneath in mono.
  label: string;
  group: ConfigGroup;
  /// `boolean` renders a pill toggle, `enum` a segmented control, `text` an
  /// input. A free-text field for `pull.rebase` is a bug, not a shortcut.
  kind: "text" | "boolean" | "enum";
  /// `enum` only. Rendered in this order.
  options?: string[];
  /// What git does when the key is set nowhere. Shown ghosted, labelled
  /// `default`, so an unset row still says something true.
  fallback: string;
  /// `text` only. Shows *format*, never instruction (MASTER §10.6).
  placeholder?: string;
  /// One line, only where the key's effect is genuinely non-obvious.
  hint?: string;
}

/// Must stay in sync with `WRITABLE_KEYS` in `src-tauri/src/git/config.rs`.
/// Rust is the enforcement point; this list is only what the UI offers.
export const CONFIG_FIELDS: ConfigField[] = [
  {
    key: "user.name",
    label: "Name",
    group: "Identity",
    kind: "text",
    fallback: "not set",
    placeholder: "Ada Lovelace",
  },
  {
    key: "user.email",
    label: "Email",
    group: "Identity",
    kind: "text",
    fallback: "not set",
    placeholder: "you@example.com",
  },
  {
    key: "user.signingkey",
    label: "Signing key",
    group: "Commit",
    kind: "text",
    fallback: "not set",
    placeholder: "0A46826A",
  },
  {
    key: "commit.gpgsign",
    label: "Sign commits",
    group: "Commit",
    kind: "boolean",
    fallback: "false",
    hint: "Every commit is signed with the key above.",
  },
  {
    key: "init.defaultBranch",
    label: "Default branch",
    group: "Branching & sync",
    kind: "text",
    fallback: "master",
    placeholder: "main",
    hint: "Used by new repositories only — existing ones are unaffected.",
  },
  {
    key: "pull.rebase",
    label: "Pull strategy",
    group: "Branching & sync",
    kind: "enum",
    options: ["false", "true", "merges"],
    fallback: "false",
    hint: "false merges, true rebases, merges rebases and keeps merge commits.",
  },
  {
    key: "push.default",
    label: "Push target",
    group: "Branching & sync",
    kind: "enum",
    options: ["simple", "current", "upstream", "matching", "nothing"],
    fallback: "simple",
  },
  {
    key: "push.autoSetupRemote",
    label: "Auto-set upstream",
    group: "Branching & sync",
    kind: "boolean",
    fallback: "false",
    hint: "Pushing a new branch sets its upstream instead of erroring.",
  },
  {
    key: "fetch.prune",
    label: "Prune on fetch",
    group: "Branching & sync",
    kind: "boolean",
    fallback: "false",
  },
  {
    key: "rebase.autoStash",
    label: "Autostash on rebase",
    group: "Branching & sync",
    kind: "boolean",
    fallback: "false",
  },
  {
    key: "merge.conflictstyle",
    label: "Conflict style",
    group: "Diff & merge",
    kind: "enum",
    options: ["merge", "diff3", "zdiff3"],
    fallback: "merge",
    hint: "diff3 and zdiff3 add the common ancestor to conflict markers.",
  },
  {
    key: "diff.algorithm",
    label: "Diff algorithm",
    group: "Diff & merge",
    kind: "enum",
    options: ["myers", "minimal", "patience", "histogram"],
    fallback: "myers",
  },
  {
    key: "core.editor",
    label: "Editor",
    group: "Core",
    kind: "text",
    fallback: "vi",
    placeholder: "vim",
  },
  {
    key: "core.autocrlf",
    label: "Line endings",
    group: "Core",
    kind: "enum",
    options: ["false", "input", "true"],
    fallback: "false",
  },
  {
    key: "core.filemode",
    label: "Track file mode",
    group: "Core",
    kind: "boolean",
    fallback: "true",
  },
  {
    key: "core.ignorecase",
    label: "Case-insensitive paths",
    group: "Core",
    kind: "boolean",
    fallback: "false",
  },
];

/// The fields of one group, in declaration order. Returns `[]` rather than
/// throwing for an unknown group so a rename can't blank the whole pane.
export function fieldsInGroup(group: ConfigGroup): ConfigField[] {
  return CONFIG_FIELDS.filter((f) => f.group === group);
}

// ─── Cascade resolution ──────────────────────────────────────────────────────

/// git's precedence, lowest to highest. `system` covers Windows' ProgramData
/// and `global` covers XDG — Rust already folded those in.
const PRECEDENCE: ConfigLevel[] = ["unknown", "system", "global", "local", "worktree", "app"];

function rank(level: ConfigLevel): number {
  const i = PRECEDENCE.indexOf(level);
  return i === -1 ? 0 : i;
}

/// git key names are case-insensitive in section and variable (the optional
/// middle subsection is not, but no allowlisted key has one).
function sameKey(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/// What the row says about where its value comes from.
///
/// - `unset`      — set nowhere; the git default is showing.
/// - `inherited`  — set at some level other than the one being edited.
/// - `set`        — set at the active scope and nowhere lower.
/// - `overriding` — set at the active scope *and* also lower down. The case
///                  worth building this type for.
/// - `shadowed`   — set at the active scope but beaten by a higher level, so
///                  editing here will not change what git actually does.
export type ProvenanceKind = "unset" | "inherited" | "set" | "overriding" | "shadowed";

export interface Provenance {
  kind: ProvenanceKind;
  /// The value git would actually use, or `null` when set nowhere.
  value: string | null;
  /// Where that value comes from, or `null` when set nowhere.
  level: ConfigLevel | null;
  /// The provenance in words. Never colour alone (MASTER §10.12).
  label: string;
  /// The value hidden underneath the effective one, when there is one.
  shadowed: { level: ConfigLevel; value: string } | null;
  /// The value written at the active scope, when there is one. This is what a
  /// Clear action removes — and its presence is what makes Clear meaningful.
  atScope: string | null;
}

/// Resolve one key against the whole cascade, from the point of view of the
/// scope currently being edited.
///
/// `entries` is the full listing including shadowed duplicates — passing only
/// the effective entries silently collapses `overriding` into `set`.
export function resolveProvenance(
  entries: ConfigEntry[],
  key: string,
  scope: ConfigScope,
): Provenance {
  const matches = entries
    .filter((e) => sameKey(e.key, key))
    .slice()
    .sort((a, b) => rank(b.level) - rank(a.level));

  const effective = matches[0];
  if (!effective) {
    return { kind: "unset", value: null, level: null, label: "default", shadowed: null, atScope: null };
  }

  const own = matches.find((e) => e.level === scope) ?? null;

  if (!own) {
    return {
      kind: "inherited",
      value: effective.value,
      level: effective.level,
      label: `from ${effective.level}`,
      shadowed: null,
      atScope: null,
    };
  }

  if (effective.level !== scope) {
    // Set here, but something higher wins. Saying "local" would be a lie
    // about what git does.
    return {
      kind: "shadowed",
      value: effective.value,
      level: effective.level,
      label: `${scope} · overridden by ${effective.level}`,
      shadowed: { level: scope, value: own.value },
      atScope: own.value,
    };
  }

  const beneath = matches.find((e) => rank(e.level) < rank(scope));
  if (beneath) {
    return {
      kind: "overriding",
      value: own.value,
      level: scope,
      label: `${scope} · overrides ${beneath.level}`,
      shadowed: { level: beneath.level, value: beneath.value },
      atScope: own.value,
    };
  }

  return {
    kind: "set",
    value: own.value,
    level: scope,
    label: scope,
    shadowed: null,
    atScope: own.value,
  };
}

/// The value a row displays: the effective one, or the git default when the
/// key is set nowhere. Never the value the user just typed — a config write is
/// a filesystem write outside our control, so the read-back is the truth
/// (MASTER §7.5.6).
export function displayValue(prov: Provenance, field: ConfigField): string {
  return prov.value ?? field.fallback;
}

/// git's boolean spelling is wider than `true`/`false`, and a valueless entry
/// (`[core]\n\tfilemode`) means true. Rust normalises the valueless case to
/// `"true"`; the rest is here.
export function parseGitBool(value: string | null | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  const v = value.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(v)) return true;
  if (["false", "no", "off", "0", ""].includes(v)) return false;
  return fallback;
}
