# Checklist de prueba — UI wave 2

Rama: `feat/ui-wave-2-2026-08`. Arrancar con `npm run tauri dev`.
Marcá lo que falla; lo que no está marcado se asume OK.

Ordenado por riesgo: arriba lo que ningún test pudo probar, abajo lo que ya
está cubierto y sólo necesitás confirmar.

---

## 1. Los semáforos de macOS (nadie los vio)

El valor pasó de `y: 9` a **`y: 18`**, y el motivo es que `y` **no es un margen
superior**: tao/wry lo usan para redimensionar el contenedor del título, no para
mover los botones. El mapeo real es `centro = y - 2`.

- [ ] Workbench: los tres botones **centrados** verticalmente en la barra de 32px
- [ ] Ventana satélite (git o editor): **igual** que el workbench
- [ ] Ocupan de 12 a 72px, y "Voidlink" arranca después
- [ ] Se puede arrastrar la ventana desde justo a la derecha
- [ ] Entrar y salir de **pantalla completa** → siguen en su lugar
- [ ] Cambiar a otra app y volver → siguen en su lugar

> Se midió con una prueba en Swift contra el mismo AppKit (macOS 26.5), pero no
> dentro de VoidLink. Si queda mal, decime cuántos px y para qué lado.

## 2. Cerrar cosas desprendidas (antes crasheaba)

La causa: `Window::close()` no cierra, dispara `CloseRequested`, y Tauri
**siempre** lo cancela si la ventana tiene un listener JS — que es justo cómo un
panel pide volver. Y ninguna capability tenía `allow-destroy`.

- [ ] Desprender el explorador → cerrar esa ventana → **no crashea**
- [ ] Vuelve al shell **colapsado**, en su borde y ancho de antes
- [ ] Lo mismo cerrando con el semáforo rojo (no sólo con el botón de la app)
- [ ] Ventana del editor: cerrarla la trae de vuelta como tab
- [ ] Ventana de git: cerrarla trae el sidebar de git, colapsado
- [ ] Botón "Attach to main window" en la ventana desprendida
- [ ] Settings → modo **apilado** → se cierran las tres y vuelven adentro
- [ ] Volver a modo desprendido → **no** se reabren solas

> Se arregló leyendo el código de Tauri 2.11.2, no probándolo. Este bloque es el
> que más necesita tus manos.

## 3. Fondo con imagen y transparencia

Eran **dos** causas, no una. La que ya sabíamos (`bg-canvas` opaco encima) y una
segunda: `@theme inline` sustituye el alias, así que `bg-canvas` compilaba a
`var(--canvas)` y todo el bloque de mezcla apuntaba a nombres que ninguna clase
leía. Arreglar sólo la primera habría dejado el slider igual de inerte.

- [ ] Elegir una imagen → se ve **inmediatamente**
- [ ] Se ve en las cuatro ventanas (workbench, editor, git, panel)
- [ ] El slider gradúa de punta a punta, visiblemente
- [ ] Se ve también detrás de la barra de título
- [ ] Borrar/mover el archivo y recargar → vuelve al tema, sin error
- [ ] Accesibilidad → **Reducir transparencia** = ON → todo opaco, sin imagen

## 4. Menús contextuales

- [ ] Click derecho en cualquier lado: **nunca** Recargar / Inspeccionar / autofill
- [ ] Probar en las cuatro ventanas
- [ ] En build de desarrollo, Inspeccionar **sí** sigue estando
- [ ] Dentro de un input o textarea: menú del sistema (copiar/pegar/ortografía)
- [ ] Sobre el editor: el menú **propio de Monaco** aparece
- [ ] Panes, terminales, barra de estado, los cinco sidebars, tabs, board: cada uno responde
- [ ] `Shift+F10` abre el mismo menú en el elemento con foco

> Ninguno se verificó con la app abierta. El de Monaco es el más frágil.

## 5. El tema del editor ya no se invierte

La causa: `setTheme` avisaba a la señal **antes** de escribir el cascade, así que
el efecto de Monaco leía la paleta vieja y la registraba con el nombre del modo
nuevo. Cada cambio entre claro y oscuro, y quedaba así hasta el siguiente.

- [ ] Cambiar dark → light con el editor abierto: coincide, sin recargar
- [ ] Cambiar con la **ventana** del editor ya abierta: coincide
- [ ] `github-light` y `solarized-light` (claros que no se llaman "light")
- [ ] Recorrer los 10 temas: nunca queda al revés

