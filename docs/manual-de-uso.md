# VoidLink — Manual de uso

Guía completa de todo lo que se puede hacer en VoidLink, con un ejemplo por cada caso de uso.

VoidLink es una aplicación de escritorio (Tauri + SolidJS) que combina:

- Editor de código (Monaco) con pestañas.
- Terminales reales (PTY) con tu shell de login.
- Sidebar de Git con staging, commits, ramas, log, diff y stacks.
- Paleta de comandos y buscador de archivos.

---

## Tabla de contenidos

1. [Instalación y compilación](#1-instalación-y-compilación)
2. [Atajos de teclado globales](#2-atajos-de-teclado-globales)
3. [Paleta de comandos (Cmd/Ctrl+K)](#3-paleta-de-comandos-cmdctrlk)
4. [Buscador de archivos (Cmd/Ctrl+P)](#4-buscador-de-archivos-cmdctrlp)
5. [Editor de código](#5-editor-de-código)
6. [Terminales](#6-terminales)
7. [Git — operaciones básicas](#7-git--operaciones-básicas)
8. [Git — diff y comparación de ramas](#8-git--diff-y-comparación-de-ramas)
9. [Git — stacks (ramas apiladas)](#9-git--stacks-ramas-apiladas)
10. [IA — mensajes de commit y análisis de diff](#10-ia--mensajes-de-commit-y-análisis-de-diff)
11. [Escaneo de secretos](#11-escaneo-de-secretos)
12. [Layout y sidebars](#12-layout-y-sidebars)
13. [Configuración (Settings)](#13-configuración-settings)
14. [Persistencia del workspace](#14-persistencia-del-workspace)
15. [Variables de entorno](#15-variables-de-entorno)

---

## 1. Instalación y compilación

Todos los comandos viven en el `Makefile` de la raíz.

| Comando | Qué hace |
| --- | --- |
| `make dev` | Levanta la app en modo desarrollo (Tauri + Vite). |
| `make frontend` | Levanta solo el dev server de Vite (sin shell nativo). |
| `make lint` | ESLint sobre el frontend. |
| `make build` | `tsc -b && vite build`. |
| `make check` | `lint` + `build` + `cargo check` + `cargo test`. |
| `make bundle` | Empaqueta release Linux (AppImage, deb, rpm). |
| `make bundle-deb` | Solo `.deb`. |
| `make bundle-macos` | `.app` + `.dmg` para la arquitectura actual (solo en macOS). |
| `make bundle-macos-dmg` | Solo `.dmg`. |
| `make bundle-macos-universal` | `.app` + `.dmg` universal (arm64 + x86_64). |
| `make version V=x.y.z` | Sincroniza la versión en `frontend/package.json` y `src-tauri/tauri.conf.json`. |

**Ejemplo — primer arranque local:**

```bash
make dev
```

**Ejemplo — generar un DMG firmable para distribución en Mac:**

```bash
make bundle-macos-dmg
# Resultado: src-tauri/target/release/bundle/dmg/voidlink_<version>_<arch>.dmg
```

**Ejemplo — subir versión antes de un release:**

```bash
make version V=0.2.0
make check
make bundle-macos-universal
```

---

## 2. Atajos de teclado globales

`Mod` = `Cmd` en macOS, `Ctrl` en Linux/Windows. Funcionan aunque el foco esté en el editor o en una terminal.

| Atajo | Acción |
| --- | --- |
| `Mod+K` | Abre la paleta de comandos. |
| `Mod+P` | Abre el buscador de archivos. |
| `Mod+W` | Cierra la pestaña activa. |
| `Mod+S` | Guarda el archivo activo. |
| `Mod+Shift+R` | Repite el último comando ejecutado en la terminal activa. |

**Ejemplo — flujo rápido sin ratón:**

1. `Mod+P` → escribís `auth` → Enter → abre `src/lib/auth.ts`.
2. Editás, `Mod+S` para guardar.
3. `Mod+K` → "Git: Refresh" para ver el archivo aparecer como modificado.

---

## 3. Paleta de comandos (Cmd/Ctrl+K)

Lista única de acciones registradas por la app. Se filtra escribiendo.

| Grupo | ID | Qué hace |
| --- | --- | --- |
| App | `palette.open` | Abre/cierra la paleta. |
| App | `app.settings` | Abre Settings. |
| File | `file.open` | Abre el buscador de archivos. |
| Terminal | `terminal.new` | Crea una nueva terminal PTY. |
| Terminal | `terminal.repeat-last` | Reenvía el último comando ejecutado a la terminal más reciente. |
| Git | `git.refresh` | Refresca el estado del repo (status, ramas, log). |
| Git | `git.compare` | Abre la vista de comparación de ramas/refs. |
| Stack | `stack.branch-on-top` | Crea una rama hija sobre la rama actual. |
| Stack | `stack.restack-all` | Rehace el stack actual de abajo hacia arriba. |
| Stack | `stack.submit` | Crea o actualiza un PR por cada rama del stack. |
| Stack | `stack.open-tab` | Abre el workspace visual del stack. |
| View | `ui.toggle-git-sidebar` | Muestra/oculta el sidebar de Git. |
| View | `ui.toggle-left-sidebar` | Muestra/oculta el sidebar izquierdo (archivos + terminales). |
| View | `ui.swap-sidebars` | Intercambia el sidebar izquierdo y derecho de lado. |
| View | `ui.toggle-diff-mode` | Alterna diff inline ↔ split. |
| View | `ui.toggle-ignore-ws` | Alterna "ignorar whitespace" en los diffs. |

**Ejemplo — preparar un PR sin tocar la terminal:**

`Mod+K` → "git refresh" → `Mod+K` → "stack submit" → la app crea/actualiza los PRs de tu cadena.

---

## 4. Buscador de archivos (Cmd/Ctrl+P)

Búsqueda difusa sobre los archivos rastreados por Git (`git ls-files`). No incluye binarios ni archivos ignorados.

**Ejemplo:**

`Mod+P` → tipear `setdial` → coincide con `frontend/src/components/settings/SettingsDialog.tsx` → Enter abre el archivo en una pestaña nueva del editor.

---

## 5. Editor de código

Monaco editor con resaltado por extensión, tema oscuro o claro y soporte multi-pestaña.

| Acción | Cómo se dispara |
| --- | --- |
| Abrir archivo | Click en el árbol de archivos, `Mod+P`, o desde el sidebar de Git. |
| Cambiar de pestaña | Click en la pestaña, o `Mod+W` para cerrar la activa. |
| Cerrar pestaña | Click en la `×` de la pestaña o `Mod+W`. |
| Marcar sucio | Cualquier edición sin guardar; aparece un punto en la pestaña. |
| Guardar | `Mod+S`. |
| Crear archivo | Botón "+" del MainSurface → "New File". |
| Renombrar/borrar | Click derecho en el árbol de archivos. |

**Ejemplo — abrir, editar y guardar:**

1. `Mod+P` → `README` → Enter.
2. Modificás un párrafo. La pestaña muestra un punto (sucio).
3. `Mod+S` → guarda; el punto desaparece y el sidebar de Git lo marca como modificado.

**Workers de Monaco:** los workers de TypeScript, JSON, CSS y HTML se cargan vía `new URL("monaco-editor/esm/.../*.worker.js", import.meta.url)`. Si modificás `editorController.ts`, mantené el `.js` final — Vite lo necesita para resolver el worker.

---

## 6. Terminales

Cada terminal es un proceso PTY independiente con tu shell de login y un entorno reconstruido vía `zprofile`/`bashrc` (no el entorno minimal que da Tauri).

| Acción | Cómo se dispara |
| --- | --- |
| Nueva terminal | Botón "+" en la sección "Terminals" del sidebar izquierdo, o `Mod+K` → "Terminal: New". |
| Cambiar de terminal | Click en la pestaña/entrada del sidebar. |
| Cerrar terminal | `Mod+W` con la terminal enfocada. |
| Repetir último comando | `Mod+Shift+R` o `Mod+K` → "Terminal: Repeat last". |
| Abrir en una worktree | Click en el ícono de terminal junto al nombre de la worktree. |
| Selección por palabra (click derecho) | Settings → Terminal → "Right-click selects word". |

**Ejemplo — correr tests, ajustar y repetir:**

1. `Mod+K` → "Terminal: New".
2. `pnpm test --filter auth` → Enter.
3. Volvés al editor, arreglás algo.
4. Volvés a la terminal, `Mod+Shift+R` → reejecuta el mismo comando.

**Detalles internos:** la app guarda en memoria el último comando enviado a cada PTY (snapshot al `Enter`). Backspace, `Ctrl+C` y `Ctrl+U` se respetan al recordar la línea. No se hace historial completo de shell — solo "lo último que tipeaste".

---

## 7. Git — operaciones básicas

Sidebar derecho, secciones colapsables. Todas las operaciones llaman al backend Rust (`git2` + `libgit2` vendoreado).

| Operación | Disparador |
| --- | --- |
| Ver estado | Sección "Changes". |
| Stagear archivo | Click en el ícono de stage del archivo. |
| Unstagear | Click en el ícono de unstage. |
| Stagear todo | Botón "Stage all". |
| Commitear | Escribir en el textarea de mensaje → botón "Commit". |
| Generar mensaje con IA | Botón "AI" junto al textarea (requiere comando configurado en Settings → AI). |
| Cambiar de rama | Click en la rama en la sección "Branches" (auto-stash si hay cambios sucios). |
| Crear rama | Menú contextual en "Branches" → "New branch". |
| Push | Botón "Push" del sidebar. |
| Ver log | Sección "Log" con últimos N commits. |
| Refrescar | Botón refresh o `Mod+K` → "Git: Refresh". |

**Ejemplo — flujo de commit limpio:**

1. Modificás archivos → aparecen en "Changes".
2. Click en el ícono de stage del archivo `lib/foo.ts` → pasa a "Staged".
3. Escribís el mensaje en el textarea o presionás "AI" para generarlo.
4. Botón "Commit" → la pestaña queda limpia y el log muestra tu commit nuevo.

---

## 8. Git — diff y comparación de ramas

Dos puntos de entrada:

- **Diff del working tree:** click sobre un archivo en "Changes" → pestaña de diff.
- **Comparación de refs:** `Mod+K` → "Git: Compare branches".

| Acción | Cómo |
| --- | --- |
| Alternar inline ↔ split | `Mod+K` → "View: Toggle inline / split diff" o botón en el header del diff. |
| Ignorar whitespace | `Mod+K` → "View: Toggle ignore whitespace". |
| Aplicar hunk al working tree | Botón "Apply" en el hunk. |
| Revertir hunk | "Apply" con la opción reverse (aplica al revés). |
| Copiar hunk | Botón copiar — pega en el portapapeles como bloque de código. |
| Comparar usando merge-base | Opción "use merge base" al elegir refs en Compare (evita ruido por merges no relacionados). |

**Ejemplo — preparar un commit parcial:**

1. Editás `auth.ts` con dos cambios independientes.
2. Click en el archivo en "Changes" → abre el diff.
3. En el primer hunk pulsás "Apply (stage)" → solo ese hunk queda staged.
4. Commiteás. El segundo hunk queda en el working tree para otro commit.

**Ejemplo — comparar tu rama contra `main`:**

1. `Mod+K` → "Git: Compare branches".
2. Base = `main`, Head = `feature/login`, marcás "use merge base".
3. Lista de archivos a la izquierda, diff a la derecha. Cambiás a split con un click.

---

## 9. Git — stacks (ramas apiladas)

Un *stack* es una cadena `main → A → B → C` donde cada rama es hija de la anterior. Permite abrir un PR pequeño por cada rama en lugar de un PR enorme.

VoidLink guarda los metadatos del stack en la config local del repo:

- `branch.<name>.voidlink-parent` — nombre de la rama padre.
- `branch.<name>.voidlink-parentbase` — hash del tip del padre al crear la hija.
- `branch.<name>.voidlink-prnumber` — número de PR si ya fue submitido.

| Acción | Comando |
| --- | --- |
| Crear rama hija | `Mod+K` → "Stack: Branch on top of current". |
| Marcar padre retroactivamente | Menú contextual en sidebar → "Set parent". |
| Quitar del stack | Menú contextual → "Untrack" (la rama queda; se borran solo los metadatos). |
| Rehacer una rama | `git_stack_restack` (botón en sidebar). |
| Rehacer todo el stack | `Mod+K` → "Stack: Restack all" (de abajo hacia arriba; se detiene en el primer conflicto). |
| Abrir vista de stack | `Mod+K` → "Stack: Open stack workspace". |
| Crear/actualizar PRs | `Mod+K` → "Stack: Submit to GitHub" (requiere `GITHUB_TOKEN`). |
| Configurar trunks del repo | Settings → Stack → "Trunk branches" (o `git config voidlink.stack.trunks "main,master"`). |

**Ejemplo — partir un feature grande en tres PRs encadenados:**

1. Estás en `main` y querés agregar autenticación. `git checkout -b feat/auth-schema`.
2. `Mod+K` → "Stack: Branch on top" → nombre `feat/auth-api` → te coloca en la hija.
3. Otra vez "Stack: Branch on top" → `feat/auth-ui`.
4. Trabajás y commiteás en cada rama según corresponda.
5. Si `main` avanza, `Mod+K` → "Stack: Restack all" rebasea las tres ramas en orden.
6. `Mod+K` → "Stack: Submit" → tres PRs draft en GitHub, cada uno apuntando a su padre.

**Detalle de seguridad de restack:** la operación es atómica por rama. Si hay conflicto, no se modifica nada — el working tree queda intacto y resolvés a mano en tu terminal.

---

## 10. IA — mensajes de commit y análisis de diff

VoidLink no llama directamente a APIs de LLM. En su lugar invoca un **comando shell** que vos definís en Settings → AI. El diff staged se pipea por stdin y la salida estándar se usa como mensaje.

**Presets sugeridos:**

- **Claude CLI:** `claude -p "Write a concise conventional commit message for this diff"`
- **Ollama:** `ollama run llama3.2 "Conventional commit message:"`
- **OpenAI Codex CLI:** `codex commit-message`

Ventaja: no hay claves guardadas dentro de la app — la autenticación la maneja la CLI.

**Ejemplo:**

1. Settings → AI → pegar el comando de Claude → Done.
2. Stageás cambios.
3. Botón "AI" en el textarea de commit → aparece el mensaje generado, editable antes de commitear.

---

## 11. Escaneo de secretos

Antes de commitear, VoidLink puede escanear el diff staged en busca de patrones sospechosos. Las reglas viven en `frontend/src/commands/secretScan.ts`:

- AWS access key id (`AKIA…` / `ASIA…`).
- AWS secret access key (`aws_secret_access_key = …`).
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`).
- Anthropic API key (`sk-ant-…`).
- OpenAI API key (`sk-…`, excluyendo Anthropic).
- Google API key (`AIza…`).
- Slack token (`xox[abposr]-…`).
- Private key blocks (`-----BEGIN … PRIVATE KEY-----`).
- Asignaciones genéricas `password|secret|api_key|access_token|auth_token = "…"` (filtra placeholders tipo `your-…`, `xxx`, `example`).

Los matches se muestran ofuscados en el diálogo de revisión, con archivo y línea.

**Ejemplo — falso positivo controlado:**

Si tenés `const fake = "sk-test-1234567890abcdef"` en un test, el regex genérico lo va a marcar. Confirmás el commit desde el diálogo si sabés que es seguro.

---

## 12. Layout y sidebars

Estructura general:

```
┌────────────────────────────────────────────────┐
│ TitleBar                                       │
├──────────────┬──────────────────┬──────────────┤
│              │                  │              │
│ Sidebar      │   MainSurface    │  Sidebar     │
│ izquierdo    │   (pestañas:     │  derecho     │
│ (Archivos +  │    editor /      │  (Git:       │
│  Terminales) │    terminal /    │   Changes,   │
│              │    diff /        │   Branches,  │
│              │    compare /     │   Log,       │
│              │    stack)        │   Stack)     │
└──────────────┴──────────────────┴──────────────┘
```

| Acción | Cómo |
| --- | --- |
| Ocultar/mostrar sidebar izquierdo | `Mod+K` → "View: Toggle left sidebar" o botón en TitleBar. |
| Ocultar/mostrar sidebar de Git | "View: Toggle git sidebar" o botón en TitleBar. |
| Intercambiar lados | "View: Swap left/right sidebars". |
| Redimensionar | Arrastrar el borde del sidebar. |
| Redimensionar secciones del sidebar de Git | Arrastrar la línea divisoria entre secciones. |
| Cambiar tema | Botón sol/luna en TitleBar (los themes adicionales viven en `store/theme.ts`: github, monokai, solarized, nord, dracula, one-dark, …). |

**Ejemplo — modo zen para escribir código:**

`Mod+K` → "Toggle left sidebar" + "Toggle git sidebar" → queda solo el editor a pantalla completa.

---

## 13. Configuración (Settings)

`Mod+K` → "Open settings" o ícono de engranaje en TitleBar. Cuatro pestañas:

### UI

- **Text size:** Small / Base / XL.
- **Spacing:** Compact / Normal / Comfortable.
- **Tema:** controlado desde TitleBar; presets en `store/theme.ts`.

### Terminal

- **Font:** familia, tamaño, line height, letter spacing, weights normal/bold.
- **Ligatures:** off por defecto (mejora performance).
- **Cursor:** estilo (block / underline / bar), blink, ancho.
- **macOS Option = Meta:** rebind para atajos al estilo Emacs/Vim.
- **Right-click selects word:** activa selección por palabra con click derecho.
- **Minimum contrast ratio:** fuerza contraste mínimo de los colores ANSI.
- **Bold is bright:** el negrita usa la paleta "bright".
- **Scrollback:** cantidad de líneas de historia (default 5000).
- **Scroll sensitivity** y **scroll-on-user-input**.

### AI

- **Commit message command:** template shell que recibe el diff por stdin.
- Presets: Claude CLI, Ollama, OpenAI Codex.

### Stack

- **Trunk branches:** override por repo de cuáles ramas son tronco (default: `origin/HEAD` + nombres comunes).

Botones inferiores: **Reset to defaults** y **Done**.

**Ejemplo — terminal con JetBrains Mono y ligaduras:**

Settings → Terminal → Font family = `JetBrainsMono Nerd Font`, size = 13, Ligatures = on. Done.

---

## 14. Persistencia del workspace

VoidLink guarda en disco:

- Pestañas abiertas (archivo / terminal / diff / compare / stack) por workspace.
- Estado *dirty* de cada archivo (advierte al cerrar).
- IDs de las sesiones PTY abiertas.
- Visibilidad de cada sidebar y si están intercambiados.
- Modo de diff (inline/split) y flag de ignorar whitespace.
- Tab activa por workspace.

Al reabrir la app, los archivos vuelven a abrirse y las terminales se recrean en el mismo directorio (perdés el historial visible, pero el cwd se mantiene).

**Ejemplo:** cerrás con `Mod+P` un archivo abierto, una terminal corriendo `htop` en `/var/log` y un diff abierto contra `main`. Al reabrir, encontrás el editor y el diff exactamente igual, y una terminal nueva en `/var/log` lista para `htop`.

---

## 15. Variables de entorno

### Requeridas (core)

- `HOME`, `USER`, `SHELL` — heredadas por las sesiones PTY.

### Stack — submit a GitHub

- `GITHUB_TOKEN` — token con scope `repo`. Sin esto, "Stack: Submit" falla con un mensaje claro; el resto de la app funciona normal.

### IA (opcional)

Cualquier variable que necesite tu CLI configurada en Settings → AI:

- Claude CLI: `ANTHROPIC_API_KEY`.
- OpenAI Codex: `OPENAI_API_KEY`.
- Ollama: ninguna — corre local.

**Ejemplo — exportar tokens en `~/.zshrc` para que los herede VoidLink:**

```bash
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
export ANTHROPIC_API_KEY="sk-ant-xxxx"
```

Como VoidLink levanta cada PTY reconstruyendo el entorno desde `zprofile`/`bashrc`, basta con definirlas ahí.

---

## Apéndice — comandos IPC del backend

Para integraciones o debugging desde la consola del WebView (`Cmd+Option+I`):

```js
// Estado del repo
await __TAURI__.core.invoke("git_repo_info", { repoPath: "/ruta/al/repo" });

// Listar archivos rastreados
await __TAURI__.core.invoke("git_ls_files", { repoPath: "/ruta/al/repo" });

// Stack actual
await __TAURI__.core.invoke("git_stack_current", { repoPath: "/ruta/al/repo" });

// Spawnear un PTY
const id = await __TAURI__.core.invoke("create_pty", { cwd: "/tmp" });
```

Lista completa de comandos: ver `src-tauri/src/lib.rs` (registro de handlers) y `frontend/src/api/{fs,git,stack}.ts` (wrappers tipados).
