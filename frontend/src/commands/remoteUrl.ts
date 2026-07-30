/// What counts as a git remote URL, and what counts as a remote name.
///
/// Neither was checked anywhere. `repo.remote("origin", "not a url")` returns
/// **`Ok(())`** — libgit2 stores whatever string it is given — so a typo
/// produced a remote that looked entirely normal in the dialog and failed only
/// later, at fetch or push time, with an error that named the network rather
/// than the typo. The dialog's only guard was `if (!url) return`.
///
/// Deliberately permissive: git accepts far more than GitHub HTTPS and SSH,
/// and a validator that rejects a legitimate URL is worse than one that lets an
/// odd one through. This rejects the shapes that cannot possibly work — the
/// ones with no host at all, or with whitespace inside — and accepts
/// everything else.

/// The forms git understands, near enough:
///   - `scheme://[user@]host[:port]/path` for https, http, git, ssh, ftp(s)
///   - `[user@]host:path` — the scp-like syntax, the most common SSH form
///   - `file:///path` and a bare absolute path — a local clone source
export function isValidRemoteUrl(raw: string): boolean {
  const url = raw.trim();
  if (!url) return false;
  // Whitespace anywhere is the single most reliable signal of a typo, and no
  // legal form contains it.
  if (/\s/.test(url)) return false;

  // Absolute local path, or a `file://` URL.
  if (url.startsWith("/") || url.startsWith("~/")) return true;
  if (url.startsWith("file://")) return url.length > "file://".length;

  const scheme = url.match(/^[a-z][a-z0-9+.-]*:\/\/(.+)$/i);
  if (scheme) {
    const rest = scheme[1];
    // Something has to be there beyond the slashes, and a host cannot start
    // with a slash — `https:///repo.git` names nothing.
    return rest.length > 0 && !rest.startsWith("/");
  }

  // scp-like: `git@github.com:user/repo.git`. Requires a host before the colon
  // and a path after it, so `:repo.git` is rejected.
  const scp = url.match(/^(?:[^@/:]+@)?([^@/:]+):(.+)$/);
  if (scp) return scp[1].length > 0 && scp[2].length > 0;

  return false;
}

/// Git's own rule for remote names, near enough: no whitespace, no `/`, and
/// none of the characters refs reject. Also trims, because `" origin"` used to
/// reach libgit2 verbatim and come back as a raw "is not a valid remote name".
export function normalizeRemoteName(raw: string): string {
  return raw.trim();
}

export function isValidRemoteName(raw: string): boolean {
  const name = normalizeRemoteName(raw);
  if (!name) return false;
  if (/[\s/\\~^:?*[\]]/.test(name)) return false;
  if (name.startsWith(".") || name.endsWith(".")) return false;
  return true;
}
