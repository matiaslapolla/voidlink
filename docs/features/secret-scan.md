# Secret scan

## What it does

Before every commit, VoidLink scans the **added lines of the staged diff** for
things that look like credentials. If it finds any, the commit is deferred and a
dialog lists them with the values partially masked.

It is entirely frontend TypeScript — there is no Rust side, no setting, and no
way to turn it off.

## When you'd use it

It uses itself. You don't invoke it; it runs on the commit path.

## How to use it

1. Stage and commit as usual — the button, or `Mod+Enter` in the commit box.
   Amends are covered too.
2. If nothing matches, the commit proceeds.
3. If something matches, a dialog appears:

   > **Possible secrets in staged changes**
   > Review before committing. Once pushed, treat any exposed value as
   > compromised — rotate it immediately.

   Each row shows the rule name, `file:line`, and the masked preview.
4. Two buttons: `Cancel`, which abandons the commit, and `Commit anyway`, which
   proceeds unconditionally.

So it **defers, it does not block**. There is no override password, no
allowlist file, and no `--no-verify` equivalent.

## Detection rules

| Rule name | What it matches |
|---|---|
| `AWS access key id` | `AKIA`/`ASIA` followed by 16 uppercase alphanumerics |
| `AWS secret access key` | `aws_secret_access_key = "<40 base64-ish chars>"` |
| `GitHub token (PAT / fine-grained / OAuth)` | `ghp_` `gho_` `ghu_` `ghs_` `ghr_` `github_pat_` + 20 or more |
| `Anthropic API key` | `sk-ant-` + 20 or more |
| `OpenAI API key` | `sk-` (not `sk-ant-`) + 20 or more |
| `Google API key` | `AIza` + 35 |
| `Slack token` | `xox[abposr]-` + 10 or more |
| `Private key block` | `-----BEGIN [RSA/EC/DSA/OPENSSH/PGP ]PRIVATE KEY-----` |
| `Generic secret-shaped assignment` | `password`/`passwd`/`secret`/`api_key`/`access_token`/`auth_token` assigned a quoted 8+ character literal |

Rule order matters: Anthropic is tested before OpenAI, because the loose `sk-`
shape also matches `sk-ant-` and the loop breaks on the first hit.

Only the generic rule filters false positives — it drops the line if it contains
`example`, `placeholder`, `your-`, or `xxx` (case-insensitive).

Masking keeps the first and last four characters:
`AKIA…********…WXYZ`. Values of 8 characters or fewer are fully starred.

## Keyboard shortcuts

None.

## Gotchas and limits

- **It fails open.** If fetching the staged diff throws, the failure is logged
  to the console and **the commit proceeds unscanned**.
- **Only added lines of staged files are scanned.** Context lines, removed
  lines, unstaged changes, and anything already in history are invisible to it.
  A secret committed before this feature existed will never be flagged.
- **Binary files are skipped entirely.**
- **First matching rule wins per line.** A line with two different secret types
  reports one.
- **Only the first occurrence on a line is masked.** The mask is a plain string
  replace.
- **`Commit anyway` re-reads the textarea**, not the message that was validated.
  Editing the box while the dialog is open commits the edited text.
- **A missing line number renders as `file:0`.**
- **It cannot be disabled or configured.** No settings key, no rule overrides,
  no per-repo allowlist.
- **It is not a git hook.** It only guards commits made through VoidLink's
  commit button; committing from a terminal bypasses it completely.
