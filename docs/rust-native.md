# Plan de Migración: VoidLink de SolidJS/WebView a egui Nativo

## Contexto

VoidLink es un IDE/herramienta de análisis de código construida con Tauri v2, con un frontend SolidJS (TypeScript) que se ejecuta en un WebView y un backend Rust que expone 49 comandos Tauri. El objetivo es evaluar exhaustivamente la migración del frontend web a una UI nativa con egui, eliminando la dependencia del WebView.

---

## 1. PÉRDIDAS DE UI (Estilos Visuales, Interacciones)

### 1.1 Glassmorphism — Pérdida SEVERA

El sistema actual (`frontend/src/styles/index.css`) implementa:

- `backdrop-filter: blur(20px) saturate(130%)` en paneles glass
- Orbes de resplandor ambiental con `radial-gradient` + `filter: blur(80px)` en pseudo-elementos `::before`/`::after`
- Transparencia acrilica de ventana (Tauri `windowEffects: ["acrylic"]`)
- `box-shadow` con capas `inset` para reflejos internos

**En egui**: No hay backdrop blur ni composición de capas. egui dibuja directamente al framebuffer sin capas independientes. Replicar esto requeriría un pipeline wgpu personalizado con render-to-texture y shader de blur Gaussiano multi-pasada. Las ventanas transparentes funcionan via `eframe::NativeOptions::transparent = true` pero el blur-behind depende del compositor del OS (inconsistente en Linux/X11). Los glow orbs no tienen equivalente sin texturas precalculadas o shaders custom.

**Veredicto**: Identidad visual principal irrecuperable sin semanas de trabajo en shaders wgpu. Se recomienda rediseñar la estética.

### 1.2 Sistema de Temas OKLch (10 variantes) — Pérdida MODERADA

Definido en `frontend/src/styles/themes.css` (539 líneas): 10 temas × 60+ variables CSS en espacio OKLch perceptualmente uniforme (dark, light, github-dark/light, monokai, solarized-dark/light, nord, dracula, one-dark).

**En egui**: Usa `Color32` (sRGB 8-bit). No hay OKLch nativo — se necesita conversión via crate `palette`. Los temas se mapean a `egui::Visuals` + struct custom de ~60 campos por tema. Hot-switching es posible (`ctx.set_visuals()`) pero cada widget con color custom debe leer el token activo explícitamente (vs CSS cascade automático).

**Esfuerzo**: ~600 definiciones de color a portar. Funcionalidad replicable, uniformidad perceptual en interpolaciones perdida.

### 1.3 Animaciones y Transiciones — Pérdida SIGNIFICATIVA

Estado actual: transiciones CSS de 60-100ms con curvas custom (`--ease-snap`, `--ease-out-expo`), animaciones fade-in/zoom-in en diálogos, transiciones de opacidad en group-hover, `tw-animate-css`.

