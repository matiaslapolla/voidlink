/// The language servers VoidLink knows how to start.
///
/// Two, per `<assumptions>`: they cover this repo's own two languages, and both
/// are user-installed binaries found on `PATH` rather than anything bundled or
/// downloaded. Adding a third is a row in `LSP_SERVERS` plus a Settings field —
/// deliberately not a plugin API, which `<out_of_scope>` rules out.
///
/// Nothing here starts a process or touches Monaco. It is a table and three
/// lookups, so the "which server, for which file, at which path" question is
/// answerable in a test.

import type { EditorSettings } from "@/store/settings";

export interface LspServerSpec {
  /// Stable id. Also the binary name, the Settings key and the string the
  /// status segment shows — `rust-analyzer`, as the user would type it.
  id: string;
  args: readonly string[];
  /// Monaco language ids this server is registered against. These are what
  /// `inferLanguage` produces, which is why `.tsx` appears as `typescript`.
  monacoLanguages: readonly string[];
  /// File extensions the server should be started for. Kept separate from the
  /// Monaco ids because the LSP language id for a document is finer-grained —
  /// see `lspLanguageId`.
  extensions: readonly string[];
  /// Sent as `initializationOptions`. `undefined` means send none, which is
  /// different from sending `{}` to a server that checks for the key.
  initializationOptions?: unknown;
}

export const LSP_SERVERS: readonly LspServerSpec[] = [
  {
    id: "rust-analyzer",
    // rust-analyzer speaks stdio with no flag; passing one makes it print
    // usage and exit, which would look exactly like a crash loop.
    args: [],
    monacoLanguages: ["rust"],
    extensions: ["rs"],
  },
  {
    id: "typescript-language-server",
    // Without `--stdio` it defaults to a socket and never reads its stdin.
    args: ["--stdio"],
    monacoLanguages: ["typescript", "javascript"],
    extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
  },
];

/// The server for a Monaco language id, or `null` when there is none. `null` is
/// the common case — most files in most repos have no server, and that path
/// must cost nothing.
export function serverForLanguage(monacoLanguage: string): LspServerSpec | null {
  return LSP_SERVERS.find((s) => s.monacoLanguages.includes(monacoLanguage)) ?? null;
}

export function serverForPath(path: string): LspServerSpec | null {
  const ext = extensionOf(path);
  return LSP_SERVERS.find((s) => s.extensions.includes(ext)) ?? null;
}

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/// The `languageId` for a `textDocument/didOpen`.
///
/// **Not** the Monaco language id. Monaco collapses `.tsx` into `typescript`
/// because its tokenizer is the same, but `typescript-language-server` uses the
/// id to decide whether JSX is legal syntax — open a `.tsx` as `typescript` and
/// every element in the file is reported as a parse error. LSP's registered
/// ids are `typescriptreact` / `javascriptreact`, and this is the one place
/// that distinction is made.
export function lspLanguageId(path: string): string {
  switch (extensionOf(path)) {
    case "rs":
      return "rust";
    case "tsx":
      return "typescriptreact";
    case "jsx":
      return "javascriptreact";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    default:
      return "plaintext";
  }
}

/// Every directory that could hold the TypeScript installation `file` is
/// compiled against, nearest first.
///
/// `typescript-language-server` bundles its own TypeScript and, failing an
/// explicit path, looks for one relative to the workspace root. In a repo whose
/// root is a git root rather than a package root — this one: the root has a
/// lockfile and no `node_modules`, the app lives in `frontend/` — that search
/// misses and every buffer is analysed by a TypeScript that is not the
/// project's. Diagnostics then drift from `tsc` on anything version-sensitive.
///
/// Nearest first because a monorepo can have several, and the one that governs
/// a file is the closest ancestor's. Bounded by `root` so this never walks out
/// of the workspace and into a stray `node_modules` in `$HOME`.
export function tsserverLibCandidates(file: string, root: string): string[] {
  const normalise = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalise(root);
  let dir = normalise(file);
  // A path outside the workspace has no ancestors worth searching.
  if (dir !== base && !dir.startsWith(`${base}/`)) return [];
  const dirs: string[] = [];
  while (dir.length > base.length) {
    dir = dir.slice(0, dir.lastIndexOf("/"));
    if (dir.length >= base.length) dirs.push(dir);
  }
  if (dirs[dirs.length - 1] !== base) dirs.push(base);
  return dirs.map((d) => `${d}/node_modules/typescript/lib`);
}

/// What to actually execute for `spec`: the user's override if they set one,
/// otherwise the bare binary name for `PATH` lookup.
///
/// Trimmed, because a path pasted from a terminal arrives with a trailing
/// space more often than not and `locate` would then look for a file whose
/// name ends in one.
export function serverCommand(spec: LspServerSpec, settings: EditorSettings): string {
  return settings.lspServerPaths[spec.id]?.trim() || spec.id;
}
