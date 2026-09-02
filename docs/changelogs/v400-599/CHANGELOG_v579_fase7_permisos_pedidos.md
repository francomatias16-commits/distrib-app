# v579 — Fase 7, sección 2: `pedidos.js` migrado a PermisosService (helper `rolesDe` + 4 gates)

Continuación del trabajo de permisos sobre `notif.js` (whatsapp_panel,
whatsapp_onboarding, notif_estado_cuenta — zip `v578`). Con `notif.js`
cerrado, quedaba solo `pedidos.js`/`pos.js` reservados para el paso
grande final (ver `FASE7_PLAN_ARRANQUE.md`, sección 2). Este changelog
cubre `pedidos.js`; `pos.js` queda para una entrega aparte por volumen
(5 constantes `ROLES_*`, ~37 sitios de uso — mismo criterio que ya
frenó una migración conjunta de los dos módulos).

## Qué se hizo

- **Nuevo helper `rolesDe(recurso, accion)`** en `lib/permisos-service.js`
  — devuelve el array de roles tal cual está en `REGLAS`, mismo
  fail-closed que `puede()` (revienta si `recurso`/`accion` no existen).
  Necesario porque `pedidos.js` tenía dos constantes `export const`
  (`ROLES_ADMIN`, `ROLES_ADMIN_PRES`) reimportadas con alias desde
  `lib/asistente-tools.js` (`ROLES_PEDIDO`, `ROLES_PRESUPUESTO`) — no
  alcanzaba con `puede()`, que solo evalúa, hacía falta poder seguir
  exportando el array como valor.
- **`pedidos`** — replica `ROLES_ADMIN` de `pedidos.js`: handler
  principal, `crearPedidoAdminHandler` y `handleDevolucionesAdmin` (las
  3 usaban la misma constante) → un único gate (`acceder`). `pedidos.js`
  sigue exportando `ROLES_ADMIN`, ahora como `rolesDe('pedidos',
  'acceder')` — no rompe el import de `asistente-tools.js`. Los 3 gates
  internos usan `puede()` directo, no el array reexportado.
- **`presupuestos`** — replica `ROLES_ADMIN_PRES` de `handlePresupuestos`
  → `acceder`. Mismo patrón de reexport (`asistente-tools.js` la
  reimporta como `ROLES_PRESUPUESTO`). El acceso de solo-lectura a rol
  `cliente` (`esCliente`, literal) se deja tal cual, fuera de la tabla —
  mismo criterio que `facturas`.
- **`remitos`** — replica `ROLES_PERMITIDOS` local (no exportada) de la
  sección "Remito NRO" (`_svc=remito-nro`) → `acceder`.
- **`pedidos_chofer`** — replica `ROLES_CHOFER` local (no exportada) de
  la sección "Portal del chofer" (`_svc=chofer`) → `acceder`. El segundo
  chequeo de esa misma función (`esAdmin =
  ['dueno','admin'].includes(perfil.rol)`, regla de "dueño del dato" para
  decidir si el admin opera pedidos de cualquier chofer o solo los
  propios) no es un gate de acceso al endpoint — se deja tal cual, igual
  criterio que `esCliente` en `facturas`/`presupuestos`.
- `lib/permisos-service.js` — 4 entradas nuevas en `REGLAS` + helper
  `rolesDe`.
- `tests/permisos-service.test.js` — sumados los 4 recursos nuevos (28
  casos) más cobertura de `rolesDe` (incluyendo su propio fail-closed).
- `node --check` OK en los archivos tocados; `grep ROLES_ADMIN\b\|
  ROLES_ADMIN_PRES\|ROLES_PERMITIDOS\|ROLES_CHOFER lib/handlers/pedidos.js`
  → solo quedan las 2 líneas de reexport (`rolesDe(...)`), cero
  constantes literales viejas. Suite completa: 496/496 OK (25 archivos).

## Qué queda

- `pos.js` — 5 constantes (`ROLES_VENTA`, `ROLES_TRANSFERIR`,
  `ROLES_ANULAR`, `ROLES_FACTURAR`, `ROLES_ADMIN_CAJAS`) en ~37 sitios,
  ninguna reexportada ni importada desde otro archivo (autocontenido).
  Cierra la sección 2 del plan de Fase 7 una vez migrado.
