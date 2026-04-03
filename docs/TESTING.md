# Guía de Testing — VoidLink

Documento de pruebas manual para validar el estado actual de la aplicación. Cubre todas las funcionalidades activamente expuestas en la UI, incluyendo la integración Git completa (Fases 1–5) y el sistema BYOK de configuración de proveedores.

---

## Requisitos previos

| Requisito | Valor esperado |
|-----------|---------------|
| Rust / Cargo | `cargo --version` ≥ 1.78 |
| Node.js | `node --version` ≥ 20 |
| `git2` / libgit2 | incluido como vendored en Cargo.toml |
| `GITHUB_TOKEN` | necesario para Fases 4 y 5 (PRs y agente) |
| Proveedor LLM | configurar desde Settings o via env var (ver sección 10) |
| Repo git local de prueba | cualquier repo con al menos 2 ramas y commits |

### Iniciar la aplicación

```bash
# En Linux (Wayland):
WAYLAND_DISPLAY="" cargo tauri dev

# En macOS:
cargo tauri dev
```

---

## 1. Shell / Arranque

### TC-001 — Ventana principal abre correctamente

**Pasos:**
1. Ejecutar `cargo tauri dev`.
2. Esperar a que la ventana se muestre.

**Resultado esperado:**
- La ventana aparece con la barra de título personalizada de VoidLink.
- Sidebar izquierdo visible con al menos un workspace por defecto.
- Sin errores en la consola del navegador (F12).

---

### TC-002 — Persistencia de workspaces

**Pasos:**
1. Crear un workspace nuevo.
2. Asignarle un nombre.
3. Cerrar la aplicación.
4. Volver a abrirla.

**Resultado esperado:**
- El workspace creado aparece en el sidebar al reiniciar.
- El nombre se conserva correctamente.

---

## 2. Repository Scanner

### TC-030 — Abrir repositorio

**Pasos:**
1. En App, seleccionar o crear un workspace.
2. Usar el selector de carpeta para apuntar a un repositorio git local.

**Resultado esperado:**
- El path del repositorio se muestra en la interfaz.
- El botón "Scan" (o equivalente) queda habilitado.

---

### TC-031 — Escanear repositorio

**Pasos:**
1. Con un repo seleccionado, iniciar el escaneo.
2. Observar el progreso.

**Resultado esperado:**
- Se muestra progreso: número de archivos escaneados/indexados.
- Al completar, el estado cambia a "done".
- No hay error en consola.

---

### TC-032 — Búsqueda en repositorio

**Pasos:**
1. Completar TC-031 primero.
2. Escribir una consulta en la barra de búsqueda (p.ej. "authentication", "database connection").
3. Presionar Enter o el botón de búsqueda.

**Resultado esperado:**
- Aparecen resultados con snippets de código relevantes.
- Cada resultado muestra path del archivo, snippet, y score de relevancia.

---

### TC-033 — Context Builder: agregar contexto y generar workflow

**Pasos:**
1. Desde los resultados de búsqueda, hacer clic en "Add to context" en 2–3 resultados.
2. Ir a la pestaña/área "Context Builder".
3. Escribir un objetivo (p.ej. "Refactorizar el módulo de autenticación para usar JWT").
4. Hacer clic en "Generate Workflow".

**Resultado esperado:**
- Se muestra un workflow generado con pasos (tipo WorkflowDsl).
- Cada paso tiene nombre, descripción, tipo de herramienta.

---

### TC-034 — Workflow Tab: ejecutar un workflow

**Pasos:**
1. Con un workflow generado (TC-033), ir a la pestaña "Workflow".
2. Iniciar la ejecución.

**Resultado esperado:**
- Los pasos se ejecutan en orden respetando `depends_on`.
- El progreso de cada paso es visible en tiempo real.
- Al completar, el estado final es visible.

---

## 3. Git — Fase 1: Operaciones base

Para estas pruebas, configurar el workspace apuntando a un repositorio git con al menos 2 ramas.

### TC-040 — GitStatusBar visible

**Pasos:**
1. Seleccionar un repositorio con git inicializado.
2. Ir a la pestaña/área "Git".

**Resultado esperado:**
- Se muestra el nombre de la rama actual.
- Si hay archivos modificados, aparece el indicador de cambios.

---

### TC-041 — Información del repositorio

**Pasos:**
1. Abrir el área Git.
2. Seleccionar la vista "Status".

**Resultado esperado:**
- Se muestra: rama actual, hash del commit HEAD, URL del remote, si el árbol está limpio.

---

### TC-042 — Listar ramas

**Pasos:**
1. En la vista "Branches", observar la lista de ramas.

**Resultado esperado:**
- Aparecen todas las ramas locales.
- La rama actual está marcada (ej. ícono o resaltado).
- Si hay ramas remotas, se muestran al activar la opción correspondiente.

