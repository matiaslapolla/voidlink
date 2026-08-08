# Stream D — right-click belongs to the app

Branch: `feat/context-menus`, cut from `feat/pane-groups`. Merge after C.

```text
<context>
VoidLink is a Tauri desktop app, but it is drawn in a webview, and a webview
answers right-click with the browser's own menu: Reload, Inspect Element,
autofill suggestions, Back. Testing found this everywhere the app has not
already claimed the gesture — which is most places. Only four surfaces call
`preventDefault` today (`FileTree`, `WorkspaceRail`, `GitSidebar`, `TabStrip`),
so a right-click anywhere else offers the user a menu about the *browser*
inside an app that is not one.

The fix is two halves and the second is the one worth care. Suppressing the
native menu globally is a few lines. Deciding what each surface offers instead
is the actual work: a right-click that does nothing at all is better than the
wrong menu, but only barely, and the surfaces the user right-clicked on are the
ones that should answer.
</context>

<task>
1. Suppress the native context menu document-wide, in every window root. Keep it
   alive under `import.meta.env.DEV` so Inspect Element still works while
   developing — this app is developed in itself.

2. Keep native behaviour inside real text inputs. A right-click in a `<input>`,
   `<textarea>` or `contenteditable` should still offer the OS's cut / copy /
   paste / spelling, because nothing the app writes replaces spell-check
   suggestions. Scope the suppression accordingly.

3. Add app context menus on the surfaces that have something to offer. At
   minimum:
   - **empty tab-strip space** — new tab, reopen closed tab, tab orientation;
   - **a pane** — split right, split down, close pane, reset pane layout;
   - **a terminal** — copy, paste, clear, close terminal;
   - **the status bar segments** — the action each segment's tooltip already
     names;
   - **the editor surface** — Monaco owns this; make VoidLink's suppression not
     break Monaco's own menu, and verify it still appears;
   - **the five sidebars' bodies** — the move/detach rows `SidebarMenuButton`
     already renders, reachable by right-click as well as by the ⋮ button;
   - **the board** — new card, open card in editor, delete card.
   Every row runs a registered action where one exists.
</task>

<reuse>
- `frontend/src/components/ui/Menu.tsx` — the one menu implementation. It has
  the portal, the viewport clamp, the enter/exit motion, roving `tabindex`
  keyboard navigation, the Escape handler and a dismiss that survives a drag
  begun outside it. Every menu in this stream is this component. Do not write a
  second one; the file's own history is three copies being collapsed into it.
- `frontend/src/components/git/ContextMenu.tsx` — the adapter over `ui/Menu`,
  and where `ContextMenuItem`'s shape (`label`, `onSelect`, `danger`,
  `disabledReason`, `separatorBefore`) is documented. `disabledReason` is
  preferred over `disabled` because §7.6 forbids a disabled control that does
  not say why.
- `frontend/src/components/files/FileTree.tsx` lines ~395 and ~434 — the
  existing `onContextMenu={e => { e.preventDefault(); setContextMenu({...}) }}`
  pattern, and the one to generalise.
- `frontend/src/components/layout/SidebarDock.tsx` — `SidebarMenuButton` already
  builds the move/detach rows. Right-click should open *that* item list, not a
  parallel one.
- `frontend/src/commands/registry.ts`, `commands/actionIds.ts`,
  `commands/shortcuts.ts` — `getAction`, `runAction`, `shortcutLabel`. Menu rows
  show their accelerator and run the registered action, so the chord, the
  palette row and the menu row stay one code path. `TitleBar.tsx`'s `NavButton`
  is the worked example.
- `frontend/src/main.tsx` — where each window root mounts; the global handler
  goes in one place that all four roots reach, not four copies.
- `frontend/src/components/terminal/` — the xterm host, for what a terminal
  right-click can actually offer (xterm has its own selection model).
</reuse>

<constraints>
- Query context7 for `monaco-editor` (pinned `^0.55.1`) on its context-menu
  API before touching the editor surface — whether `contextmenu: true` draws
  Monaco's own menu, and how a document-level `preventDefault` interacts with
  it. Monaco's menu is not the webview's and must survive.
- Also query context7 for `@xterm/xterm` (`^6.0.0`) on right-click and selection
  handling before adding a terminal menu; xterm intercepts pointer events for
  selection and mouse-reporting mode changes what a right-click means.
- One handler, not thirty. A document-level listener plus a small `data-*`
  or closest-match convention beats sprinkling `onContextMenu` on every element.
  Whatever convention you pick, state it in a comment in one place.
- Every menu row that is present but unavailable states its reason
  (`disabledReason`) — `frontend/design-system/MASTER.md` §7.6. A row that can
  never apply on a surface is absent, not disabled.
- Menus are keyboard-reachable: `Shift+F10` / the Menu key opens the same menu
  the pointer does, on the focused element.
- Solid, not React. No raw colour literals in `src/components/**`.
- Build exactly this stream. Do not change the pane model, the sidebars, the
  board's data layer or the CSS background layer. You will be editing
  `TabStrip.tsx`, which Stream C also rewrote — you are branched from it, so
  build on what is there rather than reverting toward `main`.
</constraints>

<assumptions>
- Suppression is `window.addEventListener("contextmenu", e => e.preventDefault())`
  at the capture phase in production only, with the text-input exemption above,
  and app menus call `stopPropagation` rather than relying on ordering.
- Where a surface has no menu worth showing, right-click does nothing. That is
  the intended end state, not a gap.
- The board menu's "delete card" is destructive and gets `danger: true` plus a
  confirm, matching how destructive rows behave elsewhere in the app.
</assumptions>

<out_of_scope>
- A native OS menu via Tauri's menu API. These are in-app menus, like every
  other menu in the app.
- Changing what any existing menu (`FileTree`, `WorkspaceRail`, `GitSidebar`,
  the tab and tab-group menus) already offers — only how it is reached.
- New actions that do not already exist somewhere as a chord, a button or a
  palette row. This stream surfaces actions; it does not invent them.
- Menu theming or motion changes.
</out_of_scope>

<acceptance>
- Right-click anywhere in a production build shows either a VoidLink menu or
  nothing — never Reload / Inspect Element / autofill. Check all four window
  roots (`main`, `editor`, `git`, `panel-*`).
- In a dev build, Inspect Element still works.
- Right-click inside a text input still offers the OS menu.
- Monaco's own context menu still appears over the editor.
- Every surface listed in <task> answers a right-click, and every row runs the
  same action its chord and palette row do.
- `Shift+F10` opens the same menu on the focused element.
- Render tests for the new menus: rows present, `disabledReason` set where a row
  is unavailable, `onSelect` dispatching the registered action.
- A browser test asserting `contextmenu` is defaultPrevented on a non-input
  element and not prevented inside an `<input>`.
- `npm run test`, `npx vitest run --project browser`, `npx tsc --noEmit`,
  `npx eslint .` clean; `npm run build` succeeds.
</acceptance>
```
