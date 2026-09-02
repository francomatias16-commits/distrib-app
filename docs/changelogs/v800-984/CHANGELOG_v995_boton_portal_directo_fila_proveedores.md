# v995 — "Portal" pasa de estar detrás del "⋮" a ser un botón directo en la fila (proveedores.html)

## Contexto

En `frontend/admin/proveedores.html`, cada fila/tarjeta de proveedor tenía
tres acciones visibles (Editar / Dar de baja / "⋮") y el menú "⋮" escondía
"Compras" y "Portal". "Portal" es la acción de generar/reenviar el link de
autogestión del proveedor (Innovación #10, "Vidriera Inversa") y se usa con
bastante más frecuencia que "Compras" — vivía poco visible detrás del kebab,
justo la misma acción que en v994 tuvo un bug de que no respondía al toque
en mobile por quedar tapada.

## Cambio

**`frontend/admin/js/proveedores.js`**:
- `renderTabla()`: agrega el botón `Portal` (`btn-tabla`, `onclick="abrirPortal(...)"`)
  directo en la fila, entre "Editar" y "Dar de baja"/"Activar".
- `iniciarMenuAccionesProveedor()`: el menú flotante "⋮" ahora arma solo la
  opción "Compras" — "Portal" salió de ahí. La lógica de `abrirPortal()` en
  sí (fetch del link, modal, WhatsApp) no se tocó.

## Fuera de alcance

- "Compras" se queda en el menú "⋮" — no se pidió sacarlo también.
- No se tocó el fix de z-index de v994 (`--z-overlay-critical` en
  `#menu-acciones-proveedor`) — sigue aplicando igual para "Compras".

## Verificación

- `node --check` sobre `proveedores.js` y el page object de e2e: sin
  errores de sintaxis.
- Revisado el resto del codebase por otras referencias a "Portal" dentro
  del menú "⋮" de proveedores: no hay otro lugar que lo invoque desde ahí.
- Actualizado `tests/e2e/page-objects/admin/proveedores.page.js`: se quitó
  `botonMenuPortal` (dropdown-item) y se agregó `botonPortal(id)` como
  `button.btn-tabla` directo en la fila; `abrirPortalFila()` ahora clickea
  ese botón sin pasar por el kebab. El spec (`proveedores.spec.js`) no
  necesitó cambios porque ya usaba `abrirPortalFila()` como abstracción.
- No verificable en este entorno: correr el suite de Playwright real
  (no hay browsers instalados/descargables en este sandbox) para confirmar
  visualmente que el botón se ve bien espaciado junto a Editar/Dar de baja
  en mobile (cards apiladas) y no rompe el layout de `fila-acciones`.
