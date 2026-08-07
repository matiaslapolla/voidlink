# Stream A — Vertical-tab editor repair + title-bar alignment

```text
<context>
VoidLink is a Tauri v2 + SolidJS + Tailwind v4 desktop workbench. Its tab strip has
two orientations, set once in settings (`ui.tabOrientation`) and honoured by both the
workbench and the standalone editor window. The vertical orientation is broken in the
editor window: the layout comes out as a dead split, the right side of the window is
unusable, and the markdown-preview button lands somewhere that reads as a bug. A
preference that breaks one of the app's two main windows is worse than not shipping the
preference, so this is the first thing to land in this wave — everything after it
assumes vertical tabs work.

Second, smaller: the window controls do not sit on the same optical baseline as the rest
of the title bar's controls. On macOS the traffic lights are drawn by the OS at a
position we configure; on Windows/Linux we draw our own. Both are currently off.

This is the smallest diff in the wave and lands first.
</context>

<task>
1. Reproduce and fix the vertical-tab layout in the standalone editor window.
   Run the app, set Settings → UI → tab orientation to "vertical", open the editor
   window, and observe. Fix so the vertical layout in `EditorApp` is structurally the
   same shape as the horizontal one: tab column on the leading edge, editor surface
   filling the rest, no dead region, no phantom split, the whole window width usable
   with a single (unsplit) editor group.
2. Put the markdown-preview button somewhere deliberate in the vertical layout.
   `TabStrip` currently drops `trailing` content into a footer row along the bottom of
   the vertical column, which puts a per-file action at the far end of an unrelated
   list. Decide and implement the placement that reads correctly in a vertical column —
   and if that is the footer, make it look intentional (separator, alignment, label)
   rather than an item that fell off the strip.
3. Align the window controls with the rest of the title bar.
   - macOS: tune `trafficLightPosition` in `src-tauri/tauri.conf.json` so the OS-drawn
     buttons centre vertically in the 32px (`h-8`) title bar, and adjust the
     `pl-[78px]` drag-region padding in `TitleBar.tsx` if the x changes.
   - Windows/Linux: the minimise/maximise/close buttons are `w-9` full-height siblings
     of `NavButton`; make their icon optical sizes and vertical centring match the
     neighbouring chrome buttons.
</task>

<reuse>
- `frontend/src/EditorApp.tsx` — `verticalTabs()` (~L421); the `<main>` element that
  forks `flex-col`/`flex-row` on it (~L1046); the `<TabStrip>` call with
  `orientation`/`width`/`trailing` (~L1059-1097, markdown Eye button at ~L1087);
  `EditorGroupsView` + `split`/`splitFraction` (~L1113); the file-tree `<aside>` (~L995).
- `frontend/src/components/layout/TabStrip.tsx` — the single `vertical()` predicate
  (~L365) that the whole orientation fork hangs off, `VERTICAL_TAB_WIDTH` bounds (~L340),
  the footer-row handling of `trailing` (~L264). Fix orientation bugs *here* if the
  cause is in the strip, so the workbench (`MainSurface.tsx` `renderGroup`) gets the
  same fix. Do not fork a second strip.
- `frontend/src/components/layout/TitleBar.tsx` — `NavButton`, the `isMac()` fork around
  the minimise/maximise/close buttons, the `data-tauri-drag-region` element.
- `frontend/src/api/platform.ts` — `isMac()`.
- `src-tauri/tauri.conf.json` — `titleBarStyle: "Overlay"`, `hiddenTitle`,
  `trafficLightPosition`.
- Existing coverage to extend rather than duplicate:
  `frontend/src/components/layout/TabStrip.browser.test.tsx`,
  `frontend/src/EditorApp.test.tsx`.
</reuse>

<constraints>
- Follow `frontend/design-system/MASTER.md`: §7.6 interaction states (no silent disabled
  control, no layout shift on hover), §8 iconography, §10 accessibility. Semantic tokens
  only — `frontend/src/tokenHygiene.test.ts` fails the build on a raw colour literal in
  `src/components/**`.
- One tab strip, one orientation predicate. If the bug is a wrong flex/`min-w-0` on the
  editor side, fix it there; if it is in the strip, fix it in the strip. Do not add an
  `if (editorWindow)` branch.
- Query context7 before touching any Tauri window/config API (`resolve-library-id` →
  `query-docs`, Tauri v2). Do not write window API calls from memory.
- Verify the traffic-light change by running the app on macOS and looking at it. Do not
  ship a computed y value you never saw rendered.
- Build exactly this slice. Make routine judgment calls yourself; check in only where two
  readings mean materially different work. If a premise here looks wrong, say so in one
  sentence and continue as asked rather than quietly widening or narrowing the scope.
</constraints>

<out_of_scope>
- Any change to the workbench's pane split tree (`MainSurface.tsx` geometry).
- New colour tokens or contrast work — Stream D owns that.
- Sidebar docking, detaching, or the vertical-tabs right column — Stream C owns that.
- Adding new sidebar or pane resize handles — Stream B owns that.
- Changing the default value of `ui.tabOrientation`.
- Redesigning the title bar's button set or adding buttons to it.
</out_of_scope>

<acceptance>
- With `ui.tabOrientation: "vertical"`, the editor window shows one tab column and one
  editor surface; the surface reaches the right window edge; clicking anywhere in it
  focuses the editor. Same with a split active, and the split's own handle still drags.
- Toggling orientation back to horizontal restores the previous layout exactly, with no
  reload.
- The markdown-preview button appears for `.md` buffers in both orientations, keeps its
  `aria-label="Preview markdown"`, and opening a preview still works from it.
- A render test in `frontend/src/EditorApp.test.tsx` (or `TabStrip.browser.test.tsx`)
  asserts the vertical-orientation structure that regressed — not a snapshot, an
  assertion about the element that was wrong.
- macOS: traffic lights optically centred in the title bar; the drag region does not
  overlap them (verified by dragging the window from just right of the lights).
- `cd frontend && npm run test` green; `npx tsc --noEmit` clean;
  `cd src-tauri && cargo check` clean.
</acceptance>
```
</content>