---

### TC-043 — Cambiar de rama

**Pasos:**
1. En la vista "Branches", hacer clic en una rama diferente a la actual.
2. Confirmar el cambio.

**Resultado esperado:**
- La rama activa cambia.
- El GitStatusBar actualiza el nombre de la rama.
- No hay error si el árbol de trabajo está limpio.

---

### TC-044 — Ver estado de archivos

**Pasos:**
1. Modificar un archivo en el repositorio (desde terminal o editor externo).
2. En la vista "Status", hacer clic en "Refresh" o esperar el refresco automático.

**Resultado esperado:**
- El archivo modificado aparece en la lista con estado "modified".
- Los archivos no rastreados aparecen como "untracked".

---

### TC-045 — Staging y commit

**Pasos:**
1. Con archivos modificados visibles en "Status":
2. Seleccionar un archivo y hacer clic en "Stage".
3. Escribir un mensaje de commit.
4. Hacer clic en "Commit".

**Resultado esperado:**
- El archivo desaparece de la lista de cambios no staged.
- El commit aparece en el log al ir a la vista "Log".

---

## 4. Git — Fase 2: Worktrees

### TC-050 — Crear worktree

**Pasos:**
1. Ir a la vista "Worktrees".
2. Ingresar un nombre de rama (p.ej. `feature/test-worktree`).
3. Hacer clic en "Create Worktree".

**Resultado esperado:**
- Se crea el directorio `.worktrees/feature/test-worktree` dentro del repo.
- El worktree aparece en la lista con su rama y path.

---

### TC-051 — Eliminar worktree

**Pasos:**
1. Con el worktree creado en TC-050, hacer clic en el ícono de eliminar.
2. Confirmar si se pide confirmación.

**Resultado esperado:**
- El worktree desaparece de la lista.
- El directorio `.worktrees/feature/test-worktree` ya no existe en el sistema de archivos.

---

## 5. Git — Fase 3: Diff & Review

### TC-060 — Ver diff del árbol de trabajo

**Pasos:**
1. Modificar al menos un archivo en el repo (no staged).
2. Ir a la vista "Diff".

**Resultado esperado:**
- Se muestra la lista de archivos modificados.
- Al expandir un archivo, se ven los hunks con líneas añadidas (verde) y eliminadas (rojo).
- Los números de línea son correctos.

---

### TC-061 — Ver diff entre ramas

**Pasos:**
1. En la vista "Diff", seleccionar modo "Branch comparison".
2. Elegir `base` y `head` (dos ramas distintas).

**Resultado esperado:**
- Se muestra el diff completo entre las dos ramas.
- Se listan todos los archivos cambiados con sus hunks.

---

### TC-062 — Explicación de diff con IA

> Requiere un proveedor LLM configurado (ver sección 10).

**Pasos:**
1. Con un diff visible (TC-060 o TC-061), hacer clic en "Explain" sobre un archivo.

**Resultado esperado:**
- Aparece un panel con la explicación generada por IA.
- Se muestra: resumen, nivel de riesgo (low/medium/high), sugerencias.

---

## 6. Git — Fase 4: AI Agent

> Requiere `GITHUB_TOKEN` y un proveedor LLM configurado.

### TC-070 — Iniciar tarea de agente

**Pasos:**
1. Ir a la vista "AI Agent".
2. Escribir un objetivo (p.ej. "Add a health check endpoint to the API").
3. Seleccionar la rama base (p.ej. `main`).
4. Activar "Auto-create PR".
5. Hacer clic en "Start Task".

**Resultado esperado:**
- Se muestra un task ID y el estado cambia a "branching".
- El log de eventos comienza a mostrar mensajes en tiempo real.
- La tarea progresa por los estados: branching → implementing → testing → pr_creating → success.

---

### TC-071 — Cancelar tarea de agente

**Pasos:**
1. Iniciar una tarea (TC-070).
2. Antes de que termine, hacer clic en "Cancel".

**Resultado esperado:**
- El estado de la tarea cambia a "failed" con mensaje de cancelación.
- No se crea ningún PR en GitHub.

---

### TC-072 — Verificar PR creado (si TC-070 completó con éxito)

**Pasos:**
1. Tras un TC-070 exitoso, copiar el link al PR mostrado en la interfaz.
2. Abrir en el navegador.

**Resultado esperado:**
- El PR existe en GitHub como draft.
- Tiene descripción generada por IA con sección de resumen y plan de test.
- Está apuntando a la rama base correcta.

---

## 7. Git — Fase 5: PR Dashboard & Merge

> Requiere `GITHUB_TOKEN` y un repo conectado a GitHub con PRs abiertos.

### TC-080 — Listar PRs

**Pasos:**
1. Ir a la vista "Pull Requests".

