# v576 — Fase 7, sección 2: `admin.js`, `auto-imagenes.js`, `clientes.js` y `empresa.js` migrados a PermisosService

Continuación de `CHANGELOG_v575_fase7_permisos_busqueda_ciclos.md`.
Séptimo a décimo módulo migrados — los cuatro candidatos autocontenidos de
gate único que quedaban señalados en la ronda anterior.

## Qué se hizo

- **`admin.js`** — `ROLES_ADMIN` (compartido por los 9 `_svc` del
  dashboard admin: kpis, pedidos, stock-bajo, ventas-diarias, alertas,
  onboarding, dashboard-ejecutivo, comparativa-mensual, resumen-arranque)
  → `admin_dashboard: {acceder}`. Se llamó al recurso `admin_dashboard`
  y no `admin` a secas para no confundirse con el uso genérico de
  "admin" en el resto del sistema.
- **`auto-imagenes.js`** — `ROLES_PERMITIDOS` → `auto_imagenes:
  {ejecutar}`. Único gate para GET (contador de uso de Serper) y POST
  (búsqueda automática de imágenes).
- **`clientes.js`** — `ROLES_ADMIN` → `clientes: {acceder}`. Mismo
  contrato exacto que el original: `perfil` null → 401 ("No autorizado"),
  perfil sin el rol requerido → 403 ("Acceso solo para administradores").
  No se tocó el segundo gate hardcodeado de este mismo archivo
  (`['dueno','admin'].includes(perfil.rol)` en POST /acceso) porque no
  era un `ROLES_*` con nombre propio — queda fuera del alcance de esta
  migración, anotado para una ronda futura si se decide unificarlo.
- **`empresa.js`** — `ROLES_ADMIN` (resuelto en `requerirPerfilAdmin()`,
  compartido por logo/icon/datos/catalogo-publico) → `empresa_config:
  {acceder}`.
- `lib/permisos-service.js` — 4 entradas nuevas en `REGLAS`.
- `node --check` OK en los 5 archivos tocados; `grep ROLES_ADMIN\|
  ROLES_PERMITIDOS` → 0 en los 4 handlers.

## Tests

Ninguno de los cuatro handlers tenía cobertura previa.

- `tests/permisos-service.test.js` — ampliado con los 4 recursos nuevos.
- `tests/handlers/admin-permisos.test.js` (nuevo, 7 casos) — se probó el
  gate con un `_svc` inexistente (404 tras pasar el gate) para no tener
  que mockear la lógica de negocio de las 9 sub-rutas, que queda fuera
  del alcance de "permisos". Importante: el mock de `rateLimit` acá es
  **síncrono** (`() => () => false`, no `() => async () => false`),
  porque `admin.js` llama `limiter(req, res)` sin `await` — el
  `rateLimit` real es síncrono, pero un mock async habría devuelto una
  Promise truthy y cortado el handler en todos los tests.
- `tests/handlers/auto-imagenes-permisos.test.js` (nuevo, 7 casos) —
  ejercitado vía GET (solo lee el contador, no dispara el flujo pesado
  de búsqueda de imágenes).
- `tests/handlers/clientes-permisos.test.js` (nuevo, 7 casos) — incluye
  el caso del contrato 401 vs 403 (perfil null vs. rol no permitido),
  preservado tal cual del original.
- `tests/handlers/empresa-permisos.test.js` (nuevo, 7 casos) — ejercitado
  vía GET `_svc=datos`.

Suite completa: **338/338 OK** (286 antes de este paso + 52 nuevos: 24 de
servicio + 28 de handlers).

## Qué queda

Ya no quedan candidatos de gate único sin migrar. Lo que resta requiere
evaluar el modelo antes de migrar (2+ arrays por handler, mismo criterio
aplicado a `export_contable` en su momento):
`conciliacion-bancaria.js` (2), `maestros.js` (2), `reglas-precio.js` (2),
`cc_proveedores.js` (3), `stock.js` (3), `facturas.js` (4),
`proveedores.js` (5), `notif.js` (2 arrays + `ROLES_POR_TIPO`, un objeto
que no encaja en el modelo plano sin forzarlo). Reservados para el final:
`pedidos.js`/`pos.js` (paso 6 grande) y las 4 exclusiones por blast
radius vía `asistente-tools.js` (`usuarios.js`, `migracion.js`,
`chofer_invitacion.js`, `portal_proveedor.js`).
