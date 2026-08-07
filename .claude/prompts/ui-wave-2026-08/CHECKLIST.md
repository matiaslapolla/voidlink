# Checklist de prueba — UI wave, agosto 2026

Rama: `feat/ui-wave-2026-08`. Arrancar con `npm run tauri dev`.
Marcá lo que falla; lo que no está marcado se asume OK.

---

## 1. Tabs verticales — el bug del editor (lo más importante)

Settings → UI → orientación de tabs = **vertical**. Abrir la ventana del editor.

- [ ] La columna de tabs está a la izquierda y el editor ocupa **todo** el ancho restante
- [ ] No hay una franja muerta a la derecha
- [ ] La barra de estado del editor va **abajo**, de lado a lado (no como tercera columna)
- [ ] Con un split abierto, el handle del medio se arrastra bien
- [ ] Volver a horizontal restaura todo sin recargar
- [ ] En un `.md`, el botón de preview (ojo) aparece y funciona en ambas orientaciones

## 2. Íconos de ventana

- [ ] macOS: los semáforos quedan **centrados** verticalmente en la barra (no bajos)
- [ ] Se puede arrastrar la ventana desde justo a la derecha de los semáforos
- [ ] El ícono de maximizar tiene el mismo tamaño que sus vecinos

> Ojo: el valor `y: 9` es cálculo, nadie lo vio renderizado. Si queda alto o bajo, decime cuántos px.

## 3. Paneles redimensionables

En el sidebar izquierdo (Files / Terminals / Agents):

- [ ] Hay handle entre Files y Terminals, y entre Terminals y Agents
- [ ] Arrastran 1:1, sin saltos al pasarse del límite y volver
- [ ] Flechas mueven 8px, Shift+flecha 32px, Home/End van a los extremos
- [ ] Doble click vuelve al default
- [ ] Sección colapsada → su handle queda deshabilitado **con motivo en el tooltip**

En la ventana del editor:

- [ ] El árbol de archivos se redimensiona y **sobrevive al reload**
- [ ] El split del editor se redimensiona y sobrevive al reload
- [ ] Cambiar cualquier preferencia en el workbench **no** revierte estos dos anchos

## 4. Sidebars: docking, drag y detach

- [ ] En tabs verticales, Files y Git son **dos sidebars separados** (no uno arriba del otro)
- [ ] Cada uno tiene su propio ancho y su propio colapso
- [ ] Arrastrar un sidebar al borde opuesto lo dockea ahí, con preview durante el drag
- [ ] La disposición sobrevive al reload
- [ ] `Mod+B` sigue siendo "mostrar/ocultar explorador" en ambas orientaciones

**El test crítico (si falla, avisame antes que nada):**

- [ ] Abrir una terminal, lanzar algo largo (`ping 8.8.8.8`), mover un sidebar al otro borde
      → el proceso **sigue vivo** y el scrollback intacto

Detach:

- [ ] Un sidebar se puede sacar a su propia ventana; el hueco en el shell se cierra
- [ ] Cerrar esa ventana lo vuelve a su borde y ancho anterior
- [ ] Un sidebar detached sigue detached después de reiniciar la app

## 5. Rail de workspaces colapsable

- [ ] Colapsa a una tira angosta de íconos (no desaparece)
- [ ] Desde la tira colapsada hay forma de volver
- [ ] Hay toggle en la title bar y atajo (`⌘⇧B`)
- [ ] El estado sobrevive al reload
- [ ] La tira colapsada tiene **el mismo color que el rail** expandido

## 6. Blur de privacidad (grabar pantalla)

- [ ] Cada fila de workspace tiene botón de ojo
- [ ] Al activarlo se blurean el nombre del workspace y **todas** sus worktrees
- [ ] Nada se mueve de lugar al activarlo (sin salto de layout)
- [ ] Sobrevive al reload
- [ ] Grabar 10s en 1080p y confirmar que el texto es **ilegible**
- [ ] La acción también está en la paleta de comandos

> Fuera de alcance a propósito: el tooltip "Open folder" todavía muestra la ruta,
> y los aria-labels de worktree todavía nombran el workspace. Decime si querés que entren.

## 7. Transparencia + imagen de fondo

Settings → UI:

- [ ] Se puede elegir una imagen del disco
- [ ] Se pinta detrás de **las tres ventanas** (workbench, editor, git)
- [ ] El slider de opacidad gradúa visiblemente, de punta a punta
- [ ] Con la imagen puesta, el texto se sigue leyendo bien en todos lados
- [ ] Rail, tab strip y status bar se vuelven translúcidos **igual que el resto**
      (si alguno queda opaco, es un bug del merge — avisame)
- [ ] macOS → Ajustes → Accesibilidad → **Reducir transparencia** = ON → todo opaco
- [ ] Borrar/mover el archivo de imagen y recargar → vuelve al fondo del tema, sin error
- [ ] Todo sobrevive al reload

## 8. Contraste / colores

- [ ] En dark por defecto: rail, sidebars, editor, terminal y status bar se distinguen entre sí
- [ ] En light por defecto: lo mismo (el efecto es más sutil, hay menos margen)
- [ ] **`github-light`**: el caso más ajustado — mirar que el status bar no se funda con el sidebar
- [ ] Recorrer los 8 temas: ninguna región se come a su vecina
- [ ] Los swatches de preview en Settings → Theme siguen coincidiendo

> Sinceridad: solo se agregaron 3 tokens nuevos (rail, tab strip, status bar).
> El editor y los paneles quedaron con la relación de color que ya tenían.
> Si te parece poco cambio, decime y hago una segunda pasada moviendo `--background` vs `--sidebar`.

## 9. Plan de Ghostty (solo lectura)

- [ ] Leer `docs/decisions/ghostty-terminal-engine.md`
- [ ] ¿Estás de acuerdo con la recomendación de **quedarnos en xterm.js**?

Hallazgos sueltos que salieron de ahí:

- [ ] `@xterm/addon-web-links` y `@xterm/addon-clipboard` están declarados pero no se usan → ¿los saco?
- [ ] El bug de ancho de Nerd Font se puede arreglar dentro de xterm (~1 día) → ¿lo hago?

## 10. Documento de transparencia nativa (solo lectura)

- [ ] Leer `docs/decisions/native-window-transparency.md`
- [ ] Decidir si vale probar la vía nativa o alcanza con la capa CSS

---

## Dos decisiones tuyas

- [ ] **Asset protocol**: quedó en `"allow": ["**/*"]` (cualquier ruta absoluta).
      Coincide con el modelo de confianza que ya tiene la app, pero es superficie nueva.
      ¿Lo dejo, o lo achico a una carpeta de datos de la app?
- [ ] **`⌘\`**: ahora espeja toda la disposición en vez de swapear dos sidebars.
      ¿Te sirve así, o preferís otra cosa?

## Si algo falla

Decime el número del ítem y qué viste. Las 6 ramas siguen existiendo
(`fix/vertical-tabs-editor`, `feat/pane-resize-gaps`, `feat/sidebar-docking`,
`feat/surface-contrast-tokens`, `feat/privacy-and-backgrounds`, `docs/ghostty-plan`),
así que se puede arreglar en la rama que corresponda y volver a mergear.
