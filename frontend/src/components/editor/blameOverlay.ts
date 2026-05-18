import { createSignal } from "solid-js";
import { gitApi } from "@/api/git";
import { editorController } from "@/components/editor/editorController";
import type { BlameLine } from "@/types/git";
import type * as Monaco from "monaco-editor";

/// Global enable state, persisted in localStorage so the user's
/// preference survives reloads. Single signal so the StatusBar toggle
/// and the editor overlay stay in sync without prop drilling.
const STORAGE_KEY = "voidlink-blame-enabled";

const initialEnabled = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
})();

const [enabled, setEnabled] = createSignal(initialEnabled);

export function blameEnabled() {
  return enabled();
}

/// Repo path resolver supplied by the App at startup. Without it we'd
/// need every blame call site to know the active workspace's repo; the
/// resolver decouples this module from the store.
let repoPathResolver: (filePath: string) => string | null = () => null;

export function configureBlame(resolver: (filePath: string) => string | null) {
  repoPathResolver = resolver;
  // Subscribe to editor model changes — when the user switches tabs or
  // a file model finishes loading, refresh blame for the now-active
  // path. This handles the race where MainSurface's effect fires
  // before `openFile` has registered the model.
  editorController.subscribe((_files, activePath) => {
    if (!activePath) return;
    if (enabled()) {
      const repo = repoPathResolver(activePath);
      if (repo) void refreshBlameFor(repo, activePath);
    } else {
      clearBlameFor(activePath);
    }
  });
}

export function setBlameEnabled(v: boolean) {
  setEnabled(v);
  try {
    localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
  } catch {
    // ignore quota errors — feature works without persistence
  }
  // Apply immediately to the currently-active editor file so the
  // toggle feels instant instead of waiting for the next tab switch.
  const active = editorController.getActivePath();
  if (!active) return;
  if (v) {
    const repo = repoPathResolver(active);
    if (repo) void refreshBlameFor(repo, active);
  } else {
    clearBlameFor(active);
  }
}

export function toggleBlame() {
  setBlameEnabled(!enabled());
}

/// Active decoration handles per file path so refreshing one file
/// doesn't wipe another's overlay.
const activeDecorations = new Map<string, string[]>();
const inflight = new Map<string, Promise<BlameLine[]>>();

const REL_DAY = 86_400;
const REL_HOUR = 3_600;
const REL_MIN = 60;

function relTime(seconds: number): string {
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - seconds);
  if (diff < REL_MIN) return "just now";
  if (diff < REL_HOUR) return `${Math.floor(diff / REL_MIN)}m ago`;
  if (diff < REL_DAY) return `${Math.floor(diff / REL_HOUR)}h ago`;
  if (diff < REL_DAY * 30) return `${Math.floor(diff / REL_DAY)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

function annotationText(line: BlameLine): string {
  // Leading non-breaking space pads the annotation away from the code's
  // last character. Monaco strips a normal space at the edge of
  // injected text.
  const lead = "   ";
  if (line.uncommitted) return `${lead}• You · Uncommitted`;
  return `${lead}${line.shortOid} · ${line.authorName || "?"} · ${relTime(line.time)} · ${line.summary}`;
}

/// Apply blame decorations to the editor for `filePath`. If the model
/// isn't loaded yet we wait one frame and retry once — this covers the
/// race between activeItem flipping and editorController.openFile
/// finishing.
export async function refreshBlameFor(repoPath: string, filePath: string) {
  if (!enabled()) {
    clearBlameFor(filePath);
    return;
  }
  const monaco = editorController.getMonaco();
  const editor = editorController.getEditor();
  let model = editorController.getModel(filePath);
  if (!monaco || !editor) return;
  if (!model) {
    await new Promise((r) => requestAnimationFrame(r));
    model = editorController.getModel(filePath);
    if (!model) return;
  }
  const liveModel = model;

  let blamePromise = inflight.get(filePath);
  if (!blamePromise) {
    blamePromise = gitApi.blameFile(repoPath, filePath).catch((e) => {
      // Files outside the repo, never committed, or .gitignored blow
      // up here — that's expected; just skip the overlay.
      console.debug("[blame] failed for", filePath, e);
      return [] as BlameLine[];
    });
    inflight.set(filePath, blamePromise);
  }

  const blame = await blamePromise;
  inflight.delete(filePath);

  // Re-check enable state after the await; the user may have toggled.
  if (!enabled()) {
    clearBlameFor(filePath);
    return;
  }

  // Inject `after` content at the END of each line so the annotation
  // renders as a trailing comment (GitLens style). A zero-width range
  // at column 1 would inject BEFORE the line content and push code
  // rightward — that's not what we want.
  const decorations: Monaco.editor.IModelDeltaDecoration[] = blame.map((b) => {
    const maxCol = liveModel.getLineMaxColumn(b.line);
    return {
      range: new monaco.Range(b.line, maxCol, b.line, maxCol),
      options: {
        description: "voidlink-blame",
        after: {
          content: annotationText(b),
          inlineClassName: b.uncommitted
            ? "voidlink-blame voidlink-blame-uncommitted"
            : "voidlink-blame",
        },
      },
    };
  });

  const prev = activeDecorations.get(filePath) ?? [];
  const next = liveModel.deltaDecorations(prev, decorations);
  activeDecorations.set(filePath, next);
}

export function clearBlameFor(filePath: string) {
  const model = editorController.getModel(filePath);
  if (!model) {
    activeDecorations.delete(filePath);
    return;
  }
  const prev = activeDecorations.get(filePath) ?? [];
  if (prev.length === 0) return;
  model.deltaDecorations(prev, []);
  activeDecorations.delete(filePath);
}

export function clearAllBlame() {
  for (const path of [...activeDecorations.keys()]) clearBlameFor(path);
}
