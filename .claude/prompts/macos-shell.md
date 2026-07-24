# Stream A — macOS shell (icon, rounded window, native title bar)

Branch: `feat/macos-shell` · Worktree: `.worktrees/macos-shell` · Merge order: **1st**

---

<context>
voidlink is a local-first Tauri v2 + SolidJS desktop git workbench (repo root: the cwd; frontend in `frontend/`, Rust in `src-tauri/`). It currently renders a fully custom window chrome: `tauri.conf.json` sets `decorations: false`, so on macOS the app has square corners, no drop shadow, no traffic lights, and a hand-rolled resize overlay. It looks like a web page in a box, not a Mac app. The app icon is also wrong: `src-tauri/icons/icon.png` is a 512x512 full-bleed square, so in the Dock it renders visibly larger and squarer than every neighbouring app.
This stream makes the window and the icon feel native on macOS while leaving Windows/Linux on the existing custom chrome. It is deliberately the smallest stream so it merges first; other streams depend on the `isMac` helper it introduces.
</context>

<task>
1. Regenerate the app icon so it matches macOS icon geometry, and keep the non-macOS icon variants working.
2. Give the window native macOS rounded corners and drop shadow.
3. Use the native macOS title bar (traffic lights over our own content), keeping the current custom title bar on Windows/Linux.
4. Introduce a single platform helper the rest of the app can use.
</task>

<reuse>
- `src-tauri/tauri.conf.json` — the `app.windows[0]` object already has `decorations: false`, `hiddenTitle: true`, `titleBarStyle: "Overlay"`. Note the contradiction: with `decorations: false`, `titleBarStyle` is inert. Fixing that pair is the core of tasks 2 and 3.
- `src-tauri/src/lib.rs` — `.invoke_handler(tauri::generate_handler![...])` starts at line 303; add the new platform command to that list. Add the `#[cfg(not(target_os = "macos"))]` decoration override in the builder's `setup()` closure.
- `frontend/src/components/layout/TitleBar.tsx` — the custom title bar (h-8 / 32px). It renders the drag region (`data-tauri-drag-region`), the sidebar toggles, theme toggle, settings button, and the Minimize/Maximize/Close buttons (`Minus`, `Square`, `X` from lucide-solid). On macOS the three window buttons must go (the OS draws them); everything else stays.
- `frontend/src/components/layout/WindowFrame.tsx` — 8 invisible resize strips calling `getCurrentWindow().startResizeDragging(direction)`. These exist only because `decorations: false`. On macOS they become redundant and will fight the native frame; do not render the component there.
- `frontend/src/App.tsx` — `<WindowFrame />` is rendered at the end of `AppInner`'s JSX (~line 727).
- `src-tauri/icons/` — the full generated set (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`, `Square*Logo.png`, `android/`, `ios/`). `src-tauri/icons/icon.png` is the 512x512 source.
- `frontend/src/api/` — existing thin `invoke` wrapper modules (`git.ts`, `fs.ts`, `terminal.ts`, `brain.ts`). Put the platform wrapper here in the same style; do not scatter raw `invoke` calls into components.
- Existing capability file `src-tauri/capabilities/default.json` already grants `core:window:allow-start-dragging`, `allow-start-resize-dragging`, `allow-close`, `allow-minimize`, `allow-toggle-maximize`. Custom Rust commands need no capability entry — only core/plugin commands do.
</reuse>

<constraints>
- Query context7 (`resolve-library-id` → `query-docs`) for the Tauri v2 window-customization API before touching `tauri.conf.json` or window code. Pinned versions: `tauri = "2.11"` (Rust), `@tauri-apps/api ^2.10.1` (JS), Solid 1.9.7, Tailwind v4.2.1, TypeScript 5.9.3.
- Icon geometry: macOS expects a 1024x1024 canvas where the artwork body is a 824x824 rounded square (corner radius ~185.4) centred with ~100px transparent margin on every side. The Tauri CLI's `icon` subcommand only *rescales* the source — it does not add padding or the squircle mask. So bake the padding and rounded mask into a new 1024x1024 source PNG first, then regenerate the whole set from it (`npx @tauri-apps/cli icon <source.png>` or `cargo tauri icon <source.png>`, run from `src-tauri/`). Keep the current mark/artwork — this is a geometry fix, not a redesign. Do not hand-edit generated files.
- macOS chrome: set `decorations: true` + `titleBarStyle: "Overlay"` + `hiddenTitle: true` in `tauri.conf.json`, and add `trafficLightPosition` tuned so the buttons sit vertically centred in the 32px title bar. Do NOT set `transparent: true` or enable `macOSPrivateApi` — the native decorations already provide the rounded corners and shadow, and transparency would kill the shadow.
- Cross-platform: `tauri.conf.json` is static, so the platform split lives in Rust. In `setup()`, call `window.set_decorations(false)` under `#[cfg(not(target_os = "macos"))]` so Windows/Linux keep the current custom chrome and the `WindowFrame` resize strips.
- Platform detection in the frontend: add one Rust command returning `std::env::consts::OS` and a `frontend/src/api/platform.ts` wrapper exposing a memoised `isMac()` (resolve once at startup; components must read a synchronous accessor, not await per render). Do NOT add `@tauri-apps/plugin-os` and do not sniff `navigator.userAgent`.
- Separation of concerns: components never call `invoke` directly — they go through `frontend/src/api/*`. No window-chrome logic inside feature components.
- Labels: sentence case only. No `uppercase`, no all-caps text anywhere you add.
- On macOS the drag region must be left-padded (~78px) so it clears the traffic lights, and double-click-to-maximise on the drag region must keep working.
</constraints>

<assumptions>
- The existing icon artwork is kept as-is; only canvas geometry, padding, and the rounded mask change.
- Windows/Linux keep the current custom title bar including the Minimize/Maximize/Close buttons and the `WindowFrame` resize overlay — no visual change there.
- If regenerating the icon needs an image tool, use ImageMagick/`sips` available on the machine; check first and report if neither is present rather than committing a hand-made low-quality asset.
</assumptions>

<out_of_scope>
- Any layout restructure (workspaces, worktrees, tab model) — that is a separate parallel stream on `feat/workspace-worktree-layout`. Do not touch `frontend/src/store/layout.ts`, `WorkspaceTabBar.tsx`, or `MainSurface.tsx`.
- Settings, keychain, keyboard shortcuts, docs — separate streams.
- Redesigning the icon artwork itself.
- Vibrancy / translucent window materials.
</out_of_scope>

<acceptance>
- `cd frontend && npx tsc --noEmit` is clean, and `npm run lint` reports no new errors.
- `cargo check` (and `cargo test` if you add Rust logic worth testing) passes from `src-tauri/`.
- Manual verification on macOS via `cargo tauri dev` (or the project's dev command), reported honestly with what you actually observed: window has rounded corners and a drop shadow; native traffic lights appear at the top-left, vertically centred in the title bar and not overlapping the "Voidlink" label; the custom Minimize/Maximize/Close buttons are gone; dragging the title bar moves the window; double-clicking it maximises; dragging window edges/corners resizes via the native frame; no `WindowFrame` strips render.
- `src-tauri/icons/icon.png` (and the regenerated set) shows the artwork inset with transparent margins, and the app's Dock icon is visually the same size as neighbouring system apps.
- A `frontend/src/api/platform.ts` exists exporting the `isMac` accessor, used by `TitleBar.tsx` and `App.tsx`.
</acceptance>
