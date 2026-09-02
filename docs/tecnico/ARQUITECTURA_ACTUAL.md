# Arquitectura actual y deuda técnica de escalabilidad

> Generado a partir de un barrido automatizado del código (25/08/2026), como
> parte de la reorganización del proyecto. No reemplaza una auditoría de
> código completa — es un mapa de puntos de partida concretos para decidir
> qué priorizar.

## 1. Capas del backend

```
api/            → Serverless Functions de Vercel (rutas HTTP, mapeadas 1:1 por vercel.json)
lib/handlers/   → Lógica de negocio por dominio (pedidos, pagos, stock, etc.)
lib/repos/      → Capa de acceso a datos (Supabase), meta de la migración Fase 7
lib/            → Utilidades transversales (auth, email, asistente IA, export contable)
supabase/       → Migraciones SQL + Edge Functions
```

La migración de acceso directo a Supabase (`supabase.from(...)` disperso en
los handlers) hacia una capa de repos dedicada (`lib/repos/*.js`) es el eje
central de escalabilidad del backend. Quedó documentada en
`docs/planes/FASE7_PLAN_ARRANQUE.md` y su rastro está en
`docs/changelogs/v600-799/` y `docs/changelogs/v800-984/` (prefijo
`fase7_*`).

**Corrección sobre la versión anterior de este documento:** el primer barrido
usó `grep -c "\.from("` sin distinguir el patrón — eso cuenta también
`Buffer.from(...)` (conversión de base64) y `supabase.storage.from('bucket')`
(subida de archivos a Storage), que no son deuda técnica ni acceso a tablas.
Repetido con un patrón que aísla específicamente `supabase.from(`/`sb.from(`/
`db.from(` fuera de `lib/repos/`, y excluyendo `storage.from(`:

**Resultado: 0 llamadas directas a tablas fuera de la capa de repos en
ningún handler**, incluido `pedidos.js`. La migración de la Fase 7
(`FASE7_PLAN_ARRANQUE.md`) está completa en la capa de acceso a datos —
simplemente ningún changelog lo declaró cerrado explícitamente, por eso
constaba como "pendiente" en el rastro histórico.

## 2. Archivos más grandes (candidatos a modularizar)

Un archivo grande no es un bug, pero dificulta el onboarding y aumenta el
costo de cada cambio. Los de mayor tamaño hoy:

**Backend (`lib/`):**
1. ~~`lib/asistente-tools.js` — 5973 líneas~~ — **partido (25/08/2026)** en
   `lib/asistente-tools/`: 16 archivos por dominio + `_constantes.js`,
   `_helpers.js` e `index.js` como orquestador. `lib/asistente-tools.js`
   quedó como barrel de 18 líneas (re-exporta desde la carpeta nueva), así
   que los 9 importadores existentes no necesitaron cambios. Ver detalle
   en la sección 5.
2. ~~`lib/handlers/pedidos.js` — 3492 líneas~~ — **partido (25/08/2026)** en
   `lib/handlers/pedidos/`: 9 archivos por dominio (`_helpers`,
   `notificaciones`, `pedido-sugerido`, `crear-pedido`, `confirmar-pedido`,
   `presupuestos`, `remito`, `chofer`, `devoluciones`) + `index.js` como
   orquestador. `lib/handlers/pedidos.js` quedó como barrel de 21 líneas
   (mismo criterio que `lib/asistente-tools.js`). Ver detalle en la
   sección 7.
3. `lib/handlers/migracion.js` — 3356 líneas
4. `lib/handlers/notif.js` — 2853 líneas
5. `lib/handlers/pagos.js` — 2671 líneas

**Frontend (`frontend/admin/js/`):**
1. ~~`pos.js` — 3595 líneas~~ — **partido (25/08/2026)** en
   `frontend/admin/js/pos/`: 12 archivos por sección, cargados como
   `<script>` clásicos en el mismo orden que ocupaban en el archivo
   original. Ver sección 6.
2. ~~`migracion.js` — 2631 líneas~~ — **partido (25/08/2026)** en
   `frontend/admin/js/migracion/`: 10 archivos por sección, mismo
   mecanismo. Ver sección 6.
3. ~~`productos.js` — 2377 líneas~~ — **partido (25/08/2026)** en
   `frontend/admin/js/productos/`: 12 archivos por sección, mismo
   mecanismo que `pos.js`/`migracion.js`. Ver sección 8.
