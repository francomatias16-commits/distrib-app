# v575 — Fase 7, sección 2: `busqueda.js` y `ciclos.js` migrados a PermisosService

Continuación de `CHANGELOG_v574_fase7_permisos_importar_bcra.md`. Quinto y
sexto módulo migrados. Se relevaron las ~31 constantes `ROLES_*`
restantes en 18 handlers, cruzando cada nombre exportado contra
`lib/asistente-tools.js` (mismo chequeo que ya había descartado
`usuarios.js`/`migracion.js`) — el relevamiento sumó dos exclusiones más
a esa lista: **`chofer_invitacion.js`** (`ROLES_GESTION`, importado como
`ROLES_CHOFER_INVITACION`) y **`portal_proveedor.js`** (`ROLES_ESCRITURA`,
importado como `ROLES_PORTAL_PROVEEDOR`) — ambos re-exportados hacia
`asistente-tools.js`, mismo criterio de mayor blast radius. `pedidos.js`
y `pos.js` quedan fuera de esta ronda por ser el paso 6 grande del plan
(no se migran de una, ver sección 4 "Qué NO hacer").

De las constantes `const` (no exportadas, sin cross-import posible) se
eligieron los dos handlers más chicos con gate único, mismo criterio que
`importar.js`/`bcra.js` en el paso anterior:

- **`busqueda.js`** (112 líneas) — `ROLES_ADMIN` → `busqueda: {buscar}`.
  Único gate para todo el handler (búsqueda global de
  clientes/productos/pedidos/presupuestos/facturas/cheques).
- **`ciclos.js`** (205 líneas) — `ROLES_ADMIN` → `ciclos: {acceder}`.
  Único gate para GET de ciclos + sugerido pendiente y para
  enviar/descartar sugerencia por WhatsApp.

## Qué se hizo

- `lib/permisos-service.js` — 2 entradas nuevas en `REGLAS`.
- `lib/handlers/busqueda.js` — `ROLES_ADMIN.includes(perfil.rol)` →
  `puede(perfil, 'buscar', 'busqueda')`. `grep ROLES_ADMIN
  lib/handlers/busqueda.js` → 0.
- `lib/handlers/ciclos.js` — `ROLES_ADMIN.includes(perfil.rol)` →
  `puede(perfil, 'acceder', 'ciclos')`. `grep ROLES_ADMIN
  lib/handlers/ciclos.js` → 0.
- `node --check` OK en los 3 archivos tocados antes de correr la suite.

## Tests

Ninguno de los dos handlers tenía cobertura previa.

- `tests/permisos-service.test.js` — ampliado con los casos de
  `busqueda`/`ciclos`.
- `tests/handlers/busqueda-permisos.test.js` (nuevo, 7 casos) — builder
  chainable universal para mockear `.from()` (select/eq/or/ilike/limit),
  en vez de mapear cada combinación exacta de las 5 tablas consultadas en
  paralelo.
- `tests/handlers/ciclos-permisos.test.js` (nuevo, 7 casos) — mismo
  patrón de builder chainable (select/eq/gte/order/limit), necesario
  porque el handler encadena entre 3 y 5 métodos según la query
  (`ciclos_compra`, `pedidos`, `notif_log`).

Suite completa: **286/286 OK** (260 antes de este paso + 26 nuevos).

## Qué queda

Autocontenidos y sin migrar todavía: `admin.js`, `auto-imagenes.js`,
`clientes.js`, `empresa.js` (gate único, mismo patrón); y con más de un
array: `cc_proveedores.js` (3), `conciliacion-bancaria.js` (2),
`maestros.js` (2), `reglas-precio.js` (2), `stock.js` (3), `facturas.js`
(4), `proveedores.js` (5), `notif.js` (2 arrays + 1 objeto
`ROLES_POR_TIPO`, más complejo — no encaja en el modelo plano sin
evaluarlo aparte). Reservados para el final: `pedidos.js`/`pos.js` (paso
6 grande) y `usuarios.js`/`migracion.js`/`chofer_invitacion.js`/
`portal_proveedor.js` (blast radius vía `asistente-tools.js`).
