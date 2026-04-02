# VoidLink: Guía completa del codebase para devs que vienen de TypeScript

> Escrita para alguien familiarizado con TypeScript/Node.js que quiere entender Rust a través de este proyecto real.
> Incluye referencias al código fuente, explicaciones de patrones, y links para profundizar.

---

## Índice

1. [Visión general del proyecto](#1-visión-general)
2. [Estructura de directorios](#2-estructura)
3. [Por qué Rust — comparado con TypeScript](#3-por-qué-rust)
4. [Ownership y borrowing (el concepto más importante)](#4-ownership-y-borrowing)
5. [Tipos, structs y enums](#5-tipos-structs-y-enums)
6. [Manejo de errores con Result](#6-manejo-de-errores)
7. [Concurrencia: Arc, Mutex y threads](#7-concurrencia)
8. [Traits (interfaces de Rust)](#8-traits)
9. [Closures y iteradores](#9-closures-e-iteradores)
10. [Serialización con Serde](#10-serialización-con-serde)
11. [Async vs threads en este proyecto](#11-async-vs-threads)
12. [Tauri: el puente entre Rust y el frontend](#12-tauri)
13. [Módulo por módulo: `lib.rs`](#13-librs)
14. [Módulo por módulo: `migration.rs`](#14-migrationrs)
15. [Módulo por módulo: `git.rs`](#15-gitrs)
16. [Módulo por módulo: `git_agent.rs`](#16-git_agentrs)
17. [Módulo por módulo: `git_review.rs`](#17-git_reviewrs)
18. [El frontend: SolidJS y la IPC con Tauri](#18-frontend)
19. [Flujos de datos de punta a punta](#19-flujos-de-datos)
20. [Cómo arrancar y explorar](#20-cómo-arrancar)
21. [Qué leer para profundizar](#21-qué-leer)

---

## 1. Visión general

VoidLink es una **aplicación de escritorio local-first** que combina:

- Un editor de documentos tipo Notion (bloques, páginas anidadas, slash commands)
- Un terminal integrado con múltiples sesiones PTY
- Inteligencia de repositorios: escaneo, búsqueda semántica + léxica, y generación de workflows con LLM
- Suite Git completa: operaciones básicas, worktrees, diffs, un agente autónomo de IA, y un panel de revisión de PRs

**Stack técnico:**

| Capa | Tecnología |
|---|---|
| Capa de escritorio (shell) | Tauri 2 |
| Lógica central | Rust |
| UI | SolidJS + TypeScript + Vite |
| Almacenamiento local | SQLite (via `rusqlite`) |
| Git nativo | `git2` (bindings a libgit2) |
| Backend opcional | Python FastAPI + PostgreSQL |
| LLM | Multi-provider: OpenAI, Groq, OpenRouter, Ollama |

---

## 2. Estructura

```
voidlink/
├── Makefile                    # comandos de desarrollo
├── src-tauri/                  # TODA la lógica Rust
│   ├── Cargo.toml              # dependencias Rust (equivale a package.json)
│   ├── src/
│   │   ├── main.rs             # entry point mínimo
│   │   ├── lib.rs              # setup de Tauri + registro de comandos + PTY
│   │   ├── migration.rs        # escaneo, búsqueda, workflows, LLM adapter
│   │   ├── git.rs              # fases 1–3: operaciones git, worktrees, diffs
│   │   ├── git_agent.rs        # fase 4: agente autónomo de IA
│   │   └── git_review.rs       # fase 5: panel de PRs y audit log
│   └── tauri.conf.json         # configuración de Tauri
├── frontend/                   # SolidJS + TypeScript
│   ├── src/
│   │   ├── App.tsx             # componente raíz, estado global
│   │   ├── api/                # wrappers sobre tauri `invoke`
│   │   └── components/         # componentes de UI
│   └── package.json
├── backend/                    # Python FastAPI (opcional)
└── docker-compose.yml          # Postgres + FastAPI
```

**Archivos clave que deberías leer primero:**
- `src-tauri/src/lib.rs` — entiende cómo Tauri conecta todo
- `src-tauri/src/migration.rs` — el módulo más complejo; LLM, SQLite, búsqueda
- `src-tauri/src/git.rs` — uso real de libgit2 en Rust

---

## 3. Por qué Rust (comparado con TypeScript)

### Diferencias conceptuales fundamentales

| Concepto | TypeScript | Rust |
|---|---|---|
| **Tipos** | Estructural (duck typing), borrable en runtime | Nominal, estricto, exigido en compilación |
| **Nullabilidad** | `undefined`, `null`, `?` opcional | `Option<T>`: `Some(value)` o `None` |
| **Errores** | `throw`, `try/catch`, `Promise.reject` | `Result<T, E>`: `Ok(value)` o `Err(e)` |
| **Memoria** | GC (v8 la maneja) | Ownership + borrow checker (sin GC) |
| **Concurrencia** | Event loop, async/await nativo | Threads del OS, Arc/Mutex, o async/await |
| **Compilación** | A JS o queda en TS | A binario nativo |
| **Genéricos** | `Array<T>`, `Promise<T>` | `Vec<T>`, `Result<T, E>` |
| **Herencia** | `class` con `extends` | No hay herencia; se usan traits |

### Analogías directas

```typescript
// TypeScript
const map: Map<string, number> = new Map();
map.set("key", 42);
const val: number | undefined = map.get("key");
```

```rust
// Rust
let mut map: HashMap<String, u32> = HashMap::new();
map.insert("key".to_string(), 42);
let val: Option<&u32> = map.get("key");
```

```typescript
// TypeScript - error handling
async function fetchUser(id: string): Promise<User> {
  try {
    const res = await fetch(`/api/users/${id}`);
    if (!res.ok) throw new Error("Not found");
    return res.json();
  } catch (e) {
    throw new Error(`Failed: ${e}`);
  }
}
```

```rust
// Rust - error handling
fn fetch_user(id: &str) -> Result<User, String> {
    let resp = client.get(&format!("/api/users/{}", id))
        .send()
        .map_err(|e| format!("Network error: {}", e))?;
    
    if !resp.status().is_success() {
        return Err("Not found".to_string());
    }
    
    resp.json::<User>()
        .map_err(|e| format!("Parse error: {}", e))
}
```

---

## 4. Ownership y Borrowing

**Este es EL concepto central de Rust.** Sin entenderlo, el compilador será tu enemigo. Con él, el compilador se convierte en tu mejor defensor.

### La regla de oro

Cada valor en Rust tiene exactamente **un dueño (owner)**. Cuando el owner sale de scope, el valor se destruye automáticamente (sin GC).

```rust
fn main() {
    let s = String::from("hola");  // s es el owner
    // s se destruye aquí — no hay GC, no hay leak
}
```

### Move semantics (asignación transfiere ownership)

```typescript
// TypeScript: esto funciona
const a = { name: "foo" };
const b = a;
console.log(a.name); // OK, son referencias
```

```rust
// Rust: esto NO compila
let a = String::from("foo");
let b = a;  // ownership se "mueve" a b
println!("{}", a);  // ERROR: a ya no es válido
```

**En el código:** En `git.rs`, cuando se llama a funciones como `open_repo(&repo_path)`, se pasa una **referencia** (`&`) en lugar de mover el valor:

```rust
// src-tauri/src/git.rs
fn resolve_repo_path(&self, repo_path: &str) -> Result<PathBuf, String> {
//                                         ^^^^ borrow (referencia inmutable)
```

### Borrowing: prestar sin ceder

```rust
let s = String::from("hola");
let len = calcular_longitud(&s);  // prestamos s
println!("{}", s);  // s sigue siendo válido
```

**Reglas de borrowing:**
- Podés tener **múltiples referencias inmutables** (`&T`) simultáneas
- O **exactamente una referencia mutable** (`&mut T`)
- **Nunca** ambas al mismo tiempo

### Dónde esto aparece en VoidLink

En `migration.rs`, el struct `MigrationState` se clona para pasarlo a threads. Clonar `Arc` es barato (solo incrementa un contador):

```rust
// src-tauri/src/migration.rs
#[derive(Clone)]
pub struct MigrationState {
    db: SqliteStore,
    scan_jobs: Arc<Mutex<HashMap<String, ScanProgress>>>,
    // Arc = Atomic Reference Count (puntero compartido entre threads)
}
```

> **Recursos:**
> - [El libro de Rust - Chapter 4: Ownership](https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html) — lectura obligatoria
> - [Visualizador interactivo de ownership](https://rust-book.cs.brown.edu/ch04-01-what-is-ownership.html) — versión con quizzes

---

## 5. Tipos, Structs y Enums

### Structs (equivalente a interfaces/clases de TS)

```typescript
// TypeScript
interface GitRepoInfo {
  repoPath: string;
  currentBranch: string | null;
  headOid: string | null;
  isClean: boolean;
  remoteUrl: string | null;
}
```

```rust
// Rust — en src-tauri/src/git.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub repo_path: String,
    pub current_branch: Option<String>,  // null en TS → Option<T> en Rust
    pub head_oid: Option<String>,
    pub is_clean: bool,
    pub remote_url: Option<String>,
}
```

Los `#[derive(...)]` son **macros** que generan código automáticamente:
- `Debug`: permite imprimir con `{:?}`
- `Clone`: permite clonar con `.clone()`
- `Serialize`/`Deserialize`: generan conversión a/desde JSON (via Serde)

### Enums (mucho más potentes que en TS)

En TypeScript, los enums son básicamente uniones de strings. En Rust, **cada variante puede llevar datos**:

```typescript
// TypeScript - union type
type Status = "pending" | "running" | { type: "error"; message: string };
```

```rust
// Rust - enum con datos
enum Status {
    Pending,
    Running,
    Error(String),           // variante con dato
    Progress { done: u32, total: u32 },  // variante con campos nombrados
}
```

**Pattern matching** — la forma de "desestructurar" enums:

```rust
match status {
    Status::Pending => println!("Waiting..."),
    Status::Running => println!("In progress"),
    Status::Error(msg) => println!("Error: {}", msg),
    Status::Progress { done, total } => println!("{}/{}", done, total),
}
```

**En VoidLink**, en `migration.rs`:

```rust
// src-tauri/src/migration.rs
enum ProviderKind {
    OpenAI,
    Groq,
    OpenRouter,
    Ollama,
}

// Pattern matching en inicialización:
let kind = match std::env::var("VOIDLINK_LLM_PROVIDER").as_deref() {
    Ok("openai") => ProviderKind::OpenAI,
    Ok("groq") => ProviderKind::Groq,
    Ok("openrouter") => ProviderKind::OpenRouter,
    Ok("ollama") => ProviderKind::Ollama,
    _ => ProviderKind::OpenAI,  // default (como el `default` de switch)
};
```

### Option<T> — el reemplazo de null

```rust
// Equivalente a: string | null en TypeScript
let branch: Option<String> = Some("main".to_string());
let nothing: Option<String> = None;

// Usar Option:
if let Some(name) = branch {
    println!("Branch: {}", name);
}

// O con unwrap_or (como nullish coalescing ?? en TS):
let name = branch.unwrap_or_else(|| "detached".to_string());
```

> **Recursos:**
> - [Rust book - Enums](https://doc.rust-lang.org/book/ch06-00-enums.html)
> - [Rust book - Option](https://doc.rust-lang.org/book/ch06-01-defining-an-enum.html#the-option-enum-and-its-advantages-over-null-values)

---

## 6. Manejo de Errores

### Result<T, E>

```typescript
// TypeScript: errores son invisibles en el tipo
async function parseConfig(path: string): Promise<Config> { ... }
// No hay forma de saber si puede fallar mirando el tipo
```

```rust
// Rust: el tipo dice todo
fn parse_config(path: &str) -> Result<Config, String> { ... }
// Quien llame DEBE manejar Ok o Err
```

### El operador `?` — propagación automática

```rust
// Sin ?:
fn get_branch(repo_path: &str) -> Result<String, String> {
    let repo = match open_repo(repo_path) {
        Ok(r) => r,
        Err(e) => return Err(e),
    };
    let head = match repo.head() {
        Ok(h) => h,
        Err(e) => return Err(e.to_string()),
    };
    Ok(head.shorthand().unwrap_or("").to_string())
}

// Con ? (equivalente):
fn get_branch(repo_path: &str) -> Result<String, String> {
    let repo = open_repo(repo_path)?;  // retorna Err si falla
    let head = repo.head().map_err(|e| e.to_string())?;
    Ok(head.shorthand().unwrap_or("").to_string())
}
```

**En VoidLink** — este patrón está en todos lados. Por ejemplo en `git.rs`:

```rust
// src-tauri/src/git.rs
pub fn git_repo_info_impl(repo_path: String) -> Result<GitRepoInfo, String> {
    let repo = open_repo(&repo_path)?;        // propaga error
    let head = repo.head()?;                   // propaga error
    let is_detached = repo.head_detached()
        .unwrap_or(false);                     // ignora error, usa default
    // ...
    Ok(GitRepoInfo { ... })                    // éxito
}
```

### `.map_err()` — convertir tipos de error

```rust
// git2::Error no es String, entonces convertimos:
repo.head()
    .map_err(|e| e.message().to_string())?
//   ^^^^^^^^^ convierte el error al tipo que necesitamos
```

> **Recursos:**
> - [Rust book - Error handling](https://doc.rust-lang.org/book/ch09-00-error-handling.html)
> - [Artículo: Error handling in Rust](https://doc.rust-lang.org/rust-by-example/error.html)

---

## 7. Concurrencia

### El problema que resuelve Arc<Mutex<>>

Tauri maneja múltiples comandos concurrentemente (cada llamada desde el frontend puede ejecutarse en su propio thread). Entonces necesitamos compartir estado de forma segura.

```typescript
// TypeScript: esto funciona porque hay un solo event loop
const sessions = new Map<string, PtySession>();
sessions.set("123", session);  // no hay race condition
```

```rust
// Rust: múltiples threads necesitan acceder al mismo HashMap
// HashMap solo no es thread-safe → necesitamos Arc<Mutex<>>
type PtyStore = Arc<Mutex<HashMap<String, PtySession>>>;
```

### Arc (Atomic Reference Counting)

`Arc<T>` es como `Rc<T>` (reference counted pointer) pero **thread-safe**. Permite tener **múltiples dueños** a través de threads.

```rust
let store: Arc<Mutex<HashMap<...>>> = Arc::new(Mutex::new(HashMap::new()));

// Clonar Arc es barato — solo incrementa el contador
let store_clone = Arc::clone(&store);

std::thread::spawn(move || {
    // store_clone es movido al thread
    // el HashMap original sigue vivo porque Arc lo mantiene
    let mut map = store_clone.lock().unwrap();
    map.insert("key".to_string(), value);
});
```

### Mutex

`Mutex<T>` garantiza acceso exclusivo. Hay que "lockear" para acceder:

```rust
let guard = map.lock().unwrap();  // bloquea hasta que nadie más tenga el lock
// guard es como un smart pointer al HashMap
guard.get("key");
// Al salir de scope, guard se destruye → el lock se libera automáticamente
```

**En `lib.rs`** — la store de sesiones PTY:

```rust
// src-tauri/src/lib.rs
struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn std::io::Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

type PtyStore = Arc<Mutex<HashMap<String, PtySession>>>;
```

**Inicialización y registro en Tauri:**

```rust
let pty_store: PtyStore = Arc::new(Mutex::new(HashMap::new()));

tauri::Builder::default()
    .manage(pty_store)  // Tauri lo inyecta en los comandos
    // ...
```

**Uso en un comando:**

```rust
#[tauri::command]
fn create_pty(
    store: tauri::State<PtyStore>,  // Tauri inyecta el Arc automáticamente
    // ...
) -> Result<String, String> {
    let mut map = store.lock().map_err(|e| e.to_string())?;
    map.insert(session_id.clone(), session);
    Ok(session_id)
}
```

### Threads del OS

VoidLink usa `std::thread::spawn` para tareas pesadas (escaneo de repos, agente de IA):

```rust
// src-tauri/src/lib.rs — reader thread para PTY
std::thread::spawn(move || {
    let mut buf = [0u8; 4096];
    loop {
        match std::io::Read::read(&mut reader, &mut buf) {
            Ok(0) | Err(_) => {
                let _ = reader_app_handle.emit("pty-exit:...", ());
                break;
            }
            Ok(n) => {
                let chunk = buf[..n].to_vec();
                let _ = reader_app_handle.emit("pty-output:...", chunk);
            }
        }
    }
});
```

> **Nota:** A diferencia de Node.js que tiene un event loop, acá lanzamos threads del OS reales que corren en paralelo.

> **Recursos:**
> - [Rust book - Concurrency](https://doc.rust-lang.org/book/ch16-00-concurrency.html)
> - [Rust book - Arc y Mutex](https://doc.rust-lang.org/book/ch16-03-shared-state.html)

---

## 8. Traits

Los traits son el equivalente Rust de las interfaces TypeScript, pero más potentes.

```typescript
// TypeScript
interface Serializable {
  toJSON(): string;
}

class User implements Serializable {
  toJSON(): string { return JSON.stringify(this); }
}
```

```rust
// Rust
trait Serializable {
    fn to_json(&self) -> String;
}

struct User { name: String }

impl Serializable for User {
    fn to_json(&self) -> String {
        format!("{{\"name\": \"{}\"}}", self.name)
    }
}
```

### `dyn Trait` — polimorfismo en runtime

En TypeScript, una interfaz acepta cualquier objeto que la implemente. En Rust necesitás ser explícito:

```typescript
// TypeScript
function process(writer: Writable) { writer.write("data"); }
```

```rust
// Rust — Box<dyn Trait> para polimorfismo dinámico
fn process(writer: &mut Box<dyn std::io::Write>) {
    writer.write_all(b"data").unwrap();
}
```

**En `lib.rs`** — las sesiones PTY usan trait objects porque la implementación varía por OS:

```rust
struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    //      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //      "cualquier tipo que implemente MasterPty y sea Send (thread-safe)"
    writer: Box<dyn std::io::Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}
```

### Traits derivados (derive macros)

Muchos traits se pueden **auto-implementar** con derive:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Config {
    model: String,
    temperature: f32,
}
```

- `Debug` → permite `println!("{:?}", config)`
- `Clone` → permite `config.clone()`
- `Serialize`/`Deserialize` → JSON, TOML, etc. via Serde
- `PartialEq` → permite `config1 == config2`

> **Recursos:**
> - [Rust book - Traits](https://doc.rust-lang.org/book/ch10-02-traits.html)
> - [Rust by Example - Traits](https://doc.rust-lang.org/rust-by-example/trait.html)

---

## 9. Closures e Iteradores

### Closures (similares a arrow functions de TS)

```typescript
// TypeScript
const double = (x: number) => x * 2;
const result = [1, 2, 3].map(double);
```

```rust
// Rust
let double = |x: i32| x * 2;
let result: Vec<i32> = vec![1, 2, 3].iter().map(|x| x * 2).collect();
```

**Captura de variables:**

```typescript
// TypeScript — closures capturan por referencia
const prefix = "hello";
const greet = (name: string) => `${prefix} ${name}`;
```

```rust
// Rust — hay que ser explícito sobre cómo captura
let prefix = "hello".to_string();

// Captura por referencia (borrow):
let greet = |name: &str| format!("{} {}", prefix, name);

// Captura por move (para enviar a un thread):
let greet = move |name: &str| format!("{} {}", prefix, name);
// Ahora prefix es del closure — prefix ya no es accesible afuera
```

### Iteradores — la forma funcional

```rust
// Equivale a filter().map() en TS
let flagged_items: Vec<_> = items
    .iter()
    .filter(|item| item.status == "flagged")
    .map(|item| item.id.clone())
    .collect();  // collect() "materializa" el iterador en un Vec
```

**En `git_review.rs`:**

```rust
// Verificar si hay items flaggeados antes de mergear
let flagged: Vec<_> = items.iter()
    .filter(|i| i.status == "flagged")
    .collect();

if !flagged.is_empty() {
    return Err(format!("Cannot merge: {} flagged items", flagged.len()));
}
```

### `RefCell` — interior mutability en closures

Este patrón aparece en `git.rs` para el diff viewer. El problema: las closures pasadas a `git2::Diff::foreach` necesitan mutar una lista, pero no podés tener `&mut` en múltiples closures.

```rust
// Problema: varios closures necesitan mutar `files`
// Solución: RefCell permite "borrow checking en runtime"

use std::cell::RefCell;

let files: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());

diff.foreach(
    &mut |delta, _progress| {
        files.borrow_mut().push(FileDiff { ... });  // borrow mutable en runtime
        true
    },
    None,
    Some(&mut |_delta, hunk| {
        if let Some(file) = files.borrow_mut().last_mut() {
            file.hunks.push(DiffHunk { ... });
        }
        true
    }),
    Some(&mut |_delta, _hunk, line| {
        if let Some(file) = files.borrow_mut().last_mut() {
            if let Some(hunk) = file.hunks.last_mut() {
                hunk.lines.push(DiffLine { ... });
            }
        }
        true
    }),
)?;

let files = files.into_inner();  // "consume" el RefCell, devuelve el Vec
```

> **Recursos:**
> - [Rust book - Iterators](https://doc.rust-lang.org/book/ch13-02-iterators.html)
> - [Rust book - Closures](https://doc.rust-lang.org/book/ch13-01-closures.html)
> - [Rust book - RefCell](https://doc.rust-lang.org/book/ch15-05-interior-mutability.html)

---

## 10. Serialización con Serde

Serde es la librería estándar para serialización en Rust. Equivale a `JSON.stringify` / `JSON.parse` pero con tipos.

```rust
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]  // snake_case → camelCase en JSON
pub struct WorkflowStep {
    pub step_id: String,          // → "stepId" en JSON
    pub intent: String,
    pub tools: Vec<String>,
    pub retry_policy: RetryPolicy,
}
```

**Renombrado individual:**

```rust
#[derive(Serialize, Deserialize)]
pub struct GitRepoInfo {
    pub repo_path: String,       // → "repoPath"
    #[serde(rename = "headOid")] // override específico
    pub head_oid: Option<String>,
}
```

**Deserializar desde JSON:**

```rust
// En migration.rs — parsear respuesta del LLM
let workflow: WorkflowDsl = serde_json::from_str(&raw_json)
    .map_err(|e| format!("Failed to parse workflow: {}", e))?;
```

**Serializar a JSON:**

```rust
let json_string = serde_json::to_string(&workflow)
    .map_err(|e| e.to_string())?;
```

**Valores JSON dinámicos** (como `any` en TypeScript):

```rust
use serde_json::Value;

// Cuando no conocés la estructura de antemano
let body: Value = serde_json::json!({
    "merge_method": "squash",
    "commit_title": "feat: add feature"
});

// Acceder campos
let method = body["merge_method"].as_str().unwrap_or("merge");
```

> **Recursos:**
> - [Serde docs](https://serde.rs/)
> - [serde_json docs](https://docs.rs/serde_json)

---

## 11. Async vs Threads en este proyecto

**Dato importante:** VoidLink usa **threads del OS** en lugar de async/await para la mayoría de las operaciones pesadas. Esto es una decisión deliberada para simplificar el código.

### Cuándo usar cada uno

| Situación | Approach en VoidLink |
|---|---|
| Operación de red (HTTP) | `reqwest::blocking` (thread bloqueante) |
| Escaneo de archivos | `std::thread::spawn` |
| Agente de IA | `std::thread::spawn` |
| Lectura de PTY | `std::thread::spawn` con loop infinito |
| Comandos de Tauri | Síncronos (Tauri los maneja en thread pool) |

### `reqwest::blocking` — HTTP sin async

```rust
// En migration.rs — llamada a OpenAI API
use reqwest::blocking::Client;

let client = Client::builder()
    .timeout(Duration::from_secs(60))
    .build()
    .map_err(|e| e.to_string())?;

let resp = client
    .post("https://api.openai.com/v1/chat/completions")
    .header("Authorization", format!("Bearer {}", api_key))
    .json(&request_body)
    .send()
    .map_err(|e| format!("Request failed: {}", e))?;
```

**Diferencia con async:**

```rust
// Async (con tokio) — así se haría en producción:
async fn call_openai(prompt: &str) -> Result<String, String> {
    let resp = client.post(url)
        .json(&body)
        .send()
        .await  // ← diferencia clave
        .map_err(|e| e.to_string())?;
    Ok(resp.text().await?)
}

// Blocking — lo que usa VoidLink:
fn call_openai(prompt: &str) -> Result<String, String> {
    let resp = client.post(url)
        .json(&body)
        .send()  // bloquea el thread actual hasta que responda
        .map_err(|e| e.to_string())?;
    Ok(resp.text()?)
}
```

> **Por qué blocking aquí?** Los comandos de Tauri ya corren en threads del pool. Usar blocking HTTP simplifica el código enormemente — no necesitás `#[tokio::main]`, runtime setup, ni `async fn` en cascada.

> **Recursos:**
> - [Rust book - Async](https://doc.rust-lang.org/book/ch17-00-async-await.html)
> - [tokio tutorial](https://tokio.rs/tokio/tutorial)
> - [reqwest docs](https://docs.rs/reqwest)

---

## 12. Tauri — El puente Rust ↔ Frontend

Tauri es el framework que conecta el binario Rust con la UI web (SolidJS). Funciona como Electron pero mucho más liviano.

### Comandos Tauri

Los comandos son funciones Rust que el frontend puede invocar. Se marcan con `#[tauri::command]`:

```rust
// En src-tauri/src/lib.rs o migration.rs
#[tauri::command]
fn scan_repository(
    repo_path: String,
    state: tauri::State<MigrationState>,  // inyectado por Tauri
) -> Result<String, String> {
    state.scan_repository_impl(repo_path)
}
```

**Registro en el builder** (en `lib.rs`):

```rust
tauri::Builder::default()
    .manage(migration_state)
    .invoke_handler(tauri::generate_handler![
        scan_repository,
        get_scan_status,
        search_repository,
        git_repo_info,
        git_create_worktree,
        // ... todos los comandos
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

**Invocación desde el frontend:**

```typescript
// frontend/src/api/migration.ts
import { invoke } from "@tauri-apps/api/core";

export const scanRepository = (repoPath: string): Promise<string> =>
    invoke("scan_repository", { repoPath });
//                                ^^^^^^^^ debe coincidir con el nombre del param en Rust
```

### Eventos Tauri (para comunicación backend → frontend)

Para resultados en tiempo real (progreso, logs), se usan eventos:

```rust
// Rust emite evento
app_handle.emit("pty-output:session123", chunk_bytes)?;
app_handle.emit("git-agent-event:task456", agent_event)?;
```

```typescript
// TypeScript escucha
import { listen } from "@tauri-apps/api/event";

const unlisten = await listen<Uint8Array>("pty-output:session123", (event) => {
    terminal.write(event.payload);
});

// Cleanup cuando el componente se desmonta
onCleanup(() => unlisten());
```

### AppHandle — el handle global

`AppHandle` es el struct que permite emitir eventos, acceder al estado global, y más. En `git_agent.rs` se clona para pasarlo al thread:

```rust
// src-tauri/src/git_agent.rs
#[tauri::command]
pub fn git_agent_start(
    input: AgentTaskInput,
    state: tauri::State<GitAgentState>,
    app_handle: tauri::AppHandle,  // handle al runtime de Tauri
) -> Result<String, String> {
    let task_id = Uuid::new_v4().to_string();
    
    let app_handle_clone = app_handle.clone();  // clonable, barato
    let task_id_clone = task_id.clone();
    
    std::thread::spawn(move || {
        run_agent_pipeline(task_id_clone, input, state, app_handle_clone);
    });
    
    Ok(task_id)  // retorna inmediatamente
}
```

### Ventana sin decoraciones (custom titlebar)

La ventana está configurada sin chrome del OS:

```json
// src-tauri/tauri.conf.json
{
  "windows": [{
    "decorations": false,
    "transparent": true,
    "backgroundColor": "#00000000",
    "titleBarStyle": "Overlay"
  }]
}
```

La UI en SolidJS implementa su propio titlebar draggable.

> **Recursos:**
> - [Tauri v2 docs](https://v2.tauri.app/start/)
> - [Tauri - Calling Rust from frontend](https://v2.tauri.app/develop/calling-rust/)
> - [Tauri - Events](https://v2.tauri.app/develop/inter-process/events/)

---

## 13. `lib.rs` — Setup central

**Ubicación:** `src-tauri/src/lib.rs` (323 líneas)

Este archivo es el corazón del setup de Tauri. Hace tres cosas:
1. Define y gestiona las sesiones PTY
2. Registra todos los comandos Tauri
3. Inicializa el estado global

### Flujo de PTY completo

```
Frontend                          Rust
─────────                         ────
invoke("create_pty", { cwd }) ──→ create_pty()
                                  │ Crea par PTY (master/slave)
                                  │ Lanza shell (bash/zsh/sh)
                                  │ Lanza reader thread:
                                  │   loop { read(master) → emit("pty-output:id") }
                              ←── Ok(session_id)

listen("pty-output:id") ←──────── app_handle.emit("pty-output:id", bytes)
terminal.write(bytes)

onKeyPress(data) ──────────────→  invoke("write_pty", { sessionId, data })
                                  │ store.lock()?.get(id)?.writer.write(data)
                              ←── Ok(())

onResize(cols, rows) ──────────→  invoke("resize_pty", { sessionId, cols, rows })
                                  │ master.resize(PtySize { rows, cols })
                              ←── Ok(())
```

**Código de create_pty** (simplificado):

```rust
#[tauri::command]
fn create_pty(
    cwd: Option<String>,
    store: tauri::State<PtyStore>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    
    // Crear el par PTY (master controla, slave es el terminal)
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize { rows: 24, cols: 80, .. })?;
    
    // Configurar y lanzar shell
    let shell = std::env::var("SHELL").unwrap_or("/bin/sh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    if let Some(dir) = cwd { cmd.cwd(dir); }
    
    let child = pair.slave.spawn_command(cmd)?;
    let writer = pair.master.take_writer()?;
    
    // Reader thread: relay PTY output → frontend events
    let reader_id = session_id.clone();
    let reader_handle = app_handle.clone();
    let mut reader = pair.master.try_clone_reader()?;
    
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = reader_handle.emit(&format!("pty-exit:{}", reader_id), ());
                    break;
                }
                Ok(n) => {
                    let chunk = buf[..n].to_vec();
                    let _ = reader_handle.emit(&format!("pty-output:{}", reader_id), chunk);
                }
            }
        }
    });
    
    // Guardar sesión
    let mut map = store.lock().map_err(|e| e.to_string())?;
    map.insert(session_id.clone(), PtySession {
        master: pair.master,
        writer,
        child,
    });
    
    Ok(session_id)
}
```

---

## 14. `migration.rs` — El módulo más complejo

**Ubicación:** `src-tauri/src/migration.rs` (2711 líneas)

Este módulo implementa todo el sistema de inteligencia de repositorios.

### MigrationState — el struct central

```rust
#[derive(Clone)]
pub struct MigrationState {
    db: SqliteStore,                                    // conexión SQLite
    scan_jobs: Arc<Mutex<HashMap<String, ScanProgress>>>,  // jobs en memoria
    run_cache: Arc<Mutex<HashMap<String, RunState>>>,   // runs en memoria
    provider: Arc<ProviderAdapter>,                     // LLM adapter
    startup_repo_path: Option<String>,                  // hint del path
}
```

### SQLite — la base de datos local

La DB se abre en el directorio de datos del usuario (`~/.local/share/voidlink/voidlink.db` en Linux):

```rust
fn default_db_path() -> Result<PathBuf, String> {
    let home = dirs::data_dir()
        .ok_or("Cannot find data dir")?;
    let dir = home.join("voidlink");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("voidlink.db"))
}
```

**Schema** (ejecutado en startup):

```sql
-- Repositorios registrados
CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Archivos dentro de cada repo
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    path TEXT NOT NULL,
    language TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    content_hash TEXT NOT NULL,   -- Blake3 hash para detectar cambios
    indexed_at INTEGER NOT NULL,
    UNIQUE(repo_id, path)
);

-- Chunks de texto de cada archivo (para búsqueda)
CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    token_estimate INTEGER NOT NULL
);

-- Embeddings vectoriales de cada chunk
CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL,  -- "chunk"
    owner_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    vector BLOB NOT NULL        -- Vec<f32> serializado
);

-- Grafo de dependencias entre archivos
CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    from_file TEXT NOT NULL,
    to_file TEXT NOT NULL,
    edge_type TEXT NOT NULL   -- "import", "reference"
);
```

### Escaneo de repositorio

```rust
pub fn scan_repository_impl(&self, repo_path: String) -> Result<String, String> {
    let job_id = Uuid::new_v4().to_string();
    
    // Registrar job (para que el frontend pueda hacer polling)
    self.scan_jobs.lock()?.insert(job_id.clone(), ScanProgress {
        status: "pending".to_string(),
        files_scanned: 0,
        ..
    });
    
    let state_clone = self.clone();  // barato — Arc comparte el estado
    let job_id_clone = job_id.clone();
    
    // Lanzar en background thread
    std::thread::spawn(move || {
        match state_clone.do_scan(&repo_path, &job_id_clone) {
            Ok(_) => {
                state_clone.update_scan_status(&job_id_clone, "success", ..);
            }
            Err(e) => {
                state_clone.update_scan_status(&job_id_clone, "failed", ..);
            }
        }
    });
    
    Ok(job_id)  // retorna inmediatamente
}
```

**do_scan** — la lógica real:

```rust
fn do_scan(&self, repo_path: &str, job_id: &str) -> Result<(), String> {
    // 1. Obtener/crear repo en DB
    let repo_id = self.db.upsert_repo(repo_path)?;
    
    // 2. Cargar metadata existente para detectar cambios
    let existing = self.db.load_file_metadata(repo_id)?;
    
    // 3. Walk filesystem respetando .gitignore
    let walker = WalkBuilder::new(repo_path)
        .git_ignore(true)
        .git_global(true)
        .build();
    
    let mut files_scanned = 0;
    
    for entry in walker {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map(|f| f.is_file()).unwrap_or(false) { continue; }
        
        let path = entry.path();
        let relative = path.strip_prefix(repo_path)?.to_string_lossy().to_string();
        
        // Saltar directorios ignorados
        if is_ignored_path(&relative) { continue; }
        
        // Leer metadata del archivo
        let meta = std::fs::metadata(path)?;
        let mtime_ms = meta.modified()?.duration_since(UNIX_EPOCH)?.as_millis() as i64;
        
        // Leer contenido y hacer hash
        let bytes = std::fs::read(path)?;
        let content_hash = blake3::hash(&bytes).to_hex().to_string();
        
        // Skip si no cambió
        if let Some(existing_meta) = existing.get(&relative) {
            if existing_meta.mtime_ms == mtime_ms && existing_meta.content_hash == content_hash {
                continue;
            }
        }
        
        // Detectar lenguaje por extensión
        let language = detect_language(&relative);
        
        // Parsear en texto
        let content = String::from_utf8_lossy(&bytes).to_string();
        
        // Chunking — dividir en partes de ~120 tokens con overlap
        let chunks = chunk_text(&content, 120, 20);
        
        // Guardar en SQLite
        self.db.upsert_file_and_chunks(
            &repo_id, &relative, &language, bytes.len() as i64,
            mtime_ms, &content_hash, &chunks
        )?;
        
        files_scanned += 1;
        
        // Actualizar progreso cada 25 archivos
        if files_scanned % 25 == 0 {
            self.update_scan_status(job_id, "running", files_scanned);
        }
    }
    
    // Generar embeddings en background
    self.schedule_embedding_job(&repo_id)?;
    
    Ok(())
}
```

### Búsqueda híbrida

La búsqueda combina tres dimensiones:

```rust
pub fn search_repository_impl(&self, query: SearchQuery) -> Result<Vec<SearchResult>, String> {
    // 1. Embedding de la query
    let (_, query_embedding) = self.provider.embed(&query.text);
    
    // 2. Tokenizar para búsqueda léxica
    let query_tokens: Vec<String> = tokenize(&query.text);
    
    // 3. Cargar todos los chunks del repo
    let chunks = self.db.load_chunks_for_repo(&repo_id)?;
    
    // 4. Cargar embeddings en memoria
    let embeddings = self.db.load_embeddings(&repo_id)?;
    
    let mut candidates: Vec<ScoredChunk> = chunks.iter()
        .filter_map(|chunk| {
            // Score léxico: cuántos tokens de la query aparecen en el chunk
            let lexical_hits = query_tokens.iter()
                .filter(|t| chunk.content.to_lowercase().contains(t.as_str()))
                .count() as f32;
            let lexical_score = (lexical_hits / (query_tokens.len() as f32 * 4.0)).min(1.0);
            
            // Score semántico: similitud coseno con el embedding
            let semantic_score = embeddings.get(&chunk.id)
                .map(|vec| cosine_similarity(&query_embedding, vec))
                .unwrap_or(0.0);
            
            // Filtrar irrelevantes
            if lexical_score <= 0.0 && semantic_score < 0.08 { return None; }
            
            let combined = lexical_score * 0.65 + semantic_score * 0.35;
            
            Some(ScoredChunk { chunk, lexical_score, semantic_score, combined_score: combined })
        })
        .collect();
    
    // 5. Boost por proximidad en el grafo de dependencias
    let proximity_boosts = compute_graph_proximity(&candidates, &self.db, &repo_id)?;
    
    for candidate in &mut candidates {
        let boost = proximity_boosts.get(&candidate.chunk.file_id).unwrap_or(&0.0);
        candidate.combined_score = (candidate.combined_score + boost * 0.15).min(1.0);
    }
    
    // 6. Ordenar y truncar
    candidates.sort_by(|a, b| b.combined_score.partial_cmp(&a.combined_score).unwrap());
    candidates.truncate(query.limit.unwrap_or(25));
    
    // 7. Formatear resultados
    Ok(candidates.into_iter().map(|c| SearchResult {
        id: c.chunk.id,
        file_path: c.chunk.file_path,
        start_line: c.chunk.start_line,
        snippet: c.chunk.content,
        score: c.combined_score,
        lexical_score: c.lexical_score,
        semantic_score: c.semantic_score,
    }).collect())
}

// Similitud coseno — producto punto / (norma_a * norma_b)
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 { 0.0 } else { dot / (norm_a * norm_b) }
}
```

### LLM Adapter

```rust
pub struct ProviderAdapter {
    kind: ProviderKind,
    model: String,
    api_key: Option<String>,
    base_url: String,
    client: Client,
}

impl ProviderAdapter {
    pub fn chat_completion(&self, prompt: &str, json_mode: bool) -> Result<String, String> {
        let mut body = serde_json::json!({
            "model": self.model,
            "messages": [{ "role": "user", "content": prompt }],
            "max_tokens": 4096,
        });
        
        // Algunos providers soportan response_format para JSON garantizado
        if json_mode {
            body["response_format"] = serde_json::json!({ "type": "json_object" });
        }
        
        let resp = self.client
            .post(&format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key.as_deref().unwrap_or("")))
            .json(&body)
            .send()
            .map_err(|e| format!("HTTP error: {}", e))?;
        
        if !resp.status().is_success() {
            // Si json_mode falló, reintentar sin él
            if json_mode {
                return self.chat_completion(prompt, false);
            }
            return Err(format!("API error: {}", resp.text()?));
        }
        
        let response: Value = resp.json()?;
        let content = response["choices"][0]["message"]["content"]
            .as_str()
            .ok_or("No content in response")?
            .to_string();
        
        Ok(content)
    }
    
    // Fallback determinístico si no hay LLM disponible
    fn deterministic_embedding(text: &str, dims: usize) -> Vec<f32> {
        // Usa hash del texto para generar vector pseudo-aleatorio pero reproducible
        let hash = blake3::hash(text.as_bytes());
        let seed = u64::from_le_bytes(hash.as_bytes()[..8].try_into().unwrap());
        // ... genera vector con seed
    }
}
```

---

## 15. `git.rs` — Operaciones Git con libgit2

**Ubicación:** `src-tauri/src/git.rs` (1147 líneas)

Este módulo es un wrapper sobre `git2`, los bindings Rust para libgit2 (la librería C que usa GitHub Desktop, etc.).

### Estructura de estado

```rust
#[derive(Clone)]
pub struct GitState {
    path_cache: Arc<Mutex<HashMap<String, PathBuf>>>,
}
```

El cache evita que `Repository::discover()` recorra el filesystem en cada llamada.

### Operaciones básicas

**Información del repo:**

```rust
pub fn git_repo_info_impl(repo_path: String) -> Result<GitRepoInfo, String> {
    let repo = Repository::open(&repo_path)
        .or_else(|_| Repository::discover(&repo_path))
        .map_err(|e| e.message().to_string())?;
    
    let head = repo.head().map_err(|e| e.message().to_string())?;
    
    let current_branch = if head.is_branch() {
        head.shorthand().map(|s| s.to_string())
    } else {
        None
    };
    
    let mut status_opts = StatusOptions::new();
    status_opts.include_untracked(true);
    let statuses = repo.statuses(Some(&mut status_opts))
        .map_err(|e| e.message().to_string())?;
    let is_clean = statuses.is_empty();
    
    Ok(GitRepoInfo {
        repo_path,
        current_branch,
        head_oid: head.target().map(|o| o.to_string()),
        is_clean,
        is_detached: repo.head_detached().unwrap_or(false),
        remote_url: repo.find_remote("origin").ok()
            .and_then(|r| r.url().map(|u| u.to_string())),
    })
}
```

**Stage y commit:**

```rust
pub fn git_stage_all_impl(repo_path: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)?;
    index.write()?;
    Ok(())
}

pub fn git_commit_impl(repo_path: String, message: String) -> Result<String, String> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo.index()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    
    let sig = repo.signature()?;  // lee user.name y user.email de git config
    
    let parent_commit = match repo.head() {
        Ok(head) => Some(head.peel_to_commit()?),
        Err(_) => None,  // primer commit — no hay parent
    };
    
    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();
    
    let oid = repo.commit(
        Some("HEAD"),
        &sig,        // author
        &sig,        // committer
        &message,
        &tree,
        &parents,
    )?;
    
    Ok(oid.to_string())  // SHA del nuevo commit
}
```

**Push con autenticación:**

```rust
pub fn git_push_impl(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let remote_name = remote.as_deref().unwrap_or("origin");
    let mut remote_obj = repo.find_remote(remote_name)?;
    
    let branch_name = branch.unwrap_or_else(|| {
        repo.head().ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()))
            .unwrap_or("main".to_string())
    });
    
    let refspec = format!("refs/heads/{}:refs/heads/{}", branch_name, branch_name);
    
    // Callbacks de autenticación — intenta SSH primero, luego token
    let mut tried_ssh = false;
    let mut tried_token = false;
    let mut callbacks = RemoteCallbacks::new();
    
    callbacks.credentials(move |_url, username_from_url, allowed_types| {
        if allowed_types.contains(CredentialType::SSH_KEY) && !tried_ssh {
            tried_ssh = true;
            // Intenta usar el SSH agent del sistema
            return Cred::ssh_key_from_agent(username_from_url.unwrap_or("git"));
        }
        if allowed_types.contains(CredentialType::USER_PASS_PLAINTEXT) && !tried_token {
            tried_token = true;
            if let Ok(token) = std::env::var("GITHUB_TOKEN") {
                return Cred::userpass_plaintext("x-access-token", &token);
            }
        }
        Err(git2::Error::from_str("Auth failed: set GITHUB_TOKEN or configure SSH agent"))
    });
    
    let mut push_opts = PushOptions::new();
    push_opts.remote_callbacks(callbacks);
    
    remote_obj.push(&[&refspec], Some(&mut push_opts))?;
    Ok(())
}
```

### Worktrees

Los worktrees permiten tener múltiples branches activos simultáneamente:

```rust
pub fn git_create_worktree_impl(input: CreateWorktreeInput) -> Result<WorktreeInfo, String> {
    let repo = open_repo(&input.repo_path)?;
    let workdir = repo.workdir()
        .ok_or("Bare repos not supported")?;
    
    // Crear o encontrar el branch
    let base_commit = if let Some(ref base_ref) = input.base_ref {
        repo.revparse_single(base_ref)?.peel_to_commit()?
    } else {
        repo.head()?.peel_to_commit()?
    };
    
    let _branch = repo.branch(&input.branch_name, &base_commit, false)
        .or_else(|_| repo.find_branch(&input.branch_name, BranchType::Local))?;
    
    // Crear worktree en .worktrees/{branch_name}
    let worktree_path = workdir.join(".worktrees").join(&input.branch_name);
    std::fs::create_dir_all(worktree_path.parent().unwrap())?;
    
    let branch_ref = repo.find_reference(&format!("refs/heads/{}", input.branch_name))?;
    let mut wt_opts = WorktreeAddOptions::new();
    repo.worktree(
        &input.branch_name,
        &worktree_path,
        Some(wt_opts.reference(Some(&branch_ref)))
    )?;
    
    Ok(WorktreeInfo {
        name: input.branch_name,
        path: worktree_path.to_string_lossy().to_string(),
        branch: input.branch_name.clone(),
    })
}
```

---

## 16. `git_agent.rs` — Agente autónomo de IA

**Ubicación:** `src-tauri/src/git_agent.rs` (710 líneas)

El agente implementa un pipeline de 6 pasos que automatiza: branching → worktree → cambios de código → commit → push → PR.

### El estado del agente

```rust
#[derive(Clone, Serialize, Deserialize)]
pub struct AgentTaskState {
    pub task_id: String,
    pub status: String,      // "pending" | "running" | "success" | "failed" | "cancelled"
    pub phase: String,       // "branching" | "implementing" | "pushing" | etc.
    pub events: Vec<AgentEvent>,
    pub branch_name: Option<String>,
    pub worktree_path: Option<String>,
    pub commit_sha: Option<String>,
    pub pr_url: Option<String>,
    pub error: Option<String>,
}

pub type GitAgentState = Arc<Mutex<HashMap<String, AgentTaskState>>>;
```

### El macro emit_event

Macro para emitir eventos al frontend Y guardarlos en el estado:

```rust
macro_rules! emit_event {
    ($level:expr, $msg:expr, $app:expr, $tasks:expr, $task_id:expr) => {{
        let ev = AgentEvent {
            level: $level.to_string(),
            message: $msg.to_string(),
            timestamp: now_ms(),
        };
        // Emitir al frontend
        let _ = $app.emit(&format!("git-agent-event:{}", $task_id), &ev);
        // Guardar en estado en memoria
        if let Ok(mut tasks) = $tasks.lock() {
            if let Some(task) = tasks.get_mut($task_id) {
                task.events.push(ev);
            }
        }
    }};
}
```

### Pipeline paso a paso

```rust
fn run_agent_pipeline(
    task_id: String,
    input: AgentTaskInput,
    tasks: GitAgentState,
    migration_state: MigrationState,
    app_handle: AppHandle,
) {
    // PASO 1: Generar nombre de branch
    let branch_prompt = format!(
        "Generate a git branch name (kebab-case, max 50 chars) for: {}\n\
         Return ONLY the branch name, nothing else.",
        input.objective
    );
    
    let branch_base = match migration_state.llm_chat(&branch_prompt, false) {
        Ok(name) => name.trim().to_string(),
        Err(_) => "ai-task".to_string(),
    };
    
    // Agregar UUID corto para unicidad
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    let branch_name = format!("{}-{}", branch_base.replace(' ', "-"), short_uuid);
    
    emit_event!("info", &format!("Creating branch: {}", branch_name), ...);
    update_task_phase(&tasks, &task_id, "branching", |t| {
        t.branch_name = Some(branch_name.clone());
    });
    
    // PASO 2: Crear worktree
    let worktree = match git_create_worktree_impl(CreateWorktreeInput {
        repo_path: input.repo_path.clone(),
        branch_name: branch_name.clone(),
        base_ref: input.base_branch.clone(),
    }) {
        Ok(wt) => wt,
        Err(e) => {
            fail_task(&tasks, &task_id, &format!("Worktree failed: {}", e));
            return;
        }
    };
    
    emit_event!("info", "Worktree created", ...);
    update_task_field(&tasks, &task_id, |t| {
        t.worktree_path = Some(worktree.path.clone());
    });
    
    // PASO 3: Implementar cambios via LLM
    // Lista los archivos del repo para dar contexto
    let file_listing = list_repo_files(&input.repo_path, 200);
    
    let impl_prompt = format!(
        "You are an expert developer. Implement the following objective by modifying files.\n\
         \nObjective: {}\n\
         \nRepository files (sample):\n{}\n\
         \nReturn a JSON array of file changes:\n\
         [{{\n\
           \"file_path\": \"src/foo.rs\",\n\
           \"action\": \"create\" | \"modify\" | \"delete\",\n\
           \"content\": \"full file content here\"\n\
         }}]\n\
         Return ONLY the JSON array.",
        input.objective,
        file_listing
    );
    
    let changes: Vec<FileChange> = match migration_state.llm_chat(&impl_prompt, true) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(e) => {
            emit_event!("warn", &format!("LLM failed: {}. No changes.", e), ...);
            vec![]
        }
    };
    
    // Aplicar cambios al worktree
    for change in &changes {
        let full_path = Path::new(&worktree.path).join(&change.file_path);
        match change.action.as_str() {
            "create" | "modify" => {
                if let Some(parent) = full_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&full_path, &change.content)?;
            }
            "delete" => {
                let _ = std::fs::remove_file(&full_path);
            }
            _ => {}
        }
        emit_event!("info", &format!("Applied: {} {}", change.action, change.file_path), ...);
    }
    
    // PASO 4: Commit
    git_stage_all_impl(worktree.path.clone())?;
    
    let commit_msg = format!("feat: {}", input.objective);
    let sha = git_commit_impl(worktree.path.clone(), commit_msg)?;
    
    update_task_field(&tasks, &task_id, |t| { t.commit_sha = Some(sha); });
    emit_event!("info", "Changes committed", ...);
    
    // PASO 5: Push
    match git_push_impl(worktree.path.clone(), None, Some(branch_name.clone())) {
        Ok(_) => emit_event!("info", "Branch pushed", ...),
        Err(e) => emit_event!("warn", &format!("Push failed: {}", e), ...),
    }
    
    // PASO 6: Crear PR (si se pidió)
    if input.auto_pr.unwrap_or(false) {
        let pr_prompt = format!(
            "Generate a GitHub PR description JSON for: {}\n\
             {{\"title\": \"...\", \"body\": \"...\", \"labels\": [...]}}",
            input.objective
        );
        
        if let Ok(pr_json) = migration_state.llm_chat(&pr_prompt, true) {
            if let Ok(pr_data) = serde_json::from_str::<Value>(&pr_json) {
                // Parsear owner/repo de la URL del remote
                let (owner, repo) = parse_github_remote(&input.repo_path)?;
                
                let pr_url = create_github_pr(
                    &owner, &repo,
                    &branch_name,
                    input.base_branch.as_deref().unwrap_or("main"),
                    pr_data["title"].as_str().unwrap_or("AI: automated changes"),
                    pr_data["body"].as_str().unwrap_or(""),
                )?;
                
                update_task_field(&tasks, &task_id, |t| { t.pr_url = Some(pr_url); });
                emit_event!("info", "Draft PR created", ...);
            }
        }
    }
    
    // Marcar como completado
    update_task_field(&tasks, &task_id, |t| { t.status = "success".to_string(); });
    emit_event!("success", "Task completed!", ...);
}
```

---

## 17. `git_review.rs` — PR Review y Audit

**Ubicación:** `src-tauri/src/git_review.rs` (738 líneas)

### Audit log en SQLite

Cada acción importante se registra:

```rust
fn write_audit(
    conn: &Connection,
    repo_path: &str,
    pr_number: u32,
    action: &str,      // "checklist_generated" | "item_updated" | "merged"
    actor: &str,       // "human" | "ai-agent"
    details: &str,
    checklist_snapshot: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO audit_log (id, repo_path, pr_number, action, actor, timestamp_ms, details, checklist_snapshot)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            Uuid::new_v4().to_string(),
            repo_path, pr_number, action, actor,
            now_ms(), details, checklist_snapshot
        ],
    )?;
    Ok(())
}
```

### Merge con safeguards

```rust
pub fn merge_pr_impl(input: MergeInput, migration_state: &MigrationState) -> Result<(), String> {
    // 1. Verificar que no haya items flaggeados
    if let Ok(items) = load_checklist(&db_path, &input.repo_path, input.pr_number) {
        let flagged: Vec<_> = items.iter()
            .filter(|i| i.status == "flagged")
            .collect();
        if !flagged.is_empty() {
            return Err(format!(
                "Cannot merge: {} checklist items are flagged. Review them first.",
                flagged.len()
            ));
        }
    }
    
    // 2. Verificar CI
    let pr = get_pr_impl(GetPrInput { repo_path: input.repo_path.clone(), pr_number: input.pr_number })?;
    if pr.ci_status.as_deref() == Some("failure") {
        return Err("CI checks are failing. Fix them before merging.".to_string());
    }
    
    // 3. Capturar snapshot del checklist para el audit trail
    let checklist_snapshot = load_checklist_as_json(&db_path, &input.repo_path, input.pr_number)?;
    
    // 4. Mergear via GitHub API
    let (owner, repo_name) = parse_github_remote_from_path(&input.repo_path)?;
    let merge_url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}/merge",
        owner, repo_name, input.pr_number
    );
    
    github_api_put(&merge_url, &serde_json::json!({
        "merge_method": input.method.as_deref().unwrap_or("merge")
    }))?;
    
    // 5. Limpiar branch y worktree si se pidió
    if input.delete_branch.unwrap_or(false) {
        let branch_url = format!(
            "https://api.github.com/repos/{}/{}/git/refs/heads/{}",
            owner, repo_name, pr.head_branch
        );
        let _ = github_api_delete(&branch_url);
    }
    
    if input.delete_worktree.unwrap_or(false) {
        if let Some(wt_path) = find_worktree_for_branch(&input.repo_path, &pr.head_branch) {
            let _ = git_remove_worktree_impl(input.repo_path.clone(), wt_path);
        }
    }
    
    // 6. Log al audit
    write_audit(&conn, &input.repo_path, input.pr_number,
        "merged", "human",
        &format!("method={}", input.method.as_deref().unwrap_or("merge")),
        Some(&checklist_snapshot)
    )?;
    
    Ok(())
}
```

---

## 18. Frontend — SolidJS y la IPC con Tauri

### Por qué SolidJS en lugar de React

SolidJS tiene **reactividad fine-grained** — solo se actualizan los nodos del DOM que realmente cambiaron, sin Virtual DOM. Para una app de escritorio que necesita latencia mínima (terminal, editor), esto es ideal.

```typescript
// React — re-renders el componente completo
const [count, setCount] = useState(0);
// Cuando setCount(1), React re-renderiza el componente entero

// SolidJS — actualiza solo el binding específico
const [count, setCount] = createSignal(0);
// Cuando setCount(1), solo <span>{count()}</span> se actualiza en el DOM
```

### Señales (Signals) — el estado reactivo

```typescript
// Crear señal
const [scanStatus, setScanStatus] = createSignal<ScanProgress | null>(null);

// Leer (en JSX, se llama como función)
<div>{scanStatus()?.status}</div>

// Escribir
setScanStatus({ status: "running", filesScanned: 42 });
```

### Memos — estado derivado

```typescript
// Se recalcula automáticamente cuando scanStatus() cambia
const isRunning = createMemo(() => 
    ["pending", "running"].includes(scanStatus()?.status ?? "")
);

// Usar en JSX:
<Show when={isRunning()}>
    <ProgressBar />
</Show>
```

### Efectos — side effects

```typescript
// Se ejecuta cuando cualquier señal que lee adentro cambia
createEffect(() => {
    const status = scanStatus();
    if (status?.status === "success") {
        // Auto-navegar cuando el escaneo termina
        setActiveArea("search");
    }
});
```

### Componentes condicionales

```typescript
// Show — equivale a {condition && <Component />}
<Show when={isLoading()} fallback={<Results />}>
    <LoadingSpinner />
</Show>

// For — equivale a {items.map(...)}
<For each={searchResults()}>
    {(result) => <SearchResultCard result={result} />}
</For>
```

### Wrappers de API

```typescript
// frontend/src/api/migration.ts
import { invoke } from "@tauri-apps/api/core";
import type { SearchQuery, SearchResult, ScanProgress } from "../types";

export const migrationApi = {
    scanRepository: (repoPath: string) =>
        invoke<string>("scan_repository", { repoPath }),
    
    getScanStatus: (jobId: string) =>
        invoke<ScanProgress>("get_scan_status", { scanJobId: jobId }),
    
    searchRepository: (query: SearchQuery) =>
        invoke<SearchResult[]>("search_repository", { query }),
    
    generateWorkflow: (objective: string, context: SearchResult[]) =>
        invoke<WorkflowDsl>("generate_workflow", { objective, context }),
};

// frontend/src/api/git.ts
export const gitApi = {
    repoInfo: (repoPath: string) =>
        invoke<GitRepoInfo>("git_repo_info", { repoPath }),
    
    createWorktree: (input: CreateWorktreeInput) =>
        invoke<WorktreeInfo>("git_create_worktree", { input }),
    
    agentStart: (input: AgentTaskInput) =>
        invoke<string>("git_agent_start", { input }),
    
    agentStatus: (taskId: string) =>
        invoke<AgentTaskState>("git_agent_status", { taskId }),
};
```

### Escuchar eventos del backend

```typescript
import { listen } from "@tauri-apps/api/event";

// En un componente SolidJS:
onMount(async () => {
    // PTY output
    const unlisten = await listen<number[]>(`pty-output:${sessionId}`, (event) => {
        const bytes = new Uint8Array(event.payload);
        terminal.write(bytes);
    });
    
    // AI Agent events
    const unlistenAgent = await listen<AgentEvent>(`git-agent-event:${taskId}`, (event) => {
        setAgentEvents(prev => [...prev, event.payload]);
    });
    
    // Cleanup cuando el componente se desmonta
    onCleanup(() => {
        unlisten();
        unlistenAgent();
    });
});
```

---

## 19. Flujos de datos de punta a punta

### Flujo 1: Escanear un repositorio

```
[Usuario] clicks "Scan Repository"
    │
    ▼
[SolidJS] invoke("scan_repository", { repoPath: "/home/user/myrepo" })
    │
    ▼
[Rust - lib.rs] #[tauri::command] scan_repository(repo_path, state)
    │ state = MigrationState inyectado por Tauri
    │
    ▼
[Rust - migration.rs] scan_repository_impl()
    │ 1. Genera job_id (UUID)
    │ 2. Inserta job en scan_jobs HashMap (locked)
    │ 3. Arc::clone(&self) — barato
    │ 4. std::thread::spawn(move || { do_scan(...) })
    │ 5. return Ok(job_id) ← inmediatamente
    │
    ▼
[SolidJS] recibe job_id → setJobId(jobId)
    │ setInterval(async () => {
    │   const status = await invoke("get_scan_status", { scanJobId });
    │   setScanStatus(status);
    │   if (status.status === "success") clearInterval(interval);
    │ }, 500);
    │
    ▼ (en background)
[Rust - thread] do_scan()
    │ WalkBuilder recorre el filesystem
    │ Por cada archivo:
    │   - Lee contenido y hace hash Blake3
    │   - Si no cambió → skip
    │   - Si cambió → chunk + guardar en SQLite
    │   - Cada 25 archivos → actualiza scan_jobs HashMap
    │ Schedula embedding job
    │ Actualiza status "success"
    │
    ▼
[SolidJS] polling detecta status === "success"
    │ clearInterval
    │ setScanStatus({ status: "success", filesScanned: 347 })
    ▼
[UI] Muestra "347 files indexed" → habilita búsqueda
```

### Flujo 2: Búsqueda semántica

```
[Usuario] escribe "authentication middleware" → click Search
    │
    ▼
[SolidJS] invoke("search_repository", { query: { text, repoPath, limit: 25 } })
    │
    ▼
[Rust] search_repository_impl()
    │ 1. Llama LLM para embedding de la query
    │    POST api.openai.com/v1/embeddings → [0.23, -0.45, ...]
    │ 2. Tokeniza query → ["authentication", "middleware"]
    │ 3. Carga chunks del repo desde SQLite
    │ 4. Carga embeddings desde SQLite
    │ 5. Por cada chunk:
    │    - lexical_score = hits de tokens / total_tokens * 0.65
    │    - semantic_score = cosine_similarity(query_vec, chunk_vec) * 0.35
    │    - final = lexical + semantic
    │ 6. Carga grafo de edges, boost por proximidad * 0.15
    │ 7. Sort por score, truncate a 25
    │ 8. return Vec<SearchResult>
    │
    ▼
[SolidJS] setSearchResults(results)
    │
    ▼
[UI] Lista resultados con file path, línea, snippet y score
```

### Flujo 3: Agente de IA

```
[Usuario] escribe objetivo "Add rate limiting to /api/auth endpoint"
          activa "Auto-create PR" → click "Run Agent"
    │
    ▼
[SolidJS] invoke("git_agent_start", { input: { objective, repoPath, autoPr: true } })
    │
    ▼
[Rust - git_agent.rs] git_agent_start()
    │ 1. Crea task_id (UUID)
    │ 2. Inserta AgentTaskState { status: "pending" } en HashMap
    │ 3. Arc::clone de tasks y migration_state
    │ 4. std::thread::spawn → run_agent_pipeline(...)
    │ 5. return Ok(task_id) ← inmediatamente
    │
    ▼
[SolidJS] recibe task_id → inicia polling + listen("git-agent-event:taskId")
    │
    ▼ (en background thread)
[Rust] run_agent_pipeline()
    │
    │ PASO 1: LLM genera branch name
    │ → "add-rate-limiting-auth-a1b2c3d4"
    │ → emit("git-agent-event:taskId", { level: "info", message: "Creating branch..." })
    │
    │ PASO 2: git_create_worktree → .worktrees/add-rate-limiting-auth-a1b2c3d4/
    │ → emit("info", "Worktree created")
    │
    │ PASO 3: LLM lista archivos + genera cambios
    │ → [{ file_path: "src/middleware/rate_limit.rs", action: "create", content: "..." },
    │     { file_path: "src/routes/auth.rs", action: "modify", content: "..." }]
    │ → escribe archivos en el worktree
    │ → emit("info", "Applied: create src/middleware/rate_limit.rs")
    │ → emit("info", "Applied: modify src/routes/auth.rs")
    │
    │ PASO 4: stage + commit
    │ → emit("info", "Changes committed: abc123def")
    │
    │ PASO 5: push
    │ → intenta SSH agent, luego GITHUB_TOKEN
    │ → emit("info", "Branch pushed to origin")
    │
    │ PASO 6: crear PR via GitHub API
    │ → LLM genera título + descripción
    │ → POST github.com/api/repos/.../pulls
    │ → emit("info", "Draft PR created: https://github.com/...")
    │
    │ → set status "success"
    │ → emit("success", "Task completed!")
    │
    ▼
[SolidJS] listen recibe eventos → muestra log en tiempo real
[UI] Muestra link al PR cuando está listo
```

---

## 20. Cómo arrancar y explorar

### Setup inicial

```bash
# 1. Copiar variables de entorno
cp .env.example .env

# Editar .env:
# OPENAI_API_KEY=sk-...
# GITHUB_TOKEN=ghp_...
# VOIDLINK_LLM_PROVIDER=openai

# 2. Instalar deps frontend
cd frontend && npm install

# 3. Verificar Rust toolchain
rustup show    # debería mostrar stable
cargo --version

# 4. Ejecutar en desarrollo
make app       # lanza Tauri con hot-reload del frontend

# O en modo completo con backend Python:
make dev       # docker + tauri
```

### Explorar el código paso a paso

**Día 1 - Entender Rust básico a través del proyecto:**
1. Leer `src-tauri/src/main.rs` — es una sola línea. ¿Qué llama?
2. Leer `src-tauri/src/lib.rs` — registración de comandos y estado PTY
3. Buscar todos los `#[tauri::command]` en el código:
   ```bash
   grep -n "#\[tauri::command\]" src-tauri/src/*.rs
   ```
4. Elegir un comando simple (como `greet` o `get_home_dir`) y seguirlo desde el frontend hasta Rust

**Día 2 - Concurrencia y estado compartido:**
1. Estudiar `PtyStore` en `lib.rs` — cómo `Arc<Mutex<>>` permite acceso compartido
2. Leer el reader thread de PTY — un bucle infinito leyendo bytes
3. Modificar: cambiar el tamaño del buffer de 4096 a 8192 y ver qué pasa

**Día 3 - SQLite y el sistema de búsqueda:**
1. Leer el schema en `migration.rs` — entender la estructura de datos
2. Leer `do_scan` — walkthrough de escaneo de archivos
3. Leer `cosine_similarity` — matemática simple del search semántico
4. Ejecutar un escaneo y abrir el SQLite con `sqlite3 ~/.local/share/voidlink/voidlink.db`

**Día 4 - Integración Git:**
1. Leer `git_repo_info_impl` — operaciones básicas de git2
2. Leer `git_push_impl` — autenticación con SSH y tokens
3. Leer el pipeline del agente en `git_agent.rs` — 6 pasos bien documentados

### Comandos útiles mientras explorás

```bash
# Compilar sin ejecutar (solo chequear tipos)
cd src-tauri && cargo check

# Ver warnings y errores con contexto
cd src-tauri && cargo clippy

# Ejecutar tests
cd src-tauri && cargo test -- --nocapture

# Ver documentación de una crate
cargo doc --open

# Formatear código
cargo fmt

# Ver árbol de dependencias
cargo tree

# Abrir la DB directamente
sqlite3 ~/.local/share/voidlink/voidlink.db
.schema
SELECT count(*) FROM chunks;
.quit
```

---

## 21. Qué leer para profundizar

### Rust - Fundamentos

| Recurso | Por qué leerlo |
|---|---|
| [The Rust Book](https://doc.rust-lang.org/book/) | La guía oficial. Capítulos 1-9 son obligatorios |
| [Rust by Example](https://doc.rust-lang.org/rust-by-example/) | Ejemplos interactivos, excelente para búsqueda rápida |
| [Rustlings](https://github.com/rust-lang/rustlings) | Ejercicios para aprender haciendo |
| [Tour of Rust](https://tourofrust.com/) | Intro interactiva en el browser |

### Rust - Avanzado (conceptos usados en VoidLink)

| Recurso | Concepto |
|---|---|
| [Rust Book Ch.16 - Concurrency](https://doc.rust-lang.org/book/ch16-00-concurrency.html) | Arc, Mutex, threads — usado en lib.rs y migration.rs |
| [Rust Book Ch.15 - Smart Pointers](https://doc.rust-lang.org/book/ch15-00-smart-pointers.html) | Box, Rc, Arc, RefCell |
| [Rust Book Ch.13 - Closures & Iterators](https://doc.rust-lang.org/book/ch13-00-functional-features.html) | Usado en todo el codebase |
| [Rust Book Ch.10 - Generics & Traits](https://doc.rust-lang.org/book/ch10-00-generics.html) | dyn Trait, impl Trait |
| [Rust Async Book](https://rust-lang.github.io/async-book/) | Para cuando quieras migrar a async |

### Crates usadas en VoidLink

| Crate | Docs | Uso en VoidLink |
|---|---|---|
| `serde` + `serde_json` | [serde.rs](https://serde.rs) | Serialización de todos los tipos |
| `rusqlite` | [docs.rs/rusqlite](https://docs.rs/rusqlite) | SQLite en migration.rs |
| `git2` | [docs.rs/git2](https://docs.rs/git2) | Todo git.rs |
| `reqwest` | [docs.rs/reqwest](https://docs.rs/reqwest) | HTTP en migration.rs y git_review.rs |
| `portable-pty` | [docs.rs/portable-pty](https://docs.rs/portable-pty) | Terminal emulation en lib.rs |
| `blake3` | [docs.rs/blake3](https://docs.rs/blake3) | Hashing de archivos en migration.rs |
| `uuid` | [docs.rs/uuid](https://docs.rs/uuid) | IDs únicos en todo el codebase |
| `tauri` | [v2.tauri.app](https://v2.tauri.app) | El framework de escritorio |

### SolidJS

| Recurso | Por qué leerlo |
|---|---|
| [SolidJS Tutorial](https://www.solidjs.com/tutorial/introduction_basics) | Intro oficial, 20 min |
| [SolidJS Docs - Reactivity](https://www.solidjs.com/docs/latest#signals) | Signals, Memos, Effects |
| [SolidJS vs React](https://www.solidjs.com/guides/comparison) | Entender las diferencias |

### Para TypeScript devs que aprenden Rust

| Recurso | Descripción |
|---|---|
| [Rust para TypeScript devs](https://www.youtube.com/watch?v=6VjOQJQ0Hh8) | Video comparativo |
| [TypeScript to Rust](https://www.typescriptlang.org/docs/handbook/intro.html) | Analogías directas |
| [No Boilerplate - Rust playlist](https://www.youtube.com/@NoBoilerplate) | Videos cortos y didácticos en inglés |
| [Let's Get Rusty](https://www.youtube.com/@letsgetrusty) | Canal de YouTube muy bueno |

---

## Apéndice: Patrones Rust que se repiten en VoidLink

### Pattern 1: Command + State injection

```rust
#[tauri::command]
fn my_command(
    input: InputType,                          // del frontend (JSON → tipo Rust automático)
    state: tauri::State<MyState>,              // inyectado por Tauri
    app_handle: tauri::AppHandle,              // para emitir eventos
) -> Result<OutputType, String> {              // serializado a JSON para el frontend
    // ...
}
```

### Pattern 2: Background job con polling

```rust
// 1. Retornar ID inmediatamente
fn start_job(state: State<JobStore>) -> Result<String, String> {
    let job_id = Uuid::new_v4().to_string();
    state.lock()?.insert(job_id.clone(), JobStatus::Pending);
    
    let store_clone = Arc::clone(&state);
    let id_clone = job_id.clone();
    
    std::thread::spawn(move || {
        // trabajo pesado
        store_clone.lock().unwrap().insert(id_clone, JobStatus::Success);
    });
    
    Ok(job_id)
}

// 2. Frontend hace polling
fn get_job_status(job_id: String, state: State<JobStore>) -> Result<JobStatus, String> {
    let store = state.lock().map_err(|e| e.to_string())?;
    store.get(&job_id)
        .cloned()
        .ok_or("Job not found".to_string())
}
```

### Pattern 3: Error propagation chain

```rust
fn complex_operation(path: &str) -> Result<Data, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Cannot read {}: {}", path, e))?;  // IO error → String
    
    let parsed: Config = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON: {}", e))?;           // JSON error → String
    
    let result = process(parsed)
        .map_err(|e| format!("Processing failed: {}", e))?;      // domain error → String
    
    Ok(result)
}
```

### Pattern 4: Shared mutable state entre threads

```rust
// Tipo aliases para claridad
type JobStore = Arc<Mutex<HashMap<String, JobStatus>>>;

// Inicializar
let store: JobStore = Arc::new(Mutex::new(HashMap::new()));

// En comando Tauri (thread del pool):
fn write_to_store(store: tauri::State<JobStore>, key: String) {
    let mut map = store.lock().unwrap();
    map.insert(key, JobStatus::Running);
}  // lock se libera aquí automáticamente

// En background thread:
let store_clone = Arc::clone(&store);
std::thread::spawn(move || {
    let mut map = store_clone.lock().unwrap();
    map.insert("key".to_string(), JobStatus::Done);
});
```

### Pattern 5: LLM → JSON → Struct

```rust
// 1. Pedir JSON al LLM
let prompt = "Return a JSON object with { name: string, steps: string[] }";
let raw = llm_provider.chat_completion(&prompt, true)?;

// 2. Deserializar
#[derive(Deserialize)]
struct LlmOutput {
    name: String,
    steps: Vec<String>,
}

let output: LlmOutput = serde_json::from_str(&raw)
    .map_err(|e| format!("LLM returned invalid JSON: {}\nRaw: {}", e, raw))?;

// 3. Usar
for step in &output.steps {
    println!("Step: {}", step);
}
```

---

*Última actualización: 2026-04-01 — escrita para el VoidLink commit `bf24ee3`*