4. ~~`clientes.js` — 2194 líneas~~ — **partido (25/08/2026)** en
   `frontend/admin/js/clientes/`: a diferencia de `pos.js`/`migracion.js`/
   `productos.js` (scripts clásicos), este se cargaba como
   `<script type="module">` — el split usa ES modules de verdad
   (`import`/`export`), no concatenación de scope global. Ver sección 9.
5. `stock.js` — 2097 líneas

## 3. Por qué no se movieron/partieron archivos de código en esta ronda

`vercel.json` (39 KB) define rewrites explícitos que probablemente atan
rutas a paths de archivo dentro de `api/`. Mover o partir archivos de
`lib/`/`api/` sin correr la suite de tests contra un entorno con Supabase
real puede romper imports o rutas de forma silenciosa. Esta sesión reorganizó
lo que es seguro reorganizar sin riesgo de romper producción (documentación,
changelogs) y dejó **mapeado y cuantificado** lo que falta para la parte de
código, para abordarlo en una siguiente ronda con tests corriendo en vivo.

## 4. Próximos pasos sugeridos (orden de prioridad)

1. ~~Cerrar el refactor de `pedidos.js`~~ — **ya está cerrado** (ver
   corrección arriba). Se documentó formalmente para que deje de aparecer
   como pendiente en futuros barridos.
2. ~~Partir `lib/asistente-tools.js`~~ — **ya está cerrado** (ver sección 5).
3. ~~Modularizar `frontend/admin/js/pos.js` y `migracion.js`~~ — **ya está
   cerrado** (ver sección 6).
4. ~~Modularizar `frontend/admin/js/productos.js`~~ — **ya está cerrado**
   (ver sección 8).
5. ~~Modularizar `frontend/admin/js/clientes.js`~~ — **ya está cerrado**
   (ver sección 9).

Con esto, los 5 archivos más grandes originales del proyecto (backend y
frontend) quedaron partidos. El siguiente candidato natural para una
próxima ronda es `frontend/admin/js/stock.js` (2097 líneas) — no
urgente, documentado en la sección 2 para cuando se priorice.

Cada uno de estos puntos es chico y verificable por separado (correr tests,
confirmar, seguir) — evitando el patrón de "refactor grande de una sola vez"
que generó parte de la deuda de changelogs sueltos sin cierre documentado.

## 5. Split de `lib/asistente-tools.js` (25/08/2026)

El archivo (5973 líneas, 98 tools del asistente por voz/IA) quedó partido
por dominio en `lib/asistente-tools/`:

- 16 archivos de dominio: `clientes`, `pedidos`, `stock`, `pos`,
  `facturacion`, `cobranzas`, `cheques-bcra`, `precios`, `automatizacion`,
  `conciliacion-bancaria`, `notificaciones`, `proveedores`, `logistica`,
  `admin`, `export-contable`, `liquidacion`.
- `_constantes.js` y `_helpers.js` — compartidos entre dominios (las
  helpers se mantuvieron juntas, sin repartir, porque varias son usadas
  por tools de más de una categoría).
- `index.js` — junta las 98 tools en el mismo orden que el archivo
  original y reexpone el motor (`esquemaParaGemini`, `esquemaParaOpenAI`,
  `seleccionarToolsRelevantes`, `ejecutarTool`, `resolverAccionPendiente`)
  sin cambios de comportamiento.

`lib/asistente-tools.js` quedó como barrel de 18 líneas que re-exporta
desde `lib/asistente-tools/index.js` — los 9 archivos que lo importaban
(`asistente.js`, `permisos-service.js`, `pedidos.js`, etc.) no necesitaron
ningún cambio.

**Verificación:** las 98 tools se compararon byte a byte contra el archivo
original (cero faltantes, cero duplicados, cero contenido alterado);
`node -e "import(...)"` en runtime confirmó `TOOLS.length === 98`, sin
duplicados, y las 6 funciones públicas exportadas correctamente; y la
suite completa de tests (`npm run test`, vitest) corrió en verde tras el
split: **72 archivos de test, 1185 tests, todos pasando**.

## 6. Split de `pos.js` y `migracion.js` (25/08/2026)

