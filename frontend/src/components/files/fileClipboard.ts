/// The explorer's own clipboard — what "Copy" in the file tree put there.
///
/// Deliberately *not* the OS clipboard. `navigator.clipboard` carries text, and
/// the tree's Copy means "this entry, on this side of the connection", which is
/// a path plus the provider that owns it plus whether it is a directory. Text
/// would lose all three, and would collide with the "Copy path" row two lines
/// above it in the same menu, which genuinely does mean the OS clipboard.
///
/// In memory only: it does not survive a restart, and nothing persists it. A
/// paste target that vanished between the copy and the paste fails at the
/// filesystem, which is the only place that can actually know.
import { createSignal } from "solid-js";

export interface FileClipboardEntry {
  /// The explorer's spelling — scheme-prefixed for a remote entry. Its
  /// provider is derived from it, never stored beside it.
  path: string;
  name: string;
  isDir: boolean;
}

const [entry, setEntry] = createSignal<FileClipboardEntry | null>(null);

export function fileClipboard(): FileClipboardEntry | null {
  return entry();
}

export function copyToFileClipboard(e: FileClipboardEntry): void {
  setEntry(e);
}

export function clearFileClipboard(): void {
  setEntry(null);
}
