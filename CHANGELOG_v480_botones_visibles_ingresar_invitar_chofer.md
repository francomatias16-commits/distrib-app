# v480 — Botones "Ingresar al panel" / "Invitar chofer" visibles en Rutas

## Problema (reportado por Ruben con captura)
En la pestaña "Armar ruta" del panel de rutas, los dos accesos a
`ingresarComoChofer()` y `abrirModalInvitarChofer()` eran dos íconos sin
texto, de 14x14px, apretados al lado del `<select>` de chofer con
`padding:0 10px`. Solo se distinguían por el ícono y un `title` (tooltip al
pasar el mouse) — nada visible indicaba qué función cumplía cada uno.

## Fix
`frontend/admin/rutas.html`
- El `<select id="ruta-chofer">` vuelve a ocupar su celda completa del grid
  (ya no comparte fila con los dos botones).
- Los dos botones salen del grid y pasan a una fila propia
  (`.ruta-chofer-acciones`) debajo del formulario, separada con un borde
  superior sutil.
- Cada uno ahora tiene texto explícito ("Ingresar al panel del chofer" /
  "Invitar nuevo chofer"), no solo ícono — el `title` se mantiene como
  tooltip adicional con más detalle, no como única fuente de información.
- Colores distintos por función: violeta para "ingresar" (acceder a algo ya
  existente), verde para "invitar" (crear/agregar). Se usan tonos suaves de
  fondo (10-16% opacidad) con texto en el tono fuerte correspondiente, no
  botones sólidos — para no competir visualmente con el botón primario real
  de la pantalla ("Guardar ruta"/"Agregar a la ruta").

`frontend/admin/css/rutas.css`
- Nuevas clases `.ruta-chofer-acciones`, `.btn-chofer-accion`,
  `.btn-chofer-accion--ingresar`, `.btn-chofer-accion--invitar`.
- Responsive: en pantallas angostas (`max-width:640px`) los botones pasan a
  columna y se centran.
- Bump de cache-busting `rutas.css?v=196` → `?v=197` en `rutas.html`.

## Por qué no colisiona con el reskin Gentelella
`rutas-gentelella.css` sobreescribe con `!important` las clases
`.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-quitar`,
`.btn-remito`/`.btn-exportar` y `.btn--ghost`. Las clases nuevas
(`.btn-chofer-accion*`) no coinciden con ninguna de esas — no hacía falta
tocar `rutas-gentelella.css`, los colores se ven igual con o sin el reskin
activo.

## Verificación
- JS embebido de `rutas.html` (2 bloques inline) → `node --check` OK.
- Conteo de `<div>` abiertos vs. cerrados en el archivo completo: 230/230
  (balanceado tras mover el cierre del `.ruta-form-grid` y agregar el nuevo
  bloque).
- Confirmado que `onclick="ingresarComoChofer()"` y
  `onclick="abrirModalInvitarChofer()"` quedaron intactos — mismo
  comportamiento de siempre (magic link del chofer y modal de invitación
  respectivamente), solo cambió la presentación visual.