A diferencia del split de `lib/asistente-tools.js` (módulos ES con
`import`/`export`), estos dos son scripts clásicos cargados directamente
por `<script src="...">` en su HTML — sin bundler ni módulos. El split
preserva ese mecanismo: cada pieza es un `<script>` clásico más, cargado
en el mismo orden que ocupaba esa sección en el archivo original. Como los
scripts clásicos de una misma página comparten el scope global (las
variables `let`/`const` de nivel superior de un `<script>` son visibles
para los `<script>` que se cargan después), partir el archivo en el mismo
orden es funcionalmente idéntico a tenerlo en un solo archivo — no hizo
falta agregar ningún mecanismo de import/export ni tocar una sola línea de
lógica.

**`pos.js`** (3595 líneas) → `frontend/admin/js/pos/`, 12 archivos:
`nucleo`, `atajos-teclado`, `turnos-caja`, `busqueda-favoritos`, `carrito`,
`cliente-cobro`, `ticket-facturacion`, `admin-ventas-stock`,
`cliente-rapido-alertas`, `devoluciones-promos`, `offline-hooks`,
`hardware-config`. `pos.html` actualizado con los 12 `<script>` en orden.

**`migracion.js`** (2631 líneas, con `'use strict'`) →
`frontend/admin/js/migracion/`, 10 archivos: `nucleo-navegacion-api`,
`checklist-historial`, `parseo-archivo-base`,
`parseo-formatos-estructurados`, `encabezados-mapeo`, `plantillas-mapeo`,
`revision-filas`, `confirmacion-lote`, `columnas-sin-mapear-reintentos`,
`utils-superadmin-init`. Cada archivo repite la directiva `'use strict'`
en su propio header, porque el pragma es por-script — el original la
tenía una sola vez porque era un solo script. `migracion.html` actualizado
con los 10 `<script>` en orden.

En ambos casos el archivo monolítico original se eliminó (no quedó un
barrel, a diferencia del backend — un `<script>` no puede "reexportar"
otro; el propio HTML hace de orquestador con la lista ordenada de tags).

**Verificación:**
- Contenido de ambos splits comparado contra el original: **byte a byte
  idéntico** en `pos.js` (las únicas líneas nuevas son los headers de cada
  archivo nuevo); en `migracion.js`, idéntico salvo líneas en blanco de
  separación entre secciones (sin alteración de código).
- Sintaxis de los 22 archivos generados validada con `node --check` — OK
  en todos.
- `node scripts/check-asset-wiring.js`: 0 referencias rotas en las 80
  páginas del frontend (recorre `vercel.json` con las mismas reglas de
  rewrite que producción).
- `node scripts/smoke-test-frontend.js`: el script no reconocía el "JS
  propio" de una página cuando vive en una carpeta (`js/<page>/*.js`) en
  vez de un único archivo (`js/<page>.js`) — se corrigió para soportar
  ese patrón (concatena los archivos de la carpeta antes de chequear el
  uso de globals de `ui-utils.js`). Con el fix, `pos` y `migracion` pasan
  el chequeo igual que las páginas de un solo archivo.
- Suite completa de tests (`npm run test`, vitest) corrida de nuevo tras
  ambos splits: **72 archivos, 1185 tests, todos pasando** — misma
  cantidad exacta que antes del split, sin ninguna regresión.

## 7. Split de `lib/handlers/pedidos.js` (25/08/2026)

Mismo criterio que el split de `lib/asistente-tools.js` (módulos ES con
`import`/`export`, mapeo de call-sites cruzados antes de mover una sola
línea). El archivo (3492 líneas) quedó partido por dominio en
`lib/handlers/pedidos/`:

- `_helpers.js` — helpers internos compartidos entre `chofer.js` y
  `devoluciones.js`: `sincronizarEstadoRuta`, `hoyArgentina`,
  `validarImagenReal` (antes privados del archivo único, ahora exportados
  para poder compartirse entre los dos módulos que los usan).
- `notificaciones.js` — avisos de pedido: `notificarEstado`,
  `notificarDespachoPorEmail`, `_logNotif` (privado), `notificarPedidoConfirmado`,
  `acreditarPuntos`, `notificarPushPedidoConfirmado`, `notificarPushAdmin`.
- `pedido-sugerido.js` — ruta pública sin login (link de WhatsApp):
  `verPedidoSugeridoHandler`, `confirmarPedidoSugeridoHandler`.
