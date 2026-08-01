# Audits

Read-only reviews of one surface at a time. An audit reports findings; it does
not decide what gets fixed. What came out of each is recorded in the audit
itself, and whatever is still live is in [`../TODO.md`](../TODO.md).

Every finding carries a **severity** and a **confidence**, and the confidence
levels mean the same thing in every audit here:

- **proven** — demonstrated by a test in this repo that fails without the fix,
  or by `cargo` / `tsc` rejecting the alternative
- **reading** — traced through source, but not executed
- **suspected** — inferred, with the reason it could not be proven stated

Nothing is omitted as too minor. Where a finding was considered and *not*
reported, the reason is stated inline — a dropped finding is a decision, and it
is written down as one.

| Audit | Surface | What came out of it |
|---|---|---|
| [2026-07-30 — git surfaces](./2026-07-30-git-surfaces.md) | The working diff viewer, the git sidebar's file list, the refresh architecture, hunk staging, worktrees and stashes, branches, the commit graph | ~100 fixes over three passes. What is left is MEDIUM or below and enumerated in the TODO. |
| [2026-07-31 — embedded browser](./2026-07-31-embedded-browser.md) | The Rust webview module, the pane, the API bridge, tab persistence, and the overlay mechanism the feature imposes on the rest of the app | Eight fixes, including the address bar's dead keyboard. Nine findings deferred with reasons. Closed the standing product question by keeping the feature. |

**A coverage boundary both audits share.** Neither was verified by driving the
running app. jsdom has no layout engine and nothing here can click into a child
webview, so anything whose correctness *is* its geometry was read rather than
observed — which is why a browser test project is the top of the TODO.
