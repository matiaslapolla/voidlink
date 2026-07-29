/// MASTER.md §2.4 and §11, enforced instead of remembered.
///
/// "Semantic tokens, never raw values" is the rule most likely to erode during
/// a wide restyling pass, and it erodes one plausible-looking literal at a
/// time. This is the grep the D1 acceptance criteria ask for, run as a test so
/// the eleventh literal fails a build rather than surviving a review.
///
/// Scope is `src/components/**` — the surfaces MASTER governs. `index.css` and
/// `themes.css` are where the literals are *supposed* to live, and the two
/// theme test files quote colours as fixtures on purpose.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS = join(__dirname, "components");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/// A line that is only a comment cannot ship a literal to the browser, and
/// MASTER's own prose quotes the values it is banning.
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/// The terminal's ANSI palette.
///
/// Deliberately literal and deliberately exempt: an xterm colour table is a
/// readability decision about *someone else's output*, not chrome, and routing
/// sixteen ANSI slots through VoidLink's six semantic colours would produce a
/// terminal that lies about what a program printed. The file's header states
/// the D1 contract it does have to keep — nothing in it may ever read
/// `--background` or `--canvas`.
const EXEMPT = new Set(["terminal/TerminalPane.tsx"]);

function scan(pattern: RegExp): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles(COMPONENTS)) {
    const rel = file.slice(COMPONENTS.length + 1);
    if (EXEMPT.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      if (isComment(line)) continue;
      if (pattern.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      pattern.lastIndex = 0;
    }
  }
  return offenders;
}

describe("token hygiene under src/components", () => {
  it("has no inline oklch() literal", () => {
    expect(scan(/oklch\(/)).toEqual([]);
  });

  it("has no inline hex colour", () => {
    // Quoted only: `#` also introduces a fragment in a URL and a private field
    // in TypeScript, and neither is a colour.
    expect(scan(/["'`]#[0-9a-fA-F]{3,8}["'`]/)).toEqual([]);
  });

  it("has no ad-hoc z-index — every one resolves to the named scale", () => {
    expect(scan(/z-\[[0-9]/)).toEqual([]);
  });

  it("has no raw millisecond duration", () => {
    // `--dur-*` in `index.css` are the five budgets; a number here means a
    // sixth one nobody agreed to (§7.2).
    expect(scan(/[^a-zA-Z-][0-9]+ms\b/)).toEqual([]);
  });

  it("has no raw px radius — the island radii are tokens", () => {
    expect(scan(/rounded-\[[0-9]/)).toEqual([]);
  });
});
