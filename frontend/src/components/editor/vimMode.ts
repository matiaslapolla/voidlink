/// Optional Vim keybindings for the shared code editor.
///
/// `monaco-vim` is imported lazily and only when the setting is on, so a user
/// who does not want Vim pays nothing for it — not a chunk, not a keydown
/// listener. Turning the setting off disposes the adapter and the editor goes
/// back to its normal bindings without a reload.
///
/// The mode signal is the other half of the feature, not a nicety: a Vim mode
/// with no visible mode is unusable, because the same keystroke does different
/// things depending on state the user cannot see. `vimStatus()` feeds the
/// status segment; if that ever stops rendering, the setting should be removed
/// rather than shipped blind.
///
/// `monaco-vim`'s own `initVimMode` is bypassed. It only wires the
/// `vim-mode-change` event when handed a DOM node to render *its* status bar
/// into, and that status bar is styled like CodeMirror's — the exact Monaco
/// chrome MASTER.md §11.5 says not to import. Attaching the adapter directly
/// and listening for the same event gives the state without the markup.

import { createSignal } from "solid-js";
import type * as Monaco from "monaco-editor";

/// The modes `monaco-vim` reports. `subMode` distinguishes visual-line and
/// visual-block from plain visual.
export interface VimStatus {
  mode: string;
  subMode?: string;
}

const [vimStatus, setVimStatus] = createSignal<VimStatus | null>(null);

/// Current Vim state, or `null` when Vim mode is off. The status segment
/// renders nothing at all in that case — an "off" indicator would be a
/// permanent reminder of a feature the user declined.
export { vimStatus };

/// `NORMAL`, `INSERT`, `VISUAL LINE`… Uppercased here rather than in CSS so a
/// screen reader hears the same thing the eye reads.
export function vimStatusLabel(): string | null {
  const s = vimStatus();
  if (!s) return null;
  return [s.mode, s.subMode].filter(Boolean).join(" ").toUpperCase();
}

/// Whether the editor is in the mode where keys are commands rather than text.
/// Used for the `--primary` tint (§11.5's "this one is active" idiom).
export function vimInNormalMode(): boolean {
  return vimStatus()?.mode === "normal";
}

/// The shape of `monaco-vim`'s adapter that this module uses. The package types
/// it as `any` throughout, so restating the three members we touch is the only
/// way to keep this file honest under `noImplicitAny`.
interface VimAdapter {
  attach(): void;
  dispose(): void;
  on(event: "vim-mode-change", handler: (ev: VimStatus) => void): void;
}

let adapter: VimAdapter | null = null;
let attachedTo: Monaco.editor.IStandaloneCodeEditor | null = null;
/// Guards against the effect firing twice before the dynamic import resolves.
let pending = false;

/// Attach Vim bindings to `editor`. Idempotent per editor; attaching to a
/// different editor detaches from the previous one first.
export async function enableVim(editor: Monaco.editor.IStandaloneCodeEditor): Promise<void> {
  if (attachedTo === editor || pending) return;
  pending = true;
  try {
    disableVim();
    const mod = (await import("monaco-vim")) as unknown as {
      VimMode: new (editor: Monaco.editor.IStandaloneCodeEditor) => VimAdapter;
    };
    const next = new mod.VimMode(editor);
    next.on("vim-mode-change", (ev) => setVimStatus({ mode: ev.mode, subMode: ev.subMode }));
    next.attach();
    adapter = next;
    attachedTo = editor;
    // `attach()` dispatches the first mode change before the listener above can
    // possibly have fired for it, so seed the resting state explicitly rather
    // than showing an empty segment until the user's first keystroke.
    setVimStatus((cur) => cur ?? { mode: "normal" });
  } catch (e) {
    // A failed chunk load must not take the editor with it — the user keeps
    // normal bindings and the segment stays absent.
    console.warn("Vim mode failed to load", e);
    setVimStatus(null);
  } finally {
    pending = false;
  }
}

/// Detach and clear the mode signal. Safe to call when Vim was never on.
export function disableVim(): void {
  adapter?.dispose();
  adapter = null;
  attachedTo = null;
  setVimStatus(null);
}
