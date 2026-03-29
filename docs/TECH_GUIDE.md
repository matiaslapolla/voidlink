# Guía Técnica — VoidLink

Documento de referencia técnica sobre arquitectura, patrones y decisiones de implementación del proyecto. Orientado a quien esté aprendiendo Rust y quiera entender el código en profundidad.

---

## Índice

1. [Visión general](#1-visión-general)
2. [Stack tecnológico](#2-stack-tecnológico)
3. [Estructura del proyecto](#3-estructura-del-proyecto)
4. [Arquitectura Tauri](#4-arquitectura-tauri)
5. [Módulos Rust](#5-módulos-rust)
6. [Frontend SolidJS](#6-frontend-solidjs)
7. [Sistema de IPC (Frontend ↔ Rust)](#7-sistema-de-ipc-frontend--rust)
8. [Patrones Rust usados](#8-patrones-rust-usados)
9. [Manejo de estado en Rust](#9-manejo-de-estado-en-rust)
10. [Git integration con git2](#10-git-integration-con-git2)
11. [Motor de IA y workflows](#11-motor-de-ia-y-workflows)
12. [Terminal PTY](#12-terminal-pty)
13. [Base de datos SQLite](#13-base-de-datos-sqlite)
14. [Sistema de pestañas (frontend)](#14-sistema-de-pestañas-frontend)
15. [Consideraciones de diseño](#15-consideraciones-de-diseño)

---

## 1. Visión general

VoidLink es una aplicación de escritorio que combina:

- **Editor de documentos** estilo Notion (rich text con Tiptap)
- **Terminal integrado** (xterm.js + PTY real via Rust)
- **Escaneo y búsqueda semántica de repositorios** (indexado con embeddings, búsqueda híbrida)
- **Generación y ejecución de workflows con IA**
- **Suite completa de operaciones Git** (estado, ramas, worktrees, diffs, PRs, agente autónomo)

La app no usa un servidor externo para las operaciones principales: todo corre **localmente** en el proceso Tauri. El backend FastAPI en `/backend/` es opcional y solo se usa para la persistencia de páginas Notion en PostgreSQL.

---

## 2. Stack tecnológico

| Capa | Tecnología | Rol |
|------|-----------|-----|
| Shell de escritorio | **Tauri 2** | Ventana nativa, IPC entre JS y Rust |
| Backend / lógica | **Rust** | Toda la lógica pesada (git, IA, escaneo, PTY) |
| Frontend | **SolidJS + TypeScript** | UI reactiva, renderizado en WebView |
| Estilos | **Tailwind CSS 4 + shadcn/ui** | Utilidades CSS, componentes base |
| Git | **git2 (libgit2)** | Operaciones git sin llamar al binario |
| Terminal | **portable-pty** (Rust) + **xterm.js** | PTY real, renderizado en canvas |
| SQLite | **rusqlite** | Base de datos local embebida |
| HTTP | **reqwest** | GitHub REST API |
| Editor | **Tiptap** (ProseMirror) | Editor de texto enriquecido |
| IA | Adaptador multi-proveedor | OpenAI, Groq, OpenRouter, Ollama |

---

## 3. Estructura del proyecto

```
voidlink/
├── src-tauri/              # Backend Rust
│   ├── src/
│   │   ├── main.rs         # Punto de entrada Tauri
│   │   ├── lib.rs          # Registro de comandos, estado global
│   │   ├── migration.rs    # Escaneo de repos, búsqueda, workflows
│   │   ├── git.rs          # Operaciones git (fases 1-3)
│   │   ├── git_agent.rs    # Agente autónomo (fase 4)
│   │   └── git_review.rs   # Review y merge de PRs (fase 5)
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── frontend/               # SolidJS app
│   └── src/
│       ├── App.tsx         # Componente raíz, orquestación principal
│       ├── types/          # Interfaces TypeScript (espejan structs Rust)
│       ├── api/            # Wrappers de IPC (invoke → comando Rust)
│       └── components/
│           ├── git/        # Suite Git (13 componentes)
│           ├── editor/     # Editor Tiptap
│           ├── terminal/   # TerminalPane + xterm
│           └── tabs/       # Sistema de pestañas
│
└── backend/                # FastAPI opcional (páginas Notion + Postgres)
```

---

## 4. Arquitectura Tauri

### ¿Qué es Tauri?

Tauri es un framework para apps de escritorio que empaqueta un **WebView** (la UI) con un **proceso Rust** (la lógica). Funciona de forma similar a Electron, pero:

- El proceso nativo está en **Rust** (no Node.js), por lo que es mucho más eficiente.
- El WebView usa el motor del sistema operativo (WebKit en macOS/Linux).
- La comunicación JS↔Rust se hace vía IPC asíncrono.

### Flujo de arranque

```
main.rs
  └─ tauri::Builder::default()
       ├─ .manage(MigrationState::new())   ← estado global
       ├─ .manage(GitState::new())
       ├─ .manage(GitAgentState::new())
       ├─ .manage(PtyStore::default())
       ├─ .invoke_handler(generate_handler![...])  ← registra comandos
       └─ .run()
```

`main.rs` es mínimo: solo llama a `lib::run()`. Toda la lógica real está en `lib.rs` y los módulos.

### Comandos Tauri

Un comando Tauri es una función Rust anotada con `#[tauri::command]` que el frontend puede llamar con `invoke("nombre_comando", { args })`.

```rust
// Rust
#[tauri::command]
pub fn git_repo_info(
    repo_path: String,
    state: tauri::State<GitState>,
) -> Result<GitRepoInfo, String> {
    git_repo_info_impl(&repo_path, &state)
}
```

```typescript
// Frontend
import { invoke } from "@tauri-apps/api/core";
const info = await invoke<GitRepoInfo>("git_repo_info", { repoPath });
```

**Puntos clave:**
- Los argumentos se serializan como JSON automáticamente (Serde).
- `Result<T, String>` mapea a `Promise<T>` que puede rechazarse con el mensaje de error.
- `tauri::State<T>` es inyección de dependencias automática — Tauri pasa el estado registrado.

### Eventos Tauri (push del servidor al cliente)

Para notificaciones en tiempo real (progreso de escaneo, output de terminal, eventos del agente):

```rust
// Rust — emitir evento
app_handle.emit("pty-output:session123", "texto del terminal").unwrap();
```

```typescript
// Frontend — escuchar
import { listen } from "@tauri-apps/api/event";
const unlisten = await listen<string>("pty-output:session123", (event) => {
  terminal.write(event.payload);
});
// Limpiar al desmontar componente:
onCleanup(() => unlisten());
```

---

## 5. Módulos Rust

### `lib.rs` — Registro central

Este archivo tiene dos responsabilidades:

1. **Definir el estado global** (`PtyStore`, `MigrationState`, etc.)
2. **Registrar todos los comandos** en `generate_handler![]`

El `PtyStore` es un ejemplo de estructura de estado concurrente:

```rust
#[derive(Default)]
pub struct PtyStore {
    sessions: Mutex<HashMap<String, PtySession>>,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}
```

`Mutex<HashMap<...>>` es el patrón estándar en Rust para estado mutable compartido entre threads. El `Mutex` garantiza acceso exclusivo; el `HashMap` indexa las sesiones por ID.

---

### `migration.rs` — Motor de análisis e IA

El módulo más complejo. Gestiona:

- **Escaneo de repos**: caminar el árbol de directorios con `ignore` (respeta `.gitignore`), chunking de código, cómputo de embeddings.
- **Búsqueda híbrida**: lexical (TF-IDF manual) + semántico (similitud de embeddings).
- **Generación de workflows**: prompt al LLM, parseo de JSON, devolución de `WorkflowDsl`.
- **Ejecución de workflows**: ejecuta cada paso, gestiona retries, emite eventos de progreso.

**`MigrationState`** es el estado central de este módulo:

```rust
pub struct MigrationState {
    db: SqliteStore,                    // base de datos local
    jobs: Mutex<HashMap<String, ...>>,  // jobs de escaneo en curso
    provider: ProviderAdapter,          // cliente LLM
    startup_repo_path: Option<String>,  // repo abierto al iniciar
}
```

Se añadieron dos métodos públicos para que los módulos Git puedan acceder al LLM sin duplicar código:

```rust
pub fn llm_chat(&self, prompt: &str, json_mode: bool) -> Result<String, String> {
    self.provider.chat_completion(prompt, json_mode)
}

pub fn db_path(&self) -> PathBuf {
    self.db.path.clone()
}
```

Este patrón — exponer solo lo necesario con métodos específicos — es preferible a hacer los campos `pub` directamente.

---

### `git.rs` — Operaciones Git (Fases 1–3)

Usa la crate `git2`, que es un binding de `libgit2` (la librería C de Git). Se compila con `vendored-libgit2` para no depender de la instalación del sistema.

**Tipos de datos** (todos con `#[derive(Serialize, Deserialize)]` + `#[serde(rename_all = "camelCase")]`):

```rust
pub struct GitRepoInfo {
    pub repo_path: String,
    pub current_branch: String,
    pub head_oid: String,
    pub is_detached: bool,
    pub is_clean: bool,
    pub remote_url: Option<String>,
}
```

La anotación `rename_all = "camelCase"` hace que Serde serialice `current_branch` como `currentBranch` en JSON, que es la convención de TypeScript.

**Estado:**

```rust
pub struct GitState {
    path_cache: Arc<Mutex<HashMap<String, PathBuf>>>,
}
```

Solo cachea paths resueltos, nunca un `Repository`. Esto es importante porque `git2::Repository` **no implementa `Send`** — no se puede compartir entre threads. La solución es abrir un handle nuevo en cada comando (operación barata).

---

### `git_agent.rs` — Agente autónomo (Fase 4)

Implementa un pipeline de múltiples pasos que corre en un thread separado:

```rust
pub fn git_agent_start(...) -> Result<String, String> {
    let task_id = uuid::Uuid::new_v4().to_string();
    // ...
    std::thread::spawn(move || {
        run_agent_pipeline(task_id, input, state, migration_state, app_handle);
    });
    Ok(task_id)
}
```

Se usa `std::thread::spawn` en lugar de `async` porque `reqwest::blocking::Client` (el cliente HTTP para la GitHub API) no es compatible con runtimes async. Los dos enfoques (sync y async) no se mezclan bien; elegir uno y ser consistente es la decisión correcta.

El pipeline emite eventos al frontend en cada paso:

```rust
app_handle.emit(&format!("git-agent-event:{}", task_id), event).ok();
```

---

### `git_review.rs` — PR Review y Merge (Fase 5)

Gestiona la integración con la GitHub REST API y el log de auditoría en SQLite.

El patrón de consultas SQLite con lifetimes es un punto que vale notar:

```rust
// MAL: lifetime issue — stmt se destruye antes de que se use el iterador
let rows = if condition {
    let mut stmt = conn.prepare(SQL_A)?;
    stmt.query_map(...)?.filter_map(...).collect()  // ← error: stmt dropped
} else { ... };

// BIEN: forzar la colección dentro del bloque
let rows: Vec<Row> = if condition {
    let mut stmt = conn.prepare(SQL_A)?;
    let collected: Vec<Row> = stmt.query_map(...)?.filter_map(...).collect();
    collected  // stmt se destruye DESPUÉS de collect()
} else { ... };
```

Esto es un ejemplo clásico de cómo el borrow checker de Rust protege contra use-after-free: el `Statement` de SQLite tiene un lifetime ligado a la conexión, y el iterador que retorna también tiene ese lifetime. Si intentas devolver el iterador fuera del bloque donde vive el `Statement`, el compilador lo rechaza.

---

## 6. Frontend SolidJS

### ¿Por qué SolidJS en lugar de React?

SolidJS tiene una reactividad basada en señales (signals) que es **granular**: solo re-renderiza exactamente lo que cambió, no el componente entero. Es más eficiente y el modelo mental es más predecible.

**React:**
```tsx
const [count, setCount] = useState(0);
// El componente ENTERO se re-ejecuta cuando count cambia
```

**SolidJS:**
```tsx
const [count, setCount] = createSignal(0);
// Solo el nodo DOM específico que usa count() se actualiza
```

### Regla crítica: no desestructurar props

En SolidJS, las props son objetos reactivos que deben accederse directamente:

```tsx
// MAL — rompe la reactividad
function MyComponent({ value, onChange }) {
  return <div>{value}</div>;  // value es un valor estático, no reacciona
}

// BIEN
function MyComponent(props: { value: string; onChange: () => void }) {
  return <div>{props.value}</div>;  // props.value es reactivo
}
```

### `createResource` — datos async

Para cargar datos desde Rust:

```tsx
const [branches] = createResource(
  () => props.repoPath,        // fuente reactiva — recarga si cambia
  (path) => gitApi.listBranches(path)  // función fetcher
);

// En el JSX:
<Show when={!branches.loading} fallback={<Loader />}>
  <For each={branches()}>{(b) => <BranchItem branch={b} />}</For>
</Show>
```

Cuando `props.repoPath` cambia, el resource automáticamente vuelve a llamar a `listBranches`. No se necesita un `useEffect` manual.

---

## 7. Sistema de IPC (Frontend ↔ Rust)

### Capa API

Cada módulo Rust tiene un archivo de API correspondiente en TypeScript:

```
migration.rs  →  frontend/src/api/migration.ts
git.rs        →  frontend/src/api/git.ts
git_agent.rs  →  frontend/src/api/git-agent.ts
git_review.rs →  frontend/src/api/git-review.ts
```

Cada archivo exporta un objeto con métodos que llaman a `invoke`:

```typescript
// frontend/src/api/git.ts
import { invoke } from "@tauri-apps/api/core";
import type { GitRepoInfo } from "@/types/git";

export const gitApi = {
  repoInfo: (repoPath: string) =>
    invoke<GitRepoInfo>("git_repo_info", { repoPath }),

  listBranches: (repoPath: string, includeRemote = false) =>
    invoke<GitBranchInfo[]>("git_list_branches", { repoPath, includeRemote }),
};
```

**Convención de nombres:** El comando Rust se llama `git_repo_info` (snake_case), y el método TS se llama `repoInfo` (camelCase). Los argumentos de Rust también van en camelCase en el objeto de parámetros del `invoke`.

### Serialización automática

Rust convierte automáticamente sus structs a/desde JSON mediante Serde:

```rust
// Rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub name: String,
    pub is_head: bool,
    pub ahead: u32,
    pub behind: u32,
}
```

```typescript
// TypeScript (debe coincidir exactamente)
interface GitBranchInfo {
  name: string;
  isHead: boolean;
  ahead: number;
  behind: number;
}
```

---

## 8. Patrones Rust usados

### `Arc<Mutex<T>>` — estado compartido entre threads

```rust
pub struct GitAgentState {
    tasks: Arc<Mutex<HashMap<String, AgentTaskState>>>,
}
```

- `Arc` (Atomic Reference Counted): permite que múltiples owners tengan el mismo dato. Cuando el último `Arc` se destruye, el dato se libera. Necesario para pasar el estado al thread del agente.
- `Mutex`: garantiza que solo un thread accede al `HashMap` a la vez.

Uso típico:

```rust
// Clonar el Arc (no el dato) para pasarlo al thread
let tasks = Arc::clone(&state.tasks);
std::thread::spawn(move || {
    let mut guard = tasks.lock().unwrap();
    guard.insert(task_id, new_state);
});
```

### `Result<T, String>` — manejo de errores

Todos los comandos Tauri devuelven `Result<T, String>`. El `String` en el `Err` es el mensaje de error que recibirá el frontend como `Promise.reject(errorMessage)`.

El operador `?` propaga errores hacia arriba:

```rust
fn git_repo_info_impl(repo_path: &str) -> Result<GitRepoInfo, String> {
    let repo = Repository::discover(repo_path)
        .map_err(|e| e.to_string())?;  // Si falla, retorna Err con el mensaje

    let head = repo.head()
        .map_err(|e| format!("No HEAD: {}", e))?;  // Mensaje personalizado

    Ok(GitRepoInfo { ... })
}
```

### `RefCell<T>` — mutabilidad interior en closures

`git2::Diff::foreach` recibe múltiples closures que deben compartir estado mutable. Rust no permite múltiples `&mut` simultáneos, pero `RefCell` permite mutabilidad en tiempo de ejecución (con panic si se viola):

```rust
let files: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());

diff.foreach(
    &mut |delta, _| {
        files.borrow_mut().push(FileDiff::from_delta(delta));
        true
    },
    None,
    Some(&mut |_, hunk| {
        // También puede borrow_mut() aquí
        true
    }),
    None,
)?;

let result = files.into_inner();
```

`RefCell` es solo para uso en un único thread. Para múltiples threads se usa `Mutex`.

### `move` closures

Cuando una closure necesita capturar variables del scope exterior y vivir más que ese scope (ej.: en un thread):

```rust
let task_id = "abc123".to_string();
std::thread::spawn(move || {
    // task_id es MOVIDO al thread, no borrowed
    println!("{}", task_id);
});
// task_id ya no es accesible aquí
```

### Lifetime annotations (referencia rápida)

En este proyecto los lifetimes explícitos son raros porque se evitan diseños que los requieran, pero el error de SQLite es un buen ejemplo de cómo el borrow checker los rastrea implícitamente. Ver la sección del módulo `git_review.rs`.

---

## 9. Manejo de estado en Rust

### Estado en Tauri

Tauri usa un sistema de tipo `TypeMap` para gestionar el estado global. Se registra una instancia con `.manage()` y se recupera en comandos con `tauri::State<T>`:

```rust
// Registro (en lib.rs)
tauri::Builder::default()
    .manage(GitState::new())
    .manage(MigrationState::new())

// Acceso en comando
#[tauri::command]
pub fn git_repo_info(
    repo_path: String,
    state: tauri::State<GitState>,           // GitState
    migration: tauri::State<MigrationState>, // MigrationState (si se necesita)
) -> Result<GitRepoInfo, String> { ... }
```

Solo puede haber **un** valor registrado por tipo. Si necesitas múltiples instancias del mismo tipo, envuélvelas en un `HashMap` dentro del estado.

### `Default` trait

Muchos estados implementan `Default` para construcción sin argumentos:

```rust
#[derive(Default)]
pub struct PtyStore {
    sessions: Mutex<HashMap<String, PtySession>>,
}
```

`#[derive(Default)]` genera automáticamente `Default::default()` que inicializa `Mutex::new(HashMap::new())`. Funciona porque `Mutex` y `HashMap` también implementan `Default`.

---

## 10. Git integration con git2

### Diseño: no cachear Repository

`git2::Repository` no implementa `Send`, por lo que no puede compartirse entre threads. La solución en este proyecto es:

```rust
pub struct GitState {
    // Solo cacheamos el PATH resuelto, no el Repository
    path_cache: Arc<Mutex<HashMap<String, PathBuf>>>,
}
```

Cada comando abre su propio handle:

```rust
let repo = Repository::discover(repo_path).map_err(|e| e.to_string())?;
```

`Repository::discover()` hace lo mismo que `git rev-parse --show-toplevel`: sube por el árbol de directorios buscando `.git/`.

### Ejemplo completo: listar ramas

```rust
pub fn git_list_branches_impl(
    repo_path: &str,
    include_remote: bool,
) -> Result<Vec<GitBranchInfo>, String> {
    let repo = Repository::discover(repo_path).map_err(|e| e.to_string())?;

    let filter = if include_remote {
        Some(BranchType::Remote)
    } else {
        Some(BranchType::Local)
    };

    let mut branches = Vec::new();
    for branch_result in repo.branches(None)? {  // None = todos los tipos
        let (branch, btype) = branch_result.map_err(|e| e.to_string())?;

        if !include_remote && btype == BranchType::Remote { continue; }

        let name = branch.name()?.unwrap_or("").to_string();
        let is_head = branch.is_head();

        branches.push(GitBranchInfo { name, is_head, ... });
    }

    Ok(branches)
}
```

### Worktrees

Un worktree es un directorio de trabajo adicional ligado al mismo repositorio. Git permite tener múltiples worktrees, cada uno en una rama diferente.

```rust
// Crear un worktree
let mut opts_binding = WorktreeAddOptions::new();
let opts = opts_binding.reference(Some(&branch_ref)); // referencia a la rama

let worktree = repo.worktree(
    &branch_name,    // nombre del worktree
    &worktree_path,  // path donde se creará
    Some(opts),
)?;
```

Convención del proyecto: todos los worktrees van en `{repo_root}/.worktrees/{branch_name}`. Esta carpeta está en `.gitignore`.

### Diffs con `foreach`

```rust
let diff = repo.diff_index_to_workdir(None, None)?;

let files: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());

diff.foreach(
    &mut |delta, _progress| {
        // Llamado una vez por archivo
        files.borrow_mut().push(FileDiff::new(delta));
        true // continuar
    },
    None, // callback binario (None = omitir)
    Some(&mut |_delta, hunk| {
        // Llamado una vez por hunk
        if let Some(f) = files.borrow_mut().last_mut() {
            f.hunks.push(DiffHunk::from(hunk));
        }
        true
    }),
    Some(&mut |_delta, _hunk, line| {
        // Llamado una vez por línea
        if let Some(f) = files.borrow_mut().last_mut() {
            if let Some(h) = f.hunks.last_mut() {
                h.lines.push(DiffLine::from(line));
            }
        }
        true
    }),
)?;
```

El `RefCell` permite que las tres closures compartan el mismo `Vec<FileDiff>` mutándolo, cosa que no sería posible con `&mut Vec` normal (solo puede haber una `&mut` a la vez).

---

## 11. Motor de IA y workflows

### Proveedores LLM

El `ProviderAdapter` en `migration.rs` soporta múltiples backends de LLM configurables via variables de entorno:

| Variable | Proveedor | Modelo por defecto |
|----------|-----------|-------------------|
| `VOIDLINK_LLM_PROVIDER=openai` | OpenAI | `gpt-4o-mini` |
| `VOIDLINK_LLM_PROVIDER=groq` | Groq | `llama-3.3-70b-versatile` |
| `VOIDLINK_LLM_PROVIDER=openrouter` | OpenRouter | `openai/gpt-4.1-mini` |
| `VOIDLINK_LLM_PROVIDER=ollama` | Ollama (local) | `llama3.2` |

Todos usan la misma interfaz:

```rust
impl ProviderAdapter {
    pub fn chat_completion(&self, prompt: &str, json_mode: bool) -> Result<String, String> {
        match &self.provider {
            Provider::OpenAi => self.call_openai(prompt, json_mode),
            Provider::Groq => self.call_groq(prompt, json_mode),
            // ...
        }
    }
}
```

`json_mode: true` activa el modo de respuesta JSON estructurado (soportado por OpenAI y Groq), que garantiza que la respuesta sea JSON válido sin texto adicional.

### WorkflowDsl — Pipeline de tareas

Un workflow es una secuencia de pasos definidos en JSON:

```typescript
interface WorkflowDsl {
  id: string;
  objective: string;
  steps: WorkflowStep[];
}

interface WorkflowStep {
  id: string;
  name: string;
  description: string;
  tool: "read_file" | "write_file" | "search" | "run_command" | "llm" | "create_worktree";
  params: Record<string, unknown>;
  depends_on: string[];  // IDs de pasos previos
}
```

La ejecución respeta el grafo de dependencias (`depends_on`) para ejecutar pasos en orden correcto.

### AI Agent Pipeline (Fase 4)

El agente sigue estos pasos en orden:

```
1. LLM genera nombre de rama (slug desde el objetivo)
2. git_create_worktree() → crea directorio aislado
3. LLM genera lista de cambios a realizar (archivos + contenido)
4. Escribe los archivos en el worktree
5. git2: stage all → commit con mensaje generado por LLM
6. git2: push a origin
7. LLM genera descripción del PR
8. GitHub REST API: POST /repos/{owner}/{repo}/pulls
9. Emite evento "success" al frontend
```

Cada paso emite un evento `git-agent-event:{task_id}` para actualizar la UI en tiempo real.

---

## 12. Terminal PTY

### ¿Qué es un PTY?

Un **Pseudo-Terminal** (PTY) emula un terminal de hardware. Tiene dos extremos:
- **Master**: el lado de la app (VoidLink), lee output y escribe input.
- **Slave**: el shell (`bash`, `zsh`) se conecta aquí, cree que habla con un terminal real.

Esto permite capturar el output de comandos interactivos (como el propio `cargo tauri dev`).

### Flujo en VoidLink

```
Frontend (xterm.js)
     ↕  teclas / texto
  [IPC: write_pty]
     ↕
  Rust (lib.rs)
     ↕  escribe al master PTY
  [PTY master]
     ↕
  Shell (bash/zsh)  ← proceso hijo
     ↕  output del comando
  [PTY master]
     ↕  lee en thread de background
  Rust (lib.rs)
     ↕  emite evento
  [IPC: emit "pty-output:{id}"]
     ↕
  Frontend (xterm.js) → renderiza
```

### Implementación

```rust
// Crear sesión PTY
let pty_system = native_pty_system();
let pair = pty_system.openpty(PtySize { rows: 24, cols: 80, ... })?;

let cmd = CommandBuilder::new(shell);
let child = pair.slave.spawn_command(cmd)?;

// Thread que lee output y emite eventos
let reader = pair.master.try_clone_reader()?;
std::thread::spawn(move || {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,                    // EOF
            Ok(n) => {
                app_handle.emit("pty-output:id", &buf[..n]).ok();
            }
            Err(_) => break,
        }
    }
});
```

---

## 13. Base de datos SQLite

### Dos bases de datos

| Base de datos | Path | Uso |
|--------------|------|-----|
| `voidlink.sqlite3` | `~/.local/share/voidlink/` | Escaneo de repos, chunks, workflows |
| PR/Audit tables | Mismo archivo (accesible via `MigrationState::db_path()`) | Reviews y audit log de PRs |

### rusqlite — patrones de uso

```rust
use rusqlite::{Connection, params};

// Abrir / crear
let conn = Connection::open(db_path)?;
conn.execute_batch("PRAGMA journal_mode=WAL;")?;  // mejor concurrencia

// Crear tabla (idempotente con IF NOT EXISTS)
conn.execute_batch("
    CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        pr_number INTEGER,
        action TEXT,
        actor TEXT,
        timestamp INTEGER,
        details TEXT
    )
")?;

// Insertar
conn.execute(
    "INSERT INTO audit_log (id, pr_number, action) VALUES (?1, ?2, ?3)",
    params![id, pr_number, action],
)?;

// Consultar con query_map
let mut stmt = conn.prepare("SELECT id, action FROM audit_log WHERE pr_number = ?1")?;
let rows: Vec<(String, String)> = stmt
    .query_map(params![pr_number], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?
    .filter_map(|r| r.ok())
    .collect();
```

**Importante:** `query_map` retorna un iterador con lifetime ligado al `Statement`. Por eso siempre se hace `.collect()` antes de que el `Statement` salga del scope.

---

## 14. Sistema de pestañas (frontend)

### Tipos

```typescript
// types/tabs.ts
type Tab = NotionTab | TerminalTab | GitTab;

interface NotionTab {
  id: string;
  type: "notion";
  title: string;
  pageId: string | null;
}

interface TerminalTab {
  id: string;
  type: "terminal";
  title: string;
  sessionId: string;  // ID de la sesión PTY en Rust
  cwd: string;
}

interface GitTab {
  id: string;
  type: "git";
  title: string;
  repoPath: string;
  view: "status" | "diff" | "log" | "branches" | "worktrees" | "prs" | "review" | "agent" | "audit";
  diffBase?: string;
  diffHead?: string;
  prNumber?: number;
}
```

### Split view

El sistema soporta dos paneles lado a lado:

```typescript
interface Workspace {
  tabs: Tab[];
  activeTabId: string | null;   // panel izquierdo
  splitTabId: string | null;    // panel derecho (null = no split)
  focusedPane: "left" | "right";
}
```

La UI muestra la pestaña `activeTabId` a la izquierda y `splitTabId` a la derecha cuando ambas existen.

---

## 15. Consideraciones de diseño

### Por qué Rust en lugar de Node.js para la lógica

1. **Rendimiento real**: el escaneo de repositorios y el cómputo de embeddings son CPU-intensivos. En Node.js bloquearían el event loop; en Rust corren en threads reales.
2. **Acceso nativo**: PTY, git2, SQLite embebido — todo se beneficia del acceso de bajo nivel.
3. **Seguridad de memoria**: sin garbage collector, sin data races. El compilador verifica estos invariantes en tiempo de compilación.

### Por qué no cachear `git2::Repository`

`Repository` abre handles al filesystem. En una app de escritorio con UI reactiva, múltiples comandos pueden llegar concurrentemente. `Repository` no es `Send`, por lo que no puede compartirse entre threads. Abrir un handle por comando es suficientemente rápido (microsegundos) y evita toda la complejidad de sincronización.

### Separación de módulos git

Los tres archivos (`git.rs`, `git_agent.rs`, `git_review.rs`) están separados por responsabilidad:

- `git.rs`: operaciones sobre el repositorio local (git2 directo)
- `git_agent.rs`: orquestación (LLM + git + GitHub API)
- `git_review.rs`: persistencia y flujos de revisión (SQLite + GitHub API)

Esta separación mantiene cada archivo manejable y hace más fácil testear cada capa de forma aislada.

### `send + sync` en Tauri State

Todo lo que se pase a `.manage()` debe ser `Send + Sync` (puede enviarse entre threads y compartirse con referencias). Por eso el estado usa:

- `Arc` para compartir ownership
- `Mutex` para garantizar exclusión mutua
- Tipos que implementan `Send + Sync` nativamente (Strings, structs simples)

Si un tipo no es `Send` (como `Rc<T>` o `RefCell<T>`), no puede usarse en estado de Tauri — el compilador lo rechazará.

---

## Apéndice: Variables de entorno

```bash
# LLM
VOIDLINK_LLM_PROVIDER=openai          # openai | groq | openrouter | ollama
VOIDLINK_LLM_TIMEOUT_SECS=30
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk_...
OPENROUTER_API_KEY=sk-or-...

# GitHub (para PRs y agente)
GITHUB_TOKEN=ghp_...

# Backend opcional
DATABASE_URL=postgresql://user:pass@localhost:5432/voidlink
```