- `crear-pedido.js` — `crearPedidoParaCliente` (lógica compartida
  cliente/admin) y `crearPedidoAdminHandler`.
- `confirmar-pedido.js` — `confirmarPedidoHandler` (confirmación desde el
  portal cliente).
- `presupuestos.js` — absorto desde `api/presupuestos/index.js`:
  `crearPresupuestoParaCliente`, `handlePresupuestos`.
- `remito.js` — absorto desde `api/remito-nro/index.js`:
  `handleRemitoNro`.
- `chofer.js` — portal del chofer (`/api/chofer/*`, el módulo más grande,
  566 líneas): `pedidoEsDeEsteChofer` (privado), `handleChofer`.
- `devoluciones.js` — `crearDevolucionCore` (compartida entre chofer y
  admin) y `handleDevolucionesAdmin`.
- `index.js` — dispatcher HTTP principal de `/api/pedidos` (sub-ruteo por
  `_svc` + GET/PATCH/DELETE del recurso pedido en sí) y reexportación de
  la API pública del módulo.

Cada archivo quedó con sus propios imports desde `lib/repos/pedidos.js` y
demás dependencias (solo lo que su porción de código usa realmente, en vez
de heredar el import gigante original de ~150 identificadores), más los
imports cruzados entre sub-módulos donde correspondía (ej. `chofer.js`
importa `crearDevolucionCore` de `devoluciones.js`; `confirmar-pedido.js`
importa las notificaciones de `notificaciones.js`). Tres funciones que
antes eran privadas del archivo único (`sincronizarEstadoRuta`,
`hoyArgentina`, `validarImagenReal`) se exportaron desde `_helpers.js`
porque pasaron a compartirse entre dos módulos distintos; el resto de las
funciones que cruzan de módulo (`crearPedidoAdminHandler`,
`handlePresupuestos`, `handleRemitoNro`, `handleChofer`,
`handleDevolucionesAdmin`, `verPedidoSugeridoHandler`,
`confirmarPedidoHandler`, `notificarDespachoPorEmail`,
`notificarPushPedidoConfirmado`, `notificarPushAdmin`) se exportaron por
el mismo motivo, aunque antes eran privadas.

`lib/handlers/pedidos.js` quedó como barrel de 21 líneas que reexporta
`default` + los 8 named exports originales (`ROLES_ADMIN`,
`confirmarPedidoSugeridoHandler`, `crearPedidoParaCliente`,
`notificarEstado`, `notificarPedidoConfirmado`, `acreditarPuntos`,
`ROLES_ADMIN_PRES`, `crearPresupuestoParaCliente`, `crearDevolucionCore`)
desde `lib/handlers/pedidos/index.js` — los 19 archivos que lo importaban
(16 tools de `lib/asistente-tools/`, `lib/eventos-listeners/pedido_creado.js`,
`api/index.js`, y el test de regresión de `notificarEstado`) no
necesitaron ningún cambio.

**Verificación:** el contenido de los 9 archivos de dominio + `index.js`
se comparó contra el archivo original línea por línea — **cuerpo de cada
función byte a byte idéntico**, sin alteración de lógica; las únicas
diferencias son los imports (recalculados por archivo, ya no uno solo
gigante), los headers de cada archivo nuevo, y la palabra `export` añadida
a las 13 funciones que pasaron a compartirse entre módulos. Sintaxis de
los 11 archivos validada con `node --check` — OK en todos. Import real en
runtime (`node -e "import('./lib/handlers/pedidos.js')"`) confirmó los 9
exports nombrados + el default, todos resolviendo sin error de ciclo ni de
path. Suite completa de tests (`npx vitest run`) corrida tras el split:
**72 archivos, 1185 tests, todos pasando** — misma cantidad exacta que
antes del split, sin ninguna regresión (incluido el test de regresión de
`notificarEstado`, que la importa directo desde el barrel).

## 8. Split de `frontend/admin/js/productos.js` (25/08/2026)

Mismo mecanismo que el split de `pos.js`/`migracion.js` (sección 6):
script clásico cargado por `<script src="...">` en `productos.html`, sin
bundler ni módulos — el split preserva ese mecanismo, cada pieza es un
`<script>` clásico más, cargado en el mismo orden que ocupaba esa sección
en el archivo original, repitiendo `'use strict'` en cada uno (el pragma
es por-script).