## 6. Panes y tabs

El pane vacío tenía una causa concreta: `pruneClosedTabs` eximía al grupo en
posición 0 **por índice**, y un split "before" mete un grupo nuevo y vacío
justo ahí — se quedaba con la exención sin atrapar nada.

- [ ] Cerrar la última tab de un pane → el pane **se cierra**
- [ ] Menú de tab → "Add to split pane" → se abre el pane group con la tab adentro
- [ ] El pane group es una **tab** más: se cierra, y sus tabs vuelven al primer pane
- [ ] Sobrevive al reload con sus proporciones y su tab activa
- [ ] Renombrar tab con **F2** y con doble click, en horizontal **y** en vertical
- [ ] Color de etiqueta de tab, en ambas orientaciones, persistido

**El test crítico:**

- [ ] Abrir terminal, lanzar `ping 8.8.8.8`, moverla a un pane group
      → el proceso **sigue vivo** y el scrollback intacto

## 7. Cinco sidebars

- [ ] Son cinco separados: workspaces, explorer, terminals, git, agents
- [ ] El explorador **no** tiene terminales abajo
- [ ] Se llama **"Explorer"** en todos lados (header, tooltip, paleta, ventana)
- [ ] Cada uno con su ancho, su colapso, su splitter, su menú
- [ ] Se llama igual con tabs horizontales y verticales
- [ ] Arrastrar uno al borde opuesto lo dockea, y sobrevive al reload
- [ ] En el sidebar de git se puede **arrastrar** desde el margen de las secciones

## 8. Board

- [ ] Doble click / Enter / menú → la card abre en el **editor real**, con frontmatter
- [ ] Editarla y guardarla ahí actualiza el board sin refrescar a mano
- [ ] Renombrar el título en la card (F2)
- [ ] Agregar y sacar labels; filtrar por label
- [ ] Fecha de creación visible; fecha de vencimiento se pone y marca vencida
- [ ] Click derecho en espacio vacío → "New card"
- [ ] Una card vieja (sin `due`) abre sin error

## 9. Reset de layout y Compare

- [ ] Reset aplana el split y restaura anchos, **sin** perder workspaces ni tabs
- [ ] "Compare branches" ya no está en el pie del sidebar de git
- [ ] Está en el menú `+`, abre la misma tab
- [ ] El compare **con upstream** sigue donde estaba

---

## Lo que quedó afuera a propósito

Decisiones tomadas por los agentes con motivo, no olvidos. Decime si alguna no te cierra.

- [ ] **Terminales no se puede desprender.** Cada control suyo es una escritura
      (spawnear PTY, matar shell) y no hay canal de snapshot: una lista
      desprendida saldría vacía con todos los botones muertos. Agents sí se
      puede, porque ya hay `AgentBoardSnapshot` cruzando. ¿Lo hacemos igual?
- [ ] **`solarized-light` queda en 3.82:1** con foto oscura. Ya estaba en 4.26:1
      **sin** imagen — está bajo AA desde antes de esta wave. Sólo se arregla
      retocando los tokens del tema. ¿Lo miro?
- [ ] **No hay "borrar card"** en el board: `boardApi` no tiene delete. Es un
      comando nuevo en Rust, no un menú.
- [ ] **`Shift+F10` no llega al menú de una card**: la card no es focusable
      (ya era así, no lo cambió esta wave).
- [ ] **Reset borra `gitPrefs` entero**, así que también se lleva modo de diff y
      orden de secciones de git. Separarlo es una migración de storage.
- [ ] **Orientación de tabs no se resetea**: vive en settings, y el texto del
      botón promete que los settings sobreviven.
- [ ] **`TerminalsSidebar` y `GitApp` todavía tienen su botón de Compare.** No
      eran el pie del sidebar de git. ¿Aplico el mismo criterio?
- [ ] Dentro de un pane anidado no hay menú `+`, y el foco de pane no se persiste.

## Si algo falla

Decime el número. Las 7 ramas siguen existiendo (`feat/five-sidebars`,
`feat/detach-lifecycle`, `feat/pane-groups`, `feat/context-menus`,
`fix/chrome-appearance`, `feat/board-cards`, `fix/layout-reset-and-compare`),
así que se arregla en la que corresponda y se vuelve a mergear.
