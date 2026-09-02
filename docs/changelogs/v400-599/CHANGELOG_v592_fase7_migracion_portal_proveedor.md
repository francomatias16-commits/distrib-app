# v592 — Fase 7, orden de migración pedido por el usuario: `portal_proveedor` — CERRADO

Arranca el lote de módulos pendientes de Fase 7 en el orden pedido:
`portal_proveedor` (16) → `cc_proveedores` (16) → `automatizacion` (16) →
`stock-auto` (13) → `maestros` (13) → `chofer_invitacion` (12) →
`usuarios` (9) → puñado chico (<10 usos c/u).

Primer módulo: `portal_proveedor.js` (16 `.from()`/`.rpc()` directos, el
handler de autogestión de proveedores — "Vidriera Inversa").

## Qué se hizo

**`lib/repos/portal-proveedor.js` (nuevo)** — 14 funciones, cubre las dos
superficies del handler:

- Admin (autenticado): `obtenerProveedorParaLink`, `insertarTokenPortal`,
  `listarTokensPortal`, `revocarTokenPortal`.
- Público (token de URL, sin JWT de Supabase): `validarTokenPortalRpc`
  (envuelve la única RPC del handler, `validar_token_portal_proveedor`,
  mismo criterio que admin.js/facturas.js/compras.js — es 1 sola RPC, no
  20+ como en migracion.js, así que sí se envuelve), `obtenerProveedorPortal`,
  `obtenerNombreEmpresa`, `listarOrdenesCompraProveedor`,
  `listarFacturasProveedorPortal`, `obtenerOrdenCompraParaConfirmar`,
  `actualizarFechaEsperadaOrden`, `obtenerOrdenCompraParaFactura`,
  `insertarFacturaProveedorPortal`, `listarNotificacionesProveedor`.

**`lib/repos/index.js`** — se agregó `PortalProveedorRepo` al barrel.

**`lib/handlers/portal_proveedor.js`** — los 16 `.from()`/`.rpc()` directos
originales pasan por el repo de arriba, sin cambio de comportamiento
observable: se replicó tal cual la política de error de cada query
(silenciosa vs. propagada) — por ejemplo `obtenerProveedorPortal` y
`listarFacturasProveedorPortal` ignoran el error igual que el original
(degradan la portada del portal en vez de romperla), mientras que
`insertarTokenPortal`, `listarTokensPortal`, `revocarTokenPortal`,
`listarOrdenesCompraProveedor`, `actualizarFechaEsperadaOrden` e
`insertarFacturaProveedorPortal` lo propagan porque el original hacía
chequeo explícito de `error`. La subida a Storage (bucket
`facturas-proveedor`) queda en el handler, mismo criterio que el bucket
`logos` de `empresas.js` — no es una tabla.

Hallazgo corregido de paso (mismo criterio que el filtro `empresa_id`
agregado en `cta-cte.js`/`empresa.js`): `obtenerProveedorPortal` (usado en
`verPortal`, la portada pública del portal) solo filtraba por `id`, sin
`empresa_id` — no explotaba porque `proveedor_id` ya llega resuelto y
validado por el token contra esa misma empresa vía la RPC
`validar_token_portal_proveedor`, pero rompe la regla de Fase 7 de no
confiar en un solo id como barrera. Se agregó el filtro.

## Verificación

- `grep -c "\.from(\|\.rpc(" lib/handlers/portal_proveedor.js`: 3
  (`Buffer.from`, `.storage.from` × 2 — ninguno es tabla, todos fuera de
  alcance por diseño). 0 accesos directos a tablas/RPCs de negocio.
- Sintaxis válida (`node --check`) en handler y repo.
- Tests nuevos: `tests/repos/portal-proveedor.test.js` (29 casos — no
  existía cobertura de repo para este módulo). Foco en aislamiento por
  `empresa_id`/`proveedor_id` en cada función de la superficie pública, y
  en la política de error silenciosa vs. throw de cada una.
- Suite completa: **736/742 OK** (713 previos + 29 nuevos). Las 6 fallas
  restantes son preexistentes y no relacionadas — `tests/handlers/admin-permisos.test.js`
  hace timeout contra una URL de Supabase falsa en este entorno sandbox (red
  restringida a una allowlist de dominios); mismas 6 fallas confirmadas
  *antes* de tocar `portal_proveedor`, por lo tanto sin regresión.

## Próximo paso

Sigue `cc_proveedores` (16 usos), según el orden pedido.
