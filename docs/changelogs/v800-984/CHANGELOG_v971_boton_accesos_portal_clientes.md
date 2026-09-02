# v971 — Botón "Accesos al portal" en la página de Clientes

## Resumen

La función de dar/revocar acceso al portal de pedidos existía solo como un
botón llave por fila, dentro de la tabla de clientes — poco visible y había
que ubicar primero al cliente en la lista para llegar a ella. Se agregó un
botón dedicado "Accesos al portal" junto a "Nuevo cliente", en el header de
la página, que abre un modal con el listado completo de clientes y permite
dar o revocar el acceso de cualquiera desde un solo lugar, con buscador por
nombre o email.

## Cambios

### `frontend/admin/clientes.html`
- Nuevo botón `#btn-accesos-portal` en el header, a la izquierda de "Nuevo
  cliente", con el mismo ícono de llave que ya se usaba en la tabla.
- Nuevo modal `#modal-accesos-portal-overlay` ("Accesos al portal de
  clientes"): buscador (`#input-busqueda-accesos-portal`) + listado
  (`#lista-accesos-portal`) con nombre, email y el mismo botón-toggle
  `.btn-portal` por cliente. `z-index: 9998`, por debajo del modal de
  generación de acceso individual (`9999`) para que este último quede
  siempre por encima si se abre desde adentro.

### `frontend/admin/js/clientes.js`
- `abrirModalAccesosPortal()` / `cerrarModalAccesosPortal()`: abren/cierran
  el modal nuevo.
- `cargarAccesosPortal()`: trae `id, nombre_fantasia, razon_social, email,
  usuario_id, activo` de `clientes` filtrado por `empresa_id`, ordenado por
  `razon_social`.
- `renderListaAccesosPortal()`: filtra en memoria por nombre/razón
  social/email (buscador local, sin round-trip) y pinta cada fila con el
  botón toggle — reutiliza el mismo estilo `.btn-portal` / `.btn-portal--
  activo` de la tabla principal.
- `gestionarAccesoPortalDesdeModal()`: delega en la función existente
  `gestionarAccesoPortal()` (la misma que usa el botón llave de la tabla,
  sin duplicar lógica de generar/revocar) y después recarga la lista para
  reflejar el cambio sin cerrar el modal.
- Todo el HTML dinámico pasa por `escHtml()` / `escOnclickArg()`, y el
  toggle por `btnAsyncClick()` — mismos guards de seguridad que ya tenía el
  botón original.

## Por qué reutilizar `gestionarAccesoPortal()`

No se duplicó la lógica de generación de contraseña / mensaje de WhatsApp /
revocación: el modal nuevo es una segunda puerta de entrada a la misma
función que ya usaba el botón llave por fila. Si un cliente no tiene acceso
y se da acceso desde el modal nuevo, se abre el mismo sub-modal de
"Generar acceso y mensaje WhatsApp" (`#modal-portal-overlay`) de siempre.

## Verificación

- `node --check frontend/admin/js/clientes.js` — sin errores de sintaxis.
- Etiquetas `<div>` balanceadas en `clientes.html` (160 apertura / 160
  cierre) tras el agregado del modal.
- No se tocó ninguna función existente de la tabla ni del modal de acceso
  individual — solo se agregó código nuevo y un botón/listado que los
  invoca.

## Pendiente / a probar en caliente

- Probar visualmente el modal en mobile (el listado tiene `max-height:85vh`
  con scroll interno — no se verificó en viewport angosto).
