/// The file tree's right-click menu, as pure data.
///
/// Same argument as `components/terminal/terminalMenu.ts`: the question with a
/// wrong answer here — which rows appear, and which are disabled and why — is
/// data in, data out, and testable without mounting a virtualized tree, a
/// layout store and a Tauri bridge just to check whether Paste is greyed.
/// `FileTree.tsx` keeps the rendering; this file keeps the policy.
import { isRemotePath, sameSource } from "@/api/fsProvider";
import type { FileClipboardEntry } from "./fileClipboard";

export interface FileTreeMenuTarget {
  path: string;
  name: string;
  isDir: boolean;
}

export interface FileTreeMenuInput {
  target: FileTreeMenuTarget;
  clipboard: FileClipboardEntry | null;
}

/// A row that is always offered but not always usable. `disabledReason` doubles
/// as the row's tooltip, so an unusable row explains itself rather than being
/// an unexplained dead click (MASTER's rule about disabled controls).
export interface MenuRowState {
  enabled: boolean;
  disabledReason?: string;
}

export interface FileTreeMenuState {
  /// True for anything under a remote root.
  isRemote: boolean;
  /// Whether the git-backed rows (diff, blame, compare, stage, discard) are
  /// offered at all. A remote root has no repository behind it in this slice —
  /// no decorations, no blame, no staging — and offering the rows disabled
  /// would imply they are coming, one menu-full at a time.
  showGitRows: boolean;
  duplicate: MenuRowState;
  copy: MenuRowState;
  paste: MenuRowState;
  /// Where a paste would land: the target itself when it is a directory, and
  /// `null` when there is nowhere valid to paste.
  pasteDir: string | null;
}

export function fileTreeMenuState(input: FileTreeMenuInput): FileTreeMenuState {
  const { target, clipboard } = input;
  const isRemote = isRemotePath(target.path);

  return {
    isRemote,
    showGitRows: !isRemote,
    duplicate: { enabled: true },
    copy: { enabled: true },
    ...pasteState(target, clipboard),
  };
}

function pasteState(
  target: FileTreeMenuTarget,
  clipboard: FileClipboardEntry | null,
): { paste: MenuRowState; pasteDir: string | null } {
  const off = (reason: string) => ({
    paste: { enabled: false, disabledReason: reason },
    pasteDir: null,
  });

  if (!clipboard) return off("Nothing copied yet");
  // Deliberately the target *itself* rather than its parent: pasting onto a
  // file would put the entry somewhere the user did not point at, and the
  // folder they meant is always one row up.
  if (!target.isDir) return off("Paste into a folder");
  if (!sameSource(clipboard.path, target.path)) {
    return off("Copying between local and remote is not supported yet");
  }
  if (clipboard.isDir && isInside(clipboard.path, target.path)) {
    return off("Cannot paste a folder into itself");
  }
  return { paste: { enabled: true }, pasteDir: target.path };
}

/// Whether `dir` is `candidate` or contains it. The check that stops a folder
/// being pasted into its own subtree, which on the remote side would be `cp -a`
/// recursing until the disk fills.
function isInside(dir: string, candidate: string): boolean {
  return candidate === dir || candidate.startsWith(`${dir}/`);
}

/// A free name for a copy of `name` in a directory that already holds
/// `siblings`.
///
/// The suffix goes before the extension (`main copy.ts`, not `main.ts copy`)
/// so the duplicate keeps its language, its icon and its LSP server. Numbering
/// starts at 2 because the first duplicate is "copy", not "copy 1" — Finder's
/// convention, and the one nobody has to read twice.
export function duplicateName(name: string, siblings: string[]): string {
  const dot = name.lastIndexOf(".");
  // A leading dot is the whole name of a dotfile, not an extension: `.env`
  // duplicates to `.env copy`, never to ` copy.env`.
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const taken = new Set(siblings);

  let candidate = `${stem} copy${ext}`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem} copy ${n}${ext}`;
  return candidate;
}

/// Where a Duplicate lands: beside the original, under a free name.
export function duplicateTargetPath(path: string, siblings: string[]): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  return `${dir}/${duplicateName(name, siblings)}`;
}

/// Where a Paste lands: inside `dir`, keeping the copied entry's name unless
/// that name is taken, in which case it is a duplicate of it.
export function pasteTargetPath(dir: string, name: string, siblings: string[]): string {
  return siblings.includes(name)
    ? `${dir}/${duplicateName(name, siblings)}`
    : `${dir}/${name}`;
}