**`productos.js`** (2377 líneas) → `frontend/admin/js/productos/`, 12
archivos: `nucleo-estado` (cliente Supabase, estado global, paleta,
utilidades de formato), `carga-datos` (RPC fn_productos_lista,
contadores, categorías, depósitos), `filtros-menu`, `render-tabla`,
`seleccion-etiquetas` (barra flotante "Generar etiquetas"),
`orden-busqueda-nav` (orden de columnas, topbar, alertas, meses,
búsqueda/escáner), `modal-producto` (el más grande, 444 líneas — alta/
edición, foto, autocompletado, categoría rápida), `categorias-abm`,
`guardar-eliminar-producto`, `init-vistas` (init, toggle Productos/
Combos, DOMContentLoaded), `receta-bom`, `auto-imagenes` (414 líneas —
auto-carga de fotos vía banco de códigos/Serper). `productos.html`
actualizado con los 12 `<script>` en orden; el archivo monolítico
original se eliminó (no queda barrel, igual que `pos.js`/`migracion.js`).

**Verificación:**
- Contenido comparado contra el original: **byte a byte idéntico** (las
  únicas líneas nuevas son los headers de cada archivo nuevo y el
  `'use strict'` repetido).
- Sintaxis de los 12 archivos validada con `node --check` — OK en todos.
- `node scripts/check-asset-wiring.js`: 0 referencias rotas en las 80
  páginas del frontend.
- `node scripts/smoke-test-frontend.js`: `productos` pasa OK (el script ya
  soportaba el patrón de carpeta desde el fix hecho para `pos`/
  `migracion`).
- Suite completa de tests (`npx vitest run`) corrida tras el split: **72
  archivos, 1185 tests, todos pasando** — misma cantidad exacta que antes
  del split, sin ninguna regresión.


## 9. Split de `frontend/admin/js/clientes.js` (25/08/2026)

A diferencia de `pos.js`/`migracion.js`/`productos.js` (scripts clásicos
concatenados en scope global), `clientes.js` se cargaba como único
`<script type="module">` en `clientes.html`. El split usa ES modules de
verdad (`import`/`export`), no la técnica de "un `<script>` por sección"
de los splits anteriores.

**`clientes.js`** (2194 líneas) → `frontend/admin/js/clientes/`, 16
archivos: `_estado` (estado global compartido del módulo), `_helpers`
(utilidades chicas sin estado), `nucleo` (cliente Supabase, init, wiring
`window.xxx`), `carga-listado` (RPC de listado, contadores, filtros
persistidos, `window.crearZonaRapida`), `filtros-render`, `modal-cliente`,
`guardar-cliente`, `direcciones`, `precios-especiales`, `listas-precio`,
`cta-cte-historial`, `score-cliente` (incluye `renderAlertasScorePanel`),
`geocodificacion`, `portal-cliente`, `exportar-excel`, e `index.js` como
orquestador: es el único `<script type="module">` que carga
`clientes.html`, importa los 15 archivos de dominio restantes (lo que
dispara sus efectos de carga) y centraliza el wiring `window.xxx = xxx`
que antes vivía repartido en el archivo original.

Import circular entre algunos pares (`nucleo.js` ↔ `geocodificacion.js`,
`carga-listado.js` ↔ `filtros-render.js`) es esperado y seguro: ES modules
soportan ciclos siempre que el binding importado se use solo dentro de un
cuerpo de función (runtime), nunca en el nivel superior del módulo durante
su evaluación — es el caso en los 14 archivos de dominio de este split.

`clientes.html` actualizado: el único `<script type="module">` ahora
apunta a `frontend/admin/js/clientes/index.js`; el archivo monolítico
original se eliminó (no queda barrel, igual que los splits anteriores).

**Verificación:**
- `tests/frontend/clientes.test.js` (regresión XSS del panel de alertas de
  score, hallazgo #16) migrado para cargar `score-cliente.js` vía import
  dinámico real de Node (en vez de `vm.runInContext`, que no soporta
  sintaxis `import`/`export`) — sigue pasando contra el módulo partido.
- Sintaxis de los 16 archivos validada.
- `node scripts/check-asset-wiring.js` y `node scripts/smoke-test-frontend.js`:
  sin referencias rotas tras el cambio de `clientes.html`.
