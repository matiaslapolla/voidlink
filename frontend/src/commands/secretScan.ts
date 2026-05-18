import type { DiffResult } from "@/types/git";

/// A single suspicious match flagged in a staged diff.
export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
  /// The line content with the secret obscured for display.
  preview: string;
}

interface Rule {
  name: string;
  /// Tested per added line. If matched, the *match group 1* (when present) is
  /// the portion to redact in the preview; falls back to the whole match.
  pattern: RegExp;
  /// Optional secondary filter to reduce noise (e.g. ignore obvious `<...>`
  /// placeholders). Return true to keep the finding.
  keep?: (line: string) => boolean;
}

const RULES: Rule[] = [
  {
    name: "AWS access key id",
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    name: "AWS secret access key",
    pattern: /\baws_secret_access_key\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/i,
  },
  {
    name: "GitHub token (PAT / fine-grained / OAuth)",
    pattern: /\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,})\b/,
  },
  // Anthropic before OpenAI: the OpenAI pattern's loose `sk-…` shape also
  // matches `sk-ant-…`, and the loop breaks on first hit. Anthropic first
  // means Anthropic keys get the right label.
  {
    name: "Anthropic API key",
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/,
  },
  {
    name: "OpenAI API key",
    pattern: /\b(sk-(?!ant-)[A-Za-z0-9_-]{20,})\b/,
  },
  {
    name: "Google API key",
    pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/,
  },
  {
    name: "Slack token",
    pattern: /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/,
  },
  {
    name: "Private key block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    name: "Generic secret-shaped assignment",
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"]([^'"$<>{}\s]{8,})['"]/i,
    keep: (line) => {
      const lower = line.toLowerCase();
      if (lower.includes("example") || lower.includes("placeholder")) return false;
      if (lower.includes("your-") || lower.includes("xxx")) return false;
      return true;
    },
  },
];

function obscure(value: string, fullLine: string): string {
  if (!value) return fullLine;
  if (value.length <= 8) return fullLine.replace(value, "*".repeat(value.length));
  const visible = 4;
  const masked =
    value.slice(0, visible) + "…" + "*".repeat(8) + "…" + value.slice(-visible);
  return fullLine.replace(value, masked);
}

export function scanStagedDiff(diff: DiffResult): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of diff.files) {
    if (file.isBinary) continue;
    const path = file.newPath ?? file.oldPath ?? "(unknown)";
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.origin !== "+") continue;
        const content = line.content;
        for (const rule of RULES) {
          const m = content.match(rule.pattern);
          if (!m) continue;
          if (rule.keep && !rule.keep(content)) continue;
          findings.push({
            file: path,
            line: line.newLineno ?? 0,
            rule: rule.name,
            preview: obscure(m[1] ?? m[0], content.trim()),
          });
          break;
        }
      }
    }
  }
  return findings;
}
