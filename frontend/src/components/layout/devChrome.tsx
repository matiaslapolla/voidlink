/// Dev-build chrome: the one signal that says "this window is not the app you
/// installed".
///
/// Running `make dev` next to the bundled voidlink means two identical-looking
/// windows, and acting on the wrong one is the kind of mistake you only notice
/// after the fact. So the dev build paints its title bar purple — in all three
/// windows — and adds a `DEV` chip.
///
/// The colours live in `.dev-chrome` in `index.css` as literals rather than
/// theme tokens: the tint has to survive a light/dark switch untouched, which it
/// cannot do if it resolves through the theming layer. The matching signal on
/// the OS side (a tinted dock icon) comes from `src-tauri/tauri.dev.conf.json`.

import type { JSX } from "solid-js";

/// True when Vite served this bundle — `npm run dev` and therefore `make dev`.
/// False in anything `tauri build` produced, including `--debug` builds, which
/// ship the real frontend bundle.
export const IS_DEV_BUILD = import.meta.env.DEV;

/// Drop into a title bar's `class` list. Empty in a production bundle, so the
/// call sites need no `Show` wrapper around their own styling.
export const DEV_CHROME_CLASS = IS_DEV_BUILD ? "dev-chrome" : "";

/// The text half of the signal — colour alone is not a signal for everyone, and
/// a screenshot of a purple bar means nothing without the word.
export function DevBadge(props: { class?: string }): JSX.Element {
  if (!IS_DEV_BUILD) return null;
  return (
    <span
      class={`dev-chrome-badge shrink-0 ${props.class ?? ""}`}
      title="Development build — served by Vite, not the installed bundle"
    >
      DEV
    </span>
  );
}