**En egui**: Modelo immediate-mode sin concepto de transiciones. Cada propiedad animada requiere estado temporal explícito (`t_start`, `duration`, easing fn`) + `ctx.request_repaint()`. egui provee `animate_bool()`/`animate_value()` pero solo interpolación lineal. Las ~15-20 propiedades animadas de VoidLink requieren ~300-400 líneas de código de animación manual en Rust.

### 1.4 Tipografía — Pérdida SIGNIFICATIVA

Geist Variable (fuente variable) con features OpenType (`kern`, `liga`, `calt`), antialiasing webkit, `text-rendering: optimizeLegibility`.

**En egui**: Sin soporte de fuentes variables (requiere instancias estáticas separadas). Features OpenType limitados (sin ligatures). Rasterizador `ab_glyph`/`fontdue` sin subpixel rendering — texto visiblemente menos nítido a 12-13px en monitores LCD. Sin font fallback automático para emojis/CJK.

### 1.5 Fidelidad de Componentes — Pérdida SEVERA

| Componente                        | Estado actual                                           | En egui                                       |
| --------------------------------- | ------------------------------------------------------- | --------------------------------------------- |
| Botones (6 variantes × 6 tamaños) | CVA con `active:translate-y-px`, `focus-visible:ring-3` | `egui::Button` — estilo único, sin variantes  |
| Diálogos                          | Kobalte con overlay blur, animaciones zoom-in/fade-in   | `egui::Window` — sin overlay, sin animaciones |
| Tooltips                          | tippy.js con flecha, animación, posicionamiento auto    | `on_hover_text()` — caja básica sin flecha    |
| Context menu                      | Kobalte con separadores, estados disabled/destructive   | `context_menu()` — funcional pero sin polish  |
| Scrollbars                        | Ocultas por defecto, 6px al hover, thumb redondeado     | Parcialmente configurable, menor refinamiento |

### 1.6 Layout Flexbox — Pérdida MODERADA

CSS flexbox (`flex-grow`, `gap`, `overflow`, `order`, `min-width/max-width`) → egui `horizontal()`/`vertical()` + `StripBuilder`. Replicable pero con más código explícito. `text-overflow: ellipsis` no existe en egui (truncado manual). `group-hover` no propaga automáticamente.

### 1.7 Resize Responsivo — Pérdida MENOR

`ResizeHandle` con rAF coalescing y snap easing → `egui::SidePanel`/`TopBottomPanel` con resize nativo. Funcionalidad equivalente, transitions de easing perdidas.

### 1.8 Sombras y Glows — Pérdida SEVERA

`box-shadow` multi-capa y variables `--glow-*` no tienen equivalente. Se puede simular con `Painter::rect_filled()` semi-transparente, pero sin spread/blur de CSS.

---

## 2. PÉRDIDAS DE FEATURES (Funcionalidades)

### 2.1 Editor de Texto Rico (Tiptap/ProseMirror) — CRÍTICA

`frontend/src/components/editor/Editor.tsx`: Tiptap 3.20 con StarterKit, TaskList, DragHandle, SlashCommand (suggestion popup), NestedPageNode, MarkdownPaste.

**En Rust**: No existe equivalente. `egui::TextEdit` es solo texto plano. `egui_commonmark` renderiza markdown (solo lectura). Construir un editor estructurado comparable a ProseMirror es un proyecto de meses/años.

**Recomendación**: Simplificar a editor markdown con preview, no intentar replicar Tiptap.

### 2.2 Terminal (xterm.js) — PARCIAL

`frontend/src/components/terminal/TerminalPane.tsx`: xterm.js 6.0 con 8 addons, 16 colores ANSI, canvas renderer, multi-tab.

**Alternativa Rust**: `alacritty_terminal` — parser VT100/ANSI completo, grid con atributos, historial. Requiere renderizar el grid carácter por carácter con `egui::Painter`. Comunicación PTY directa (sin IPC). Web links, Unicode graphemes y clipboard requieren trabajo adicional. Experiencia probablemente inferior en rendering de texto.

### 2.3 Grafos 2D/3D (Three.js + d3-force) — SEVERA (3D) / MODERADA (2D)

`Graph3D.tsx` (Three.js) y `Graph2D.tsx` (force-graph + d3-force) con nodos coloreados por lenguaje, filtros interactivos, zoom/pan.

**2D**: Viable con `egui_plot` + crate `fdg` para simulación de fuerzas. Hit-testing manual necesario.
**3D**: egui NO tiene renderer 3D. Requiere integración wgpu via `egui::PaintCallback` + crate `three-d`. Complejo.

**Recomendación**: Mantener solo grafo 2D inicialmente.

### 2.4 Syntax Highlighting (Shiki) — MÍNIMA

`FileEditor.tsx`: Shiki 4.0 con 20 lenguajes precargados, mapeo tema→tema Shiki.

**Alternativa Rust**: `syntect` (gramáticas TextMate, cientos de lenguajes/temas) o `tree-sitter` (parser incremental, más preciso). Rendering via `egui::text::LayoutJob` con secciones coloreadas. Equivalente o superior en rendimiento.

### 2.5 Tabs con Drag-and-Drop — MENOR

HTML5 Drag API con preview/pinned tabs. **En egui**: `egui_dock` proporciona tabs dockable con reordenamiento. Preview vs pinned requiere customización. Single/double/middle-click disponibles.

### 2.6 LSP UI — MODERADA

Squiggles coloreados, hover tooltips, goto definition. **Backend LSP se mantiene intacto** (ya en Rust). La comunicación sería directa sin IPC. UI requiere: ondas sinusoidales con `PathShape`, tooltips custom con rich text, hit-testing a nivel de carácter via `galley.cursor_from_pos()`.

### 2.7 Diff Viewer — MODERADA

Unified + side-by-side con syntax highlighting por archivo. Requiere widget custom con dos `ScrollArea` sincronizados. Algoritmo de diff ya en backend (libgit2). Sin crates existentes.

### 2.8 Accesibilidad — SIGNIFICATIVA

Kobalte Core provee ARIA roles, focus management, keyboard navigation. egui tiene `AccessKit` pero significativamente menos maduro. Focus trapping, roving tabindex y navegación compleja requieren implementación manual.

### 2.9 Editor de Código (FileEditor) — SIGNIFICATIVA

El componente más complejo: Shiki highlighting + LSP integration + git blame gutter + find-in-file + virtualización de líneas + sincronización de scroll.

**En egui**: No existe `egui_code_editor` comparable. Requiere construir: layout virtualizado, gutter multi-lane, overlay de diagnósticos, popup de hover, búsqueda incremental. Referencia: crate `lapce`.

### 2.10 Hot Reload (DX) — SIGNIFICATIVA e IRRECUPERABLE

Vite HMR: cambios reflejados en ~50-200ms sin perder estado. **Con egui**: `cargo watch -x run` = 5-15s de recompilación + pérdida total de estado. `hot_lib_reloader` es experimental. La velocidad de iteración del desarrollador se degrada sustancialmente.

---

## 3. NUEVAS CAPACIDADES

### 3.1 Renderizado GPU Directo

- Eliminación del proceso WebView separado (Wry/WebKitGTK)
- Pipeline: egui genera vértices → wgpu → GPU → framebuffer directo
- Eliminación de ~50-100ms de input latency adicional del WebView en Linux (issues conocidos en `TerminalPane.tsx`: Wry WebGL context loss, tauri-apps/tauri#8020)

### 3.2 Integración Nativa con el OS

- System tray con menú contextual nativo
- Menú bar del sistema operativo (File, Edit, View) con aceleradores
- Asociaciones de archivos (.rs, .ts, .py → abrir en VoidLink)
- Drag-and-drop desde file manager del OS via `eframe::App::raw_input()`
- Notificaciones nativas (libnotify, Notification Center)

### 3.3 Memoria Compartida sin IPC

Estado actual: `Frontend (JS) → JSON.stringify() → IPC → serde deserialize → Rust → result → JSON serialize → IPC → JSON.parse() → Frontend`

Nueva arquitectura: `egui UI → direct Rust fn call → Rust type → egui reads it`

Impacto concreto:

- **Terminal**: Bytes PTY → parser `alacritty_terminal` directo (sin Channel/Event). Latencia ~1-2ms → ~0.01ms
- **LSP**: Mensajes JSON-RPC deserializados una vez, sin re-serialización para IPC
- **Git**: `DiffResult`, `BlameLineInfo`, `FileStatus` leídos directamente de structs Rust sin `Serialize`
- **git_file_status** (llamado frecuentemente): eliminación de ~2-5ms de overhead JSON por llamada

### 3.4 Pipeline de Rendering Custom (wgpu)

- Shaders compute para simulación de fuerzas en GPU (miles de nodos)
- Texto SDF (Signed Distance Field) para zoom continuo sin pérdida
- Blur Gaussiano como post-proceso (reemplazo potencial de glassmorphism)
- Terminal GPU-accelerated con instanced rendering (técnica Alacritty)

### 3.5 Binario Único

- Sin dependencia de WebView runtime del sistema
- ~15-25MB estático vs bundle actual que requiere WebKitGTK/WebView2
- Cross-compilation simplificada: `cargo build --target x86_64-unknown-linux-musl`
- Eliminación de variabilidad cross-platform del WebView

### 3.6 Menor Consumo de Memoria

- **Actual estimado**: ~75MB (Rust) + ~200MB (WebView) = **~275MB**
- **Con egui estimado**: ~135MB proceso único = **~51% de reducción**

### 3.7 Startup Más Rápido

- **Actual**: ~480-920ms al primer paint (WebView init + JS bundle parse + hidratación)
- **Con egui**: ~125-170ms (window + wgpu context + primer frame)
- **Mejora: ~4-6x más rápido**

### 3.8 Acceso Directo al Ecosistema Rust

Crates disponibles sin bridge IPC: `tree-sitter` (parser incremental), `alacritty_terminal`, `syntect`, `similar` (diff), `ropey` (rope para archivos grandes), `notify` (file watcher), `fuzzy-matcher`, `egui_dock`, `copypasta` (clipboard), `resvg` (SVG).

---

## 4. COMPARATIVA DE RENDIMIENTO EN PATRONES DE IMPLEMENTACIÓN

### 4.1 Rendering: DOM vs Immediate-Mode

| Aspecto                 | SolidJS (actual)                                             | egui                                                      |
| ----------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| Modelo                  | Fine-grained reactivity — solo actualiza nodos DOM afectados | Immediate-mode — reconstruye árbol UI completo cada frame |
| Cambio de 1 atributo    | ~1-3ms (actualiza 1 nodo)                                    | ~2-5ms (traversal de ~500 widgets)                        |
| Reconstrucción completa | ~10-20ms (re-render DOM)                                     | ~2-5ms (misma ruta que parcial)                           |
| Peor caso               | Más lento                                                    | Más rápido                                                |
| Caso promedio           | Más rápido                                                   | Más lento                                                 |

**Ejemplo concreto** — cambio de `columnOrder` en `AppShell.tsx`:

- SolidJS: actualiza solo `style.order` de 3 divs → CSS relayout
- egui: reconstruye todo `CentralPanel` con `match col_id` → mismo costo que cualquier frame

### 4.2 Estado: Reactivity vs Structs Planos

| Aspecto       | SolidJS                            | egui                           |
| ------------- | ---------------------------------- | ------------------------------ |
| Tracking      | Automático (grafo de dependencias) | Manual (leer cada frame)       |
| Memoización   | `createMemo()` automática          | Cache manual con flags "dirty" |
| Persistencia  | `createEffect` → localStorage      | `serde` → disco                |
| Batch updates | `batch()` combina renders          | Inherente (1 update/frame)     |

**Impacto**: `contextTokenEstimate` (suma tokens de context items) se recalcula solo cuando `contextItems` cambia en SolidJS. En egui se recalcularía cada frame salvo cache explícito.

### 4.3 Layout: CSS Flexbox vs egui

**Tab bar actual** (`CenterTabBar.tsx`):

```
CSS: flex, items-center, overflow-x:auto, gap-1.5, truncate, max-w-[120px], group-hover:opacity
```

**En egui**: `ui.horizontal()` + spacing manual + truncado manual + hover check del contenedor padre + `ScrollArea::horizontal()`. Cada propiedad CSS declarativa → ~3-5 líneas imperativas Rust.

### 4.4 Events: DOM vs egui Input

| Aspecto        | SolidJS (DOM)                  | egui                              |
| -------------- | ------------------------------ | --------------------------------- |
| Modelo         | Asíncronos, bubble up          | Síncronos, inline                 |
| Captura global | `window.addEventListener`      | `response.dragged()` auto-captura |
| Coalescing     | `requestAnimationFrame` manual | Inherente (1 update/frame)        |
| preventDefault | `e.preventDefault()`           | Implícito al consumir             |

**Ejemplo**: `ResizeHandle` — SolidJS necesita rAF coalescing + addEventListener global; egui necesita solo `response.dragged()` + `drag_delta()`. Código más simple en egui.

### 4.5 Data Flow: IPC vs Acceso Directo

| Operación                       | SolidJS (IPC)                      | egui (directo)                                |
| ------------------------------- | ---------------------------------- | --------------------------------------------- |
| git_file_status (~100 archivos) | ~8KB JSON serialize/deserialize    | 0 bytes, lectura directa de `Vec<FileStatus>` |
| PTY output                      | Channel → Event → ArrayBuffer      | `Mutex<Vec<u8>>` compartido, ~0.01ms          |
| LSP hover                       | JSON-RPC → JSON → IPC → JSON.parse | JSON-RPC → struct Rust → leído directo        |
| Blame (500-10K líneas)          | Array serializado a JSON           | `Vec<BlameLineInfo>` sin copia                |

### 4.6 Memoria

| Componente         | SolidJS + WebView | egui                 |
| ------------------ | ----------------- | -------------------- |
| Runtime base       | ~50MB (WebKitGTK) | 0 (mismo proceso)    |
| JS heap            | ~30MB             | 0                    |
| DOM + layout       | ~50MB             | 0                    |
| Texture/font cache | ~40MB (browser)   | ~15MB (egui atlas)   |
| 3D/WebGL           | ~30MB (Three.js)  | ~20MB (wgpu buffers) |
| Rust backend       | ~75MB             | ~75MB                |
| **Total**          | **~275MB**        | **~135MB**           |

### 4.7 Build Pipeline

| Aspecto           | SolidJS + Tauri                     | egui                              |
| ----------------- | ----------------------------------- | --------------------------------- |
| Toolchains        | Cargo + Node + Vite + TypeScript    | Cargo solo                        |
| Build incremental | ~35-80s (Cargo + Vite)              | ~30-60s (Cargo)                   |
| Build clean       | ~2.5-5.5min                         | ~3-6min (más Rust)                |
| Hot reload        | Vite HMR ~50-200ms, preserva estado | cargo watch ~5-15s, pierde estado |
| Lenguajes         | Rust + TypeScript + CSS + HTML      | Rust solo                         |

### 4.8 Text Rendering

| Aspecto           | Browser                       | egui                    |
| ----------------- | ----------------------------- | ----------------------- |
| Motor             | HarfBuzz/CoreText/DirectWrite | ab_glyph/fontdue        |
| Subpixel          | Sí (ClearType/LCD)            | No (grayscale AA)       |
| Font features     | Completos (kern, liga, calt)  | Limitados (kern básico) |
| Variable fonts    | Sí                            | No                      |
| Fallback chain    | Automática                    | Manual                  |
| Scripts complejos | Completos                     | Limitados               |

---

## Resumen de Riesgo por Área

| Área                | Pérdida       | Esfuerzo Mitigación        | Prioridad                     |
| ------------------- | ------------- | -------------------------- | ----------------------------- |
| Glassmorphism       | Severa        | Muy alto (shaders wgpu)    | Baja — rediseñar estética     |
| Temas OKLch (10)    | Moderada      | Medio (600 defs de color)  | Media                         |
| Animaciones         | Significativa | Alto (~300-400 LOC)        | Media                         |
| Editor rico Tiptap  | **Crítica**   | Muy alto (meses)           | Alta — simplificar a markdown |
| Terminal xterm.js   | Parcial       | Medio (alacritty_terminal) | Alta                          |
| Grafos 3D           | Severa        | Alto (wgpu pipeline)       | Baja — solo 2D                |
| Syntax highlighting | Mínima        | Bajo (syntect)             | Alta                          |
| LSP UI              | Moderada      | Medio                      | Media                         |
| Diff viewer         | Moderada      | Medio                      | Media                         |
| Accesibilidad       | Significativa | Alto                       | Baja inicialmente             |
| Tab drag reorder    | Menor         | Bajo (egui_dock)           | Alta                          |
| Calidad de texto    | Significativa | **No mitigable**           | N/A                           |
| Hot reload DX       | Significativa | **No mitigable**           | N/A                           |

## Archivos Críticos de Referencia

- `src-tauri/src/lib.rs` — 49 comandos Tauri (boundary IPC → llamadas directas)
- `frontend/src/styles/index.css` — Glass system, variables, animaciones, scrollbars
- `frontend/src/styles/themes.css` — 10 temas con 60+ tokens OKLch cada uno
- `frontend/src/store/layout.ts` — Modelo de estado del layout completo
- `frontend/src/components/editor/FileEditor.tsx` — Componente más complejo (Shiki + LSP + blame + virtualización)
- `frontend/src/components/terminal/TerminalPane.tsx` — Terminal xterm.js con 8 addons
- `frontend/src/components/repository/Graph3D.tsx` — Grafo 3D Three.js
- `frontend/src/components/editor/Editor.tsx` — Editor rico Tiptap