**Resultado esperado:**
- Se muestran los PRs abiertos del repositorio remoto.
- Cada card muestra: título, autor, rama, número de cambios, estado de CI.

---

### TC-081 — Generar checklist de review

**Pasos:**
1. Hacer clic en "Review" en uno de los PRs de la lista.
2. Hacer clic en "Generate Checklist".

**Resultado esperado:**
- Aparecen ítems agrupados por categoría (security, performance, correctness, style, testing).
- Cada ítem tiene descripción y nota generada por IA.
- El riesgo general se muestra (low/medium/high).

---

### TC-082 — Marcar ítems del checklist

**Pasos:**
1. Con un checklist generado (TC-081), marcar algunos ítems como "passed" y otros como "flagged".

**Resultado esperado:**
- El estado de cada ítem cambia visualmente al hacer clic.
- Los cambios persisten si se recarga la vista.

---

### TC-083 — Merge de PR

> **Precaución:** Esto hace merge real en GitHub. Usar un PR de prueba.

**Pasos:**
1. Con todos los ítems del checklist sin "flagged", y CI en "success":
2. Seleccionar método de merge (merge/squash/rebase).
3. Hacer clic en "Merge".

**Resultado esperado:**
- El PR se cierra como merged en GitHub.
- Si se seleccionó "Delete branch", la rama remota desaparece.
- La entrada queda registrada en el Audit Log.

---

### TC-084 — Audit Log

**Pasos:**
1. Ir a la vista "Audit".

**Resultado esperado:**
- Se muestra el historial de acciones (generate checklist, update item, merge, etc.).
- Cada entrada tiene: acción, actor (human/ai-agent), timestamp, detalles.

---

## 8. Barra de título personalizada

### TC-100 — Controles de ventana

**Pasos:**
1. Abrir la app.
2. Usar los botones de minimizar, maximizar y cerrar en la barra de título.

**Resultado esperado:**
- Cada botón realiza la acción correspondiente.
- La barra arrastra la ventana al hacer clic y arrastrar.

---

## 9. Configuración / Settings (BYOK)

El panel de Settings gestiona la selección de proveedor LLM y las API keys, almacenadas en el keychain del sistema operativo.

### TC-090 — Abrir panel de configuración

**Pasos:**
1. Hacer clic en el ícono de ajustes (⚙️) en la interfaz.

**Resultado esperado:**
- Se abre el panel de configuración con la lista de proveedores disponibles.

---

### TC-091 — Guardar API key de un proveedor

**Pasos:**
1. En Settings, seleccionar un proveedor (p.ej. OpenAI).
2. Ingresar la API key.
3. Hacer clic en "Save".

**Resultado esperado:**
- La key se guarda en el OS keychain (sin aparecer en texto plano tras guardar).
- Al reabrir Settings, el campo muestra que hay una key guardada.

---

### TC-092 — Cambiar proveedor activo

**Pasos:**
1. Con al menos una key guardada, seleccionar un proveedor diferente como activo.
2. Guardar.

**Resultado esperado:**
- Al usar cualquier función de IA, se usa el proveedor seleccionado.
- Al reiniciar la app, el proveedor activo persiste.

---

### TC-093 — Reload provider en caliente

**Pasos:**
1. Cambiar el proveedor en Settings.
2. Sin reiniciar la app, usar una función de IA (p.ej. TC-062).

**Resultado esperado:**
- La función de IA usa el nuevo proveedor sin necesidad de reiniciar.

---

## Casos de error conocidos

| Escenario | Comportamiento esperado |
|-----------|------------------------|
| `GITHUB_TOKEN` no configurado | Las funciones de PRs/Agent muestran error descriptivo, no crashean |
| Sin proveedor LLM configurado | Las funciones de IA muestran error, el resto de la app sigue funcional |
| Repo sin remote | `git_push` falla con mensaje claro; staging/commit funcionan igual |
| Worktree con cambios al eliminar | Requiere activar "Force delete"; sin él, la operación falla con mensaje |
| Árbol de trabajo sucio al cambiar rama | La operación falla con mensaje claro pidiendo hacer commit o stash |

---

## Checklist rápido de smoke test

```
[ ] La app abre sin errores y la barra de título es visible
[ ] Se puede crear un workspace y persiste al reiniciar
[ ] Repository Scanner escanea un repo sin errores
[ ] Búsqueda devuelve resultados relevantes
[ ] Context Builder genera un workflow
[ ] GitStatusBar muestra la rama correcta
[ ] Se puede listar y cambiar ramas
[ ] Se puede ver el diff del árbol de trabajo
[ ] Se puede crear y eliminar un worktree
[ ] PRs se listan si GITHUB_TOKEN está configurado
[ ] Settings guarda una API key y el proveedor persiste al reiniciar
```
