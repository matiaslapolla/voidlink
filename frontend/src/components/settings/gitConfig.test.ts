import { describe, expect, it } from "vitest";
import {
  CONFIG_FIELDS,
  CONFIG_GROUPS,
  displayValue,
  fieldsInGroup,
  parseGitBool,
  resolveProvenance,
} from "./gitConfig";
import type { ConfigEntry } from "@/types/git";

const at = (level: ConfigEntry["level"], key: string, value: string): ConfigEntry => ({
  key,
  value,
  level,
});

describe("resolveProvenance", () => {
  it("reports the git default when the key is set nowhere", () => {
    const p = resolveProvenance([], "pull.rebase", "local");
    expect(p.kind).toBe("unset");
    expect(p.value).toBeNull();
    expect(p.label).toBe("default");
    expect(p.atScope).toBeNull();
  });

  it("reports a value from another level as inherited, with no Clear target", () => {
    const p = resolveProvenance(
      [at("global", "user.email", "me@home.example")],
      "user.email",
      "local",
    );
    expect(p.kind).toBe("inherited");
    expect(p.label).toBe("from global");
    expect(p.value).toBe("me@home.example");
    // Nothing is set at the active scope, so there is nothing to clear.
    expect(p.atScope).toBeNull();
  });

  it("reports a value set only at the active scope as set", () => {
    const p = resolveProvenance([at("local", "user.email", "me@work.example")], "user.email", "local");
    expect(p.kind).toBe("set");
    expect(p.label).toBe("local");
    expect(p.atScope).toBe("me@work.example");
    expect(p.shadowed).toBeNull();
  });

  it("names the shadowed level when the active scope overrides a lower one", () => {
    // The case a naive implementation collapses into plain "set".
    const p = resolveProvenance(
      [at("global", "user.email", "me@home.example"), at("local", "user.email", "me@work.example")],
      "user.email",
      "local",
    );
    expect(p.kind).toBe("overriding");
    expect(p.label).toBe("local · overrides global");
    expect(p.value).toBe("me@work.example");
    expect(p.shadowed).toEqual({ level: "global", value: "me@home.example" });
  });

  it("system counts as a lower level to override", () => {
    const p = resolveProvenance(
      [at("system", "core.autocrlf", "input"), at("global", "core.autocrlf", "false")],
      "core.autocrlf",
      "global",
    );
    expect(p.kind).toBe("overriding");
    expect(p.label).toBe("global · overrides system");
  });

  it("does not claim a global edit is effective when local beats it", () => {
    const p = resolveProvenance(
      [at("global", "user.email", "me@home.example"), at("local", "user.email", "me@work.example")],
      "user.email",
      "global",
    );
    expect(p.kind).toBe("shadowed");
    expect(p.label).toBe("global · overridden by local");
    // The effective value is still local's — that is what git would use.
    expect(p.value).toBe("me@work.example");
    // But Clear here removes the global one.
    expect(p.atScope).toBe("me@home.example");
  });

  it("lets worktree scope win over local", () => {
    const p = resolveProvenance(
      [at("local", "user.name", "Local"), at("worktree", "user.name", "Worktree")],
      "user.name",
      "local",
    );
    expect(p.kind).toBe("shadowed");
    expect(p.value).toBe("Worktree");
  });

  it("matches keys case-insensitively, as git does", () => {
    const p = resolveProvenance(
      [at("global", "init.defaultbranch", "main")],
      "init.defaultBranch",
      "local",
    );
    expect(p.kind).toBe("inherited");
    expect(p.value).toBe("main");
  });

  it("ignores entries for other keys", () => {
    const p = resolveProvenance([at("local", "user.name", "Ada")], "user.email", "local");
    expect(p.kind).toBe("unset");
  });
});

describe("displayValue", () => {
  const field = CONFIG_FIELDS.find((f) => f.key === "pull.rebase")!;

  it("falls back to the git default when nothing is set", () => {
    expect(displayValue(resolveProvenance([], "pull.rebase", "local"), field)).toBe("false");
  });

  it("shows the effective value when there is one", () => {
    const p = resolveProvenance([at("global", "pull.rebase", "merges")], "pull.rebase", "local");
    expect(displayValue(p, field)).toBe("merges");
  });
});

describe("the field table", () => {
  it("assigns every field to a declared group", () => {
    for (const field of CONFIG_FIELDS) {
      expect(CONFIG_GROUPS).toContain(field.group);
    }
  });

  it("leaves no group empty, so the pane renders no headerless section", () => {
    for (const group of CONFIG_GROUPS) {
      expect(fieldsInGroup(group).length).toBeGreaterThan(0);
    }
  });

  it("partitions the fields — every field appears in exactly one group", () => {
    const grouped = CONFIG_GROUPS.flatMap(fieldsInGroup);
    expect(grouped.length).toBe(CONFIG_FIELDS.length);
    expect(new Set(grouped.map((f) => f.key)).size).toBe(CONFIG_FIELDS.length);
  });

  it("gives every enum field options that include its own fallback", () => {
    for (const field of CONFIG_FIELDS.filter((f) => f.kind === "enum")) {
      expect(field.options, field.key).toBeDefined();
      expect(field.options, field.key).toContain(field.fallback);
    }
  });

  it("never offers a free-text field for a key with a fixed option set", () => {
    const key = (k: string) => CONFIG_FIELDS.find((f) => f.key === k);
    expect(key("pull.rebase")?.kind).toBe("enum");
    expect(key("push.default")?.kind).toBe("enum");
    expect(key("commit.gpgsign")?.kind).toBe("boolean");
  });
});

describe("parseGitBool", () => {
  it("accepts every spelling git accepts", () => {
    for (const truthy of ["true", "yes", "on", "1", "TRUE", " On "]) {
      expect(parseGitBool(truthy), truthy).toBe(true);
    }
    for (const falsy of ["false", "no", "off", "0", "FALSE", ""]) {
      expect(parseGitBool(falsy), falsy).toBe(false);
    }
  });

  it("uses the field's own default when the key is unset", () => {
    expect(parseGitBool(null, true)).toBe(true);
    expect(parseGitBool(undefined, false)).toBe(false);
  });

  it("falls back rather than guessing on a value it cannot read", () => {
    expect(parseGitBool("maybe", true)).toBe(true);
  });
});
