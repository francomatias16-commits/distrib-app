# Fase 7 — Capa de datos consistente (repos) + permisos cross-módulo

Arranque del `PLAN_ERP_SINCRONIZACION_2026.md`, Fase 7. Talla XL declarada
en el plan ("trabajo continuo de varios meses, módulo por módulo") — este
documento es el punto de partida: relevamiento real del estado actual,
orden de migración, y el checklist reutilizable que el plan pide como
entregable ("para no tener que rediseñar el proceso cada vez").

## 0. Estado real relevado (no estimado)

```
lib/repos/ hoy: _db.js, clientes.js, cliente-direcciones.js, empresas.js,
                conciliacion-bancaria.js, notif.js, reglas-automatizacion.js,
                reglas-precio.js, scores.js
```

Cobertura repo vs. `.from()` directos que quedan en el handler homónimo:

| Módulo | Estado |
|---|---|
| `conciliacion-bancaria` | ✅ Migrado por completo (0 directos) |
| `reglas-automatizacion` | ✅ Migrado por completo (0 directos) — Fase 6 |
| `reglas-precio` | ✅ Migrado por completo (0 directos) |
| `clientes` | ✅ Migrado por completo (0 directos) — `vincularUsuarioPortal`/`desvincularUsuarioPortal` movidos a `lib/repos/clientes.js` |
| `empresa` (handler) | ✅ Migrado por completo (0 directos) — los 4 `createClient()` propios del handler reemplazados por `db` + `verificarToken(req, db)`; sumadas `obtenerLogoUrl`/`actualizarLogoUrl`/`obtenerDatosEditables`/`actualizarDatosEmpresa` a `lib/repos/empresas.js` |
| `productos` | ✅ Migrado por completo salvo `pedidos.js`/`pos.js` — lote 2: `migracion.js`, `auto-imagenes.js` y `stock.js` sumados a los 6 del lote 1 (9 handlers, 0 directos). Quedan solo `pedidos.js`/`pos.js` (7+7), para el paso 6 grande |
| `cta_cte` | ✅ Migrado por completo (0 directos) — **cerrado hoy**: el conteo original del plan (9 handlers) resultó desactualizado, igual que pasó con `productos`/`maestros.js` — la mayoría eran comentarios o RPCs que ya encapsulan el acceso (`crear_pedido_cliente`, `aplicar_nota_credito_cta_cte`, `migracion_confirmar_cta_cte_lote`). Los únicos `.from('cta_cte')` reales estaban en `cierre.js` (4) y `notif.js` (2) |
| `notif` | ⚠️ Repo existe pero es chico (prefs/logs); el handler sigue con **71** `.from()` directos (2 menos: `cta_cte` ya migrado) |
| resto (29 handlers) | ❌ Sin repo — acceso directo a Supabase |

Handlers sin repo, ordenados por volumen de `.from()` directo (proxy de
tamaño/riesgo, no de prioridad de negocio):

```
137 pedidos        28 rutas-live      16 automatizacion   9  usuarios
 83 pos             28 facturas       14 empresa          8  piloto/export-contable/ciclos/auto-imagenes
 61 migracion       27 admin          13 stock-auto        7  busqueda/asistente
 38 stock           21 pagos          13 maestros          5  fidelizacion
 32 proveedores     19 cierre         12 chofer_invitacion 3  setup/saas/importar/auditoria
                     16 portal_prov.  10 auth              2  score
                     16 cc_proveedores
```

`cta_cte` (la tabla que más importa para consistencia contable) hoy se
toca directo desde **9 handlers distintos**: `pedidos`, `pos`, `pagos`,
`facturas`, `cierre`, `cc_proveedores`, `migracion`, `notif`, `auditoria`.
Es el ejemplo de libro del diagnóstico del plan: un cambio de esquema en
`cta_cte` obliga a tocar 9 archivos, no 1.

`productos` está disperso igual: `maestros.js` (13 usos) más otros ~18 en
`pedidos`/`pos`/`stock` — tampoco tiene dueño único.

No existe todavía ningún `PermisosService` — cada handler resuelve
`perfil.rol`/`empresa_id` a mano (típicamente vía `verificarToken(req, db)`,
pero varios además reconsultan `usuarios` por su cuenta, ver `empresa.js`
con 4 lookups de `usuarios` repetidos en distintos endpoints del mismo
archivo).

## 1. Orden de migración propuesto

Sigue el criterio del propio plan ("empezando por los que ya tienen repo
parcial... y extendiendo de a uno: productos, pedidos, stock, cta-cte"),
ajustado con los números reales de arriba:

1. **`clientes` — cerrado.** Quedaba como el pendiente más chico
   (3 usos, ligados a alta/baja de acceso portal). Sirvió de piloto para
   validar el checklist de la sección 3 antes de tocar algo grande.
2. **`empresas` — cerrado hoy.** El handler (`empresa.js`) instanciaba su
   propio `createClient()` en 4 endpoints distintos y reresolvía
   `perfil`/`rol` a mano cada vez, **sin el filtro `activo`** que sí aplica
   `verificarToken` en el resto del sistema desde la Etapa 11 de
   AUDITORIA_2026 (ver `lib/auth-helpers.js`) — un desajuste real de
   seguridad entre módulos, no solo estético. Se reemplazó por
   `db` (`lib/repos/_db.js`) + `verificarToken(req, db)`, cerrando esa
   inconsistencia sin crear el `PermisosService` todavía (eso sigue en la
   sección 2, pendiente). Repo `lib/repos/empresas.js` sumó
   `obtenerLogoUrl`/`actualizarLogoUrl`/`obtenerDatosEditables`/
   `actualizarDatosEmpresa`; la subida a Storage (bucket `logos`) queda en
   el handler porque no es una tabla. Tests nuevos en
   `tests/repos/empresas.test.js` (no existían antes) — foco en filtro por
   `empresa_id` en cada query. Suite completa: 112/112 OK.
3. **`productos` — cerrado (lote 1 + lote 2).** Al relevar el repo real (no el
   conteo original del plan) `maestros.js` resultó no tocar `productos`
   directamente — el volumen real estaba repartido en 11 handlers. Se creó
   `lib/repos/productos.js` con 6 funciones (`existeProductoParaEmpresa`,
   `listarProductosConStockMinimo`, `buscarProductos`,
   `obtenerProductosPorIds`, `obtenerCostosPorIds`,
   `obtenerProductosParaCotizarPedido`) y se migraron los 6 handlers de
   menor volumen/riesgo: `admin.js`, `automatizacion.js`, `busqueda.js`
   (cambio de contrato interno: `productos` pasa de `{ data, error }` a
   array plano, sin cambio en la respuesta HTTP), `notif.js` (solo
   `crearPedidoDesdeItemsWhatsapp`), `proveedores.js` y `stock-auto.js`.
   **Lote 2 (hoy):** se sumaron 6 funciones más
   (`listarCodigosProductosPorEmpresa`, `listarProductosSinFoto`,
   `actualizarFotoProducto`, `contarProductosSinFoto`,
   `buscarIdsProductos`, `perteneceProductoAEmpresa`,
   `obtenerProductosParaSugerencias`) y se migraron `migracion.js` (las 5
   apariciones eran idénticas — se unificaron en una sola función),
   `auto-imagenes.js` (3) y `stock.js` (3), incluyendo el caso con `.not()`
   condicional (exclusión de IDs ya intentados en la corrida) y el que
   propaga el error crudo (sin envolver) porque el handler original
   loggeaba el objeto completo. Tests nuevos/ampliados en
   `tests/repos/productos.test.js` (31 casos en total, foco en aislamiento
   por `empresa_id` y en documentar la política de error de cada función).
   Suite completa: 143/143 OK. Solo queda `pedidos.js`/`pos.js` (7+7) de
   toda la tabla `productos`, reservado para el paso 6 grande.
4. **`cta_cte` — cerrado hoy.** El relevamiento real cambió el plan: de
   los 9 handlers que mencionaban `cta_cte`, solo `cierre.js` (4 usos) y
   `notif.js` (2 usos) tenían `.from('cta_cte')` real — `pedidos.js`,
   `pos.js`, `pagos.js` la mencionan solo en comentarios (la escritura pasa
   por la RPC `crear_pedido_cliente` y por un trigger de sincronización de
   `saldo_deuda`), `facturas.js` usa la RPC `aplicar_nota_credito_cta_cte`,
   y `migracion.js` usa `migracion_confirmar_cta_cte_lote` — las tres RPCs
   ya encapsulan el acceso del lado de la base. `cc_proveedores.js` y
   `auditoria.js` no tocan la tabla en absoluto (mismo patrón que
   `maestros.js` con `productos` en el paso 3). Se creó
   `lib/repos/cta-cte.js` con 4 funciones (`obtenerUltimoSaldo`,
   `insertarMovimiento`, `listarMovimientosPorCliente`,
   `listarUltimosMovimientos`) y se migraron los 2 handlers reales a 0
   directos. Hallazgo corregido de paso (mismo criterio que el filtro
   `activo` agregado en `empresa.js`): `listarMovimientosPorCliente` no
   filtraba por `empresa_id` en el original, solo por `cliente_id` — se
   agregó el filtro. Tests nuevos en `tests/repos/cta-cte.test.js` (10
   casos). Suite completa: 153/153 OK.
5. **`stock`** (38 usos) — depende de `productos` (paso 3, ya cerrado).
6. **`pedidos`** y **`pos`** (137 + 83) — se dejan para el final a
   propósito: son el corazón transaccional del sistema. Ninguno de los dos
   se migra entero de una — ver expand-contract en el checklist.
7. **`notif`** — completar el repo existente (71 usos pendientes). No
   bloquea a nadie, pero conviene antes de migrar `pedidos`/`pos` porque
   ambos disparan notificaciones y hoy lo hacen con queries propias en
   paralelo a lo que ya centralizó la Fase 4.

El resto (`admin`, `proveedores`, `rutas-live`, `facturas`, `pagos`,
`cierre`, `portal_proveedor`, etc.) se ordena después de este primer lote,
una vez que `productos`/`cta_cte`/`stock` tengan repo — la mayoría de sus
`.from()` son sobre esas tres tablas.

## 2. `PermisosService` — piloto implementado

`lib/permisos-service.js` ya existe: `puede(perfil, accion, recurso)`
contra una tabla de reglas `{ recurso: { accion: [roles] } }`, fail-closed
(lanza si `recurso`/`accion` no están dados de alta — un typo no debe
traducirse en "sin permiso" indistinguible de un 403 legítimo).

Piloto migrado: `reglas-automatizacion.js` — los 3 arrays sueltos
(`ROLES_LECTURA`, `ROLES_ESCRITURA`, `ROLES_TAREAS`) pasaron a 2 entradas
de la tabla (`reglas_automatizacion: {leer, escribir}` y
`tareas_automatizacion: {leer, completar}`, esta última con el mismo set
de roles en ambas acciones porque el original usaba un único
`ROLES_TAREAS` para los dos endpoints — se preservó tal cual,
expand-contract). `grep ROLES_LECTURA\|ROLES_ESCRITURA\|ROLES_TAREAS
lib/handlers/reglas-automatizacion.js` → 0. Tests nuevos:
`tests/permisos-service.test.js` (unit del servicio) +
`tests/handlers/reglas-automatizacion-permisos.test.js` (15 casos — no
existía cobertura de estos 403 antes, el test hermano solo cubre el motor
de evaluación/ejecución de reglas).

**Segundo módulo (hoy): `export-contable.js`.** Autocontenido — se
verificó primero (`grep` cross-repo) que nadie más importaba
`ROLES_EXPORT_CONTABLE`/`ROLES_CONFIG`, a diferencia de `usuarios.js`
(ver más abajo). Los 2 arrays pasaron a `export_contable: {acceder,
configurar}` — `acceder` es el gate de nivel superior del handler
(cualquier método/recurso: generar export, historial, leer config);
`configurar` es el más restrictivo, solo para el POST de plan de cuentas.
`grep ROLES_EXPORT_CONTABLE\|ROLES_CONFIG lib/handlers/export-contable.js`
→ 0. No existían tests de este handler — se sumó
`tests/handlers/export-contable-permisos.test.js` (10 casos). Suite
completa: 233/233 OK.

**`usuarios.js` queda afuera a propósito** (evaluado y descartado para
esta ronda): `ROLES_GESTION` se re-exporta y se importa desde
`lib/asistente-tools.js` (aliased `ROLES_USUARIOS`) — mayor blast radius,
tocaría 2 archivos en vez de 1. Además `ROLES_ASIGNABLES` (whitelist de
valores de rol, no un gate de acción) y `ROLES_PRIVILEGIADOS` (lógica
jerárquica: compara el rol del *objetivo*, no el del actor, contra
`perfil.rol !== 'dueno'`) no encajan en el modelo `puede(perfil, accion,
recurso)` sin forzarlo — necesitarían una forma distinta de regla, no
solo una entrada más en la tabla plana actual.

Quedan ~31 constantes `ROLES_*` más repartidas en 18 handlers. Antes de
proponer candidatos se verificó cross-import (mismo chequeo que evitó el
error con `usuarios.js`): `ROLES_MIGRACION` de `migracion.js` también se
importa desde `lib/asistente-tools.js`, así que queda en la misma
categoría que `usuarios.js` (mayor blast radius, no es la próxima
entrega chica). Confirmados autocontenidos y **migrados**:
`importar.js` (`ROLES_IMPORTAR` → `importar: {cargar}`) y `bcra.js`
(`ROLES_PERMITIDOS` → `bcra: {consultar}`, nombre local — no lo importa
nadie más pese a que otros handlers reutilizan el mismo nombre de
constante para sus propios arrays). Ninguno de los dos tenía cobertura
de tests previa; se sumaron `tests/handlers/importar-permisos.test.js`
(7 casos) y `tests/handlers/bcra-permisos.test.js` (8 casos, `fetch`
mockeado). `grep ROLES_IMPORTAR lib/handlers/importar.js` y `grep
ROLES_PERMITIDOS lib/handlers/bcra.js` → 0 ambos. Suite completa:
260/260 OK. Detalle en `CHANGELOG_v574_fase7_permisos_importar_bcra.md`.

**Quinto y sexto módulo (hoy): `busqueda.js` y `ciclos.js`.** Al volver a
relevar cross-imports desde `asistente-tools.js` se encontraron 2
exclusiones más además de `usuarios.js`/`migracion.js`:
`chofer_invitacion.js` (`ROLES_GESTION`, importado como
`ROLES_CHOFER_INVITACION`) y `portal_proveedor.js` (`ROLES_ESCRITURA`,
importado como `ROLES_PORTAL_PROVEEDOR`) — mismo blast radius, quedan
afuera de rondas chicas. De las constantes sin cross-import se eligieron
los dos handlers más chicos con gate único: `busqueda.js`
(`ROLES_ADMIN` → `busqueda: {buscar}`) y `ciclos.js` (`ROLES_ADMIN` →
`ciclos: {acceder}`). Tampoco tenían cobertura previa — se sumaron
`tests/handlers/busqueda-permisos.test.js` (7 casos) y
`tests/handlers/ciclos-permisos.test.js` (7 casos), ambos con un builder
chainable universal para mockear `.from()` en vez de mapear cada cadena
exacta. `grep ROLES_ADMIN` → 0 en los dos handlers. Suite completa:
286/286 OK. Detalle en
`CHANGELOG_v575_fase7_permisos_busqueda_ciclos.md`.

Quedan sin migrar (autocontenidos, gate único, mismo patrón que los 4 ya
cerrados): `admin.js`, `auto-imagenes.js`, `clientes.js`, `empresa.js`.
Con más de un array (requieren evaluar el modelo antes de migrar, mismo
criterio que se aplicó a `export_contable`): `conciliacion-bancaria.js`
(2), `maestros.js` (2), `reglas-precio.js` (2), `cc_proveedores.js` (3),
`stock.js` (3), `facturas.js` (4), `proveedores.js` (5), `notif.js` (2
arrays + `ROLES_POR_TIPO`, un objeto — no encaja en el modelo plano sin
forzarlo, evaluar aparte). Reservados para el final: `pedidos.js`/
`pos.js` (paso 6 grande, ver sección 4) y las 4 exclusiones por blast
radius (`usuarios.js`, `migracion.js`, `chofer_invitacion.js`,
`portal_proveedor.js`).

**Séptimo a décimo módulo: `admin.js`, `auto-imagenes.js`, `clientes.js`
y `empresa.js`** — los cuatro candidatos de gate único que quedaban.
`admin.js` (`ROLES_ADMIN`, compartido por los 9 `_svc` del dashboard) →
`admin_dashboard: {acceder}` (nombre distinto de "admin" a secas para no
confundir con el uso genérico del término). `auto-imagenes.js`
(`ROLES_PERMITIDOS`) → `auto_imagenes: {ejecutar}`. `clientes.js`
(`ROLES_ADMIN`) → `clientes: {acceder}`, preservando el contrato exacto
401 (perfil null) vs. 403 (rol no permitido); el segundo gate hardcodeado
del mismo archivo (POST /acceso, `['dueno','admin']` sin nombre propio)
no se tocó — fuera de alcance, no era un `ROLES_*`. `empresa.js`
(`ROLES_ADMIN`, resuelto en `requerirPerfilAdmin()`) → `empresa_config:
{acceder}`. Ninguno tenía cobertura previa — se sumaron
`tests/handlers/admin-permisos.test.js` (7 casos; nota: mock de
`rateLimit` síncrono porque `admin.js` llama `limiter(req,res)` sin
`await`), `auto-imagenes-permisos.test.js` (7),
`clientes-permisos.test.js` (7) y `empresa-permisos.test.js` (7). `grep
ROLES_ADMIN\|ROLES_PERMITIDOS` → 0 en los 4. Suite completa: 338/338 OK.
Detalle en
`CHANGELOG_v576_fase7_permisos_admin_autoimg_clientes_empresa.md`.

Ya no quedan candidatos de gate único sin migrar. Lo que sigue requiere
evaluar el modelo antes de migrar (2+ arrays por handler):
`conciliacion-bancaria.js` (2), `maestros.js` (2), `reglas-precio.js` (2),
`cc_proveedores.js` (3), `stock.js` (3), `facturas.js` (4),
`proveedores.js` (5), `notif.js` (2 arrays + `ROLES_POR_TIPO`, objeto).
Reservados para el final: `pedidos.js`/`pos.js` (paso 6 grande) y las 4
exclusiones por blast radius (`usuarios.js`, `migracion.js`,
`chofer_invitacion.js`, `portal_proveedor.js`).

**Once a trece: `conciliacion-bancaria.js`, `maestros.js`,
`reglas-precio.js`, `cc_proveedores.js`, `stock.js`, `facturas.js`,
`proveedores.js` y `notif.js` migrados.** `notif.js` fue el caso
especial: de los 2 arrays con nombre (`ROLES_WHATSAPP_PANEL`,
`ROLES_WHATSAPP_ONBOARDING`) más el `ROLES_PERMITIDOS` local de
`handleEstadoCuenta` salieron 3 recursos (`whatsapp_panel`,
`whatsapp_onboarding`, `notif_estado_cuenta`); `ROLES_POR_TIPO` quedó
intacto a propósito (no es un gate de autorización — es tabla de
destinatarios de push, protegida aparte por `INTERNAL_PUSH_SECRET`) y
dos gates literales sin nombre (`pushChoferHandler`,
`handleReintentarEmail`, ambos `['dueno','admin']` inline) quedan
pendientes de una futura pasada, mismo criterio que `anular`/`reintentar`
de `facturas.js`.

**`pedidos.js` migrado.** Caso especial de reexport: `ROLES_ADMIN` y
`ROLES_ADMIN_PRES` eran `export const` reimportados con alias desde
`lib/asistente-tools.js` (`ROLES_PEDIDO`/`ROLES_PRESUPUESTO`) — se
agregó el helper `rolesDe(recurso, accion)` a `permisos-service.js`
(mismo fail-closed que `puede()`) para poder seguir exportando el array
como valor sin duplicar la lista de roles en dos lugares. 4 recursos:
`pedidos` (handler principal + `crearPedidoAdminHandler` +
`handleDevolucionesAdmin`, 1 solo gate `acceder`), `presupuestos`
(`handlePresupuestos`), `remitos` (`_svc=remito-nro`, constante local
sin exportar) y `pedidos_chofer` (`_svc=chofer`, constante local sin
exportar — el chequeo `esAdmin` inline de esa misma función queda fuera
de la tabla, es regla de "dueño del dato" no de acceso). Detalle en
`CHANGELOG_v579_fase7_permisos_pedidos.md`. Suite completa: 496/496 OK.

**Único pendiente: `pos.js`** (5 constantes `ROLES_*` — `ROLES_VENTA`,
`ROLES_TRANSFERIR`, `ROLES_ANULAR`, `ROLES_FACTURAR`,
`ROLES_ADMIN_CAJAS` — en ~37 sitios, autocontenido, ninguna reexportada).
Cierra la sección 2 completa una vez migrado. Se deja para una entrega
aparte por volumen, mismo criterio que ya frenó una migración conjunta
de `pedidos.js`/`pos.js`.

**`pos.js` migrado — sección 2 CERRADA.** Autocontenido (ninguna de las
5 constantes se reexportaba ni se importaba desde otro archivo, a
diferencia de `pedidos.js`), no hizo falta `rolesDe()`. Un solo recurso
`pos` con 5 acciones, una por constante: `vender` (`ROLES_VENTA`, 10
sitios), `transferir` (`ROLES_TRANSFERIR`, 2), `anular` (`ROLES_ANULAR`,
10), `facturar` (`ROLES_FACTURAR`, 3), `administrar_cajas`
(`ROLES_ADMIN_CAJAS`, 6) — las últimas 3 comparten el mismo valor
(`['dueno','admin']`) pero se preservan como acciones separadas, mismo
criterio que `escribir`/`pagar` en `cc_proveedores`. Incluye 2 usos
no-gate migrados también (`puede_forzar_cierre` en la respuesta de
`/caja-estado`, `soloActivas` en promociones). Detalle en
`CHANGELOG_v580_fase7_permisos_pos.md`. Suite completa: 522/522 OK.

No queda ningún módulo con `ROLES_*` sueltos sin migrar. Fuera de
alcance por diseño (no por volumen, no son parte de esta sección):
`usuarios.js`, `migracion.js`, `chofer_invitacion.js`,
`portal_proveedor.js` (blast radius — reexportadas con mayor superficie
de impacto) y la lógica jerárquica de `ROLES_ASIGNABLES`/
`ROLES_PRIVILEGIADOS` de `usuarios.js`, que no encaja en el modelo
`puede(perfil, accion, recurso)` sin forzarlo.


## 3. Checklist de migración por módulo (reutilizable)

1. Crear/extender `lib/repos/<modulo>.js` — una función por operación,
   siempre recibiendo `empresa_id` como primer parámetro explícito (nunca
   confiar en RLS como única barrera, mismo criterio que el resto del
   sistema).
2. Reemplazar los `.from()` del handler por las funciones del repo, **sin
   cambiar comportamiento observable** — expand-contract: si el query
   original tenía un caso raro (join, filtro condicional), se replica
   exacto antes de "mejorarlo".
3. `grep -c "\.from(" lib/handlers/<modulo>.js` debe dar 0 al terminar
   (o el resto debe ser justificable, como los `db.auth.admin.*` de
   `clientes.js` — identidad, no dato de negocio).
4. Correr la suite completa (`npx vitest run`), no solo el archivo
   tocado — varios handlers comparten tablas.
5. Si el módulo no tiene tests de repo todavía, sumar al menos los casos
   de `empresa_id` cruzado (que un repo nunca devuelva/edite datos de
   otra empresa) — es la clase de bug que ya se auditó una vez en
   AUDITORIA_2026 y que una capa de repos mal migrada podría reintroducir.
6. Changelog por módulo (no por lote grande) — más fácil de revisar y de
   revertir si algo sale mal.

## 4. Qué NO hacer (específico de esta fase, además del punto 5 del plan)

- No migrar `pedidos.js`/`pos.js` en una sola entrega — el propio volumen
  (137/83 queries) hace que un solo PR gigante sea imposible de revisar
  con seguridad. Se parte en sub-módulos (ej. `pedidos.js` → borradores,
  confirmación, facturación, cada uno su propio paso).
- No crear `lib/repos/cta-cte.js` como "de paso" mientras se migra
  `pedidos` — se hace antes y aparte, justamente porque lo comparten 9
  handlers y cualquier decisión de forma ahí impacta a todos.
- No tocar RLS como parte de esta fase — Fase 7 es capa de aplicación
  (dónde vive el código que arma la query), no la barrera de base de
  datos, que ya se auditó en AUDITORIA_2026 y sigue siendo la línea de
  defensa real.

## Próximo paso concreto

Con `productos` y `cta_cte` cerrados, el `PermisosService` (sección 2,
todavía sin implementar) ya no tiene dependencias bloqueantes. Alternativa
más chica: paso 5, `stock.js` — pero ojo que `stock.js` ya quedó a 0
directos de `productos` en este mismo paso (lote 2); lo que queda ahí es
propio de la tabla `stock`, no de `productos`/`cta_cte`. Evaluar cuál de
los dos conviene arrancar antes de tocar `pedidos`/`pos` (paso 6).

**Paso 5 (`stock.js`) — cerrado.** 25 funciones en `lib/repos/stock.js`,
handler a 0 directos, 2 hallazgos de aislamiento corregidos de paso (ajuste
de stock sin validar empresa/lock atómico → ahora usa `ajustar_stock()`;
alta de lote sin validar `deposito_id` contra la empresa). Detalle en
`CHANGELOG_v581_fase7_stock.md`. Suite completa: 567/567 OK.

**Paso 6 (`pedidos.js`/`pos.js`) — ya migrados en la sección 2** (aplicación
de `PermisosService`, ver `CHANGELOG_v579_fase7_permisos_pedidos.md` y
`CHANGELOG_v580_fase7_permisos_pos.md`), quedando ambos handlers como
única fuente pendiente de repo propio de acceso a datos (fuera del alcance
de la sección 2, que era permisos, no capa de datos) — no se reabre acá.

**Paso 7 (`notif.js`) — cerrado, los 4 lotes.** El relevamiento real mostró
que `notif.js` no es un módulo homogéneo: mezcla el bot conversacional de
WhatsApp, dispositivos push, notificaciones de entrega, alertas por cron y
estado de cuenta/reintento de email en un único router de 2312 líneas y 71
`.from()`. Se partió en 4 lotes por concern (mismo criterio que evitó
migrar `pedidos`/`pos` de una):
1. ✅ **Alertas por cron** (token WhatsApp vencido, cheques por vencer,
   deuda vencida) — 7 funciones nuevas en el repo, 12 `.from()` migrados.
   Detalle en `CHANGELOG_v582_fase7_notif_lote1_alertas_cron.md`. Suite:
   583/583 OK.
2. ✅ **Estado de cuenta + reintentar email** (`handleEstadoCuenta`,
   `handleReintentarEmail` y sus 4 helpers `_reintentar*`) — funciones
   nuevas sobre `usuarios`, `clientes`, `facturas`, `notif_log`,
   `empresas`, `pedidos`, `recepciones_mercaderia` y `ordenes_compra`.
   Documentado en la cabecera de `lib/repos/notif.js`.
3. ✅ **Dispositivos push + notificaciones de entrega**
   (`pushInternoHandler`, `registrarDispositivo`, `desregistrarDispositivo`,
   `pushChoferHandler`, `entregaHandler` y sus helpers `manejar*`) —
   funciones nuevas sobre `rutas`, `entregas`, `pedidos`, `usuarios` y
   `dispositivos_push`. Documentado en la cabecera de `lib/repos/notif.js`.
4. ✅ **Bot conversacional de WhatsApp** — el más grande (28 `.from()`/
   `.rpc()`) y de mayor riesgo real (firma de Meta, estado de conversación,
   crea pedidos). Terminó en repo propio, `lib/repos/whatsapp-bot.js` (24
   funciones), en vez de sumarse a `lib/repos/notif.js` — no es
   conceptualmente "notif". Detalle en
   `CHANGELOG_v582_fase7_notif_lote4_whatsapp_bot.md`. Suite: 642/642 OK.

`notif.js` (2225 líneas) queda con 0 `.from()`/`.rpc()` directos a Supabase
(las 3 apariciones restantes de `.from(` son `Buffer.from()`, no
relacionadas). Toda la capa de datos vive en `lib/repos/notif.js` (lotes
1-3) y `lib/repos/whatsapp-bot.js` (lote 4).

Con esto se cierra la sección 3 completa del plan (pasos 1-7). Próximo
paso: repo propio para `pedidos.js`/`pos.js` (quedó pendiente del paso 6,
ver nota arriba) — a evaluar si arranca ahora o si conviene antes revisar
el estado general de la Fase 7.

**Paso 8 (`pedidos.js` — repo de datos) — arrancado, lote 1 de N
(`presupuestos`).** Mismo criterio de partir por concern que en el paso 7:
`pedidos.js` (3164 líneas, 130 `.from()`) no se migra entero de una. Se
eligió `presupuestos` como primer lote por ser el sub-módulo más
autocontenido (usa `presupuestos`/`presupuesto_items` en exclusiva, sin que
ningún otro concern de pedidos.js dependa de él).

- **`lib/repos/pedidos.js` — 28 funciones nuevas**, cubriendo
  `crearPresupuestoParaCliente` (usada por el asistente) y
  `handlePresupuestos` completo (GET detalle/lista, POST, PATCH incluyendo
  el flujo de aceptación con lock optimista + conversión a pedido + reserva
  de stock con rollback, y DELETE).
- **Reuso en vez de duplicar**: `resolverPreciosClienteRpc` ya existía en
  `lib/repos/whatsapp-bot.js` (mismo RPC `resolver_precios_cliente`) — se
  reexporta desde `lib/repos/pedidos.js` en vez de duplicarlo.
- **Handler migrado sin cambiar comportamiento observable** — incluye el
  fix post-Fase-11 de la conversión presupuesto→pedido (rollback del lock
  optimista si falla la creación del pedido/items/reserva), replicado tal
  cual, no se tocó lógica de negocio en este lote.
- `grep -c "\.from(" lib/handlers/pedidos.js`: 130 → 97 (33 migrados).
  Quedan pendientes ~97 en el resto del archivo (confirmación de pedido,
  chofer, devoluciones, remito) — próximos lotes.
- Tests nuevos: `tests/repos/pedidos.test.js` (29 casos, foco en
  aislamiento por `empresa_id` y en el lock optimista). Suite completa:
  **671/671 OK** (642 previos + 29 nuevos).

**Paso 8, lote 2 (`chofer`).** Cubre `handleRemitoNro`,
`pedidoEsDeEsteChofer` y `handleChofer` completo (remitos, rutas del día,
despacho, entrega, reversión). Mismo criterio de no tocar lógica de
negocio, solo mover el acceso a datos al repo.

**Paso 8, lote 3 (`devoluciones`).** Cubre `crearDevolucionCore` y
`handleDevolucionesAdmin` completo (alta, notas de débito/crédito,
anulación, reposición de stock).

**Paso 8, lote 4, sub-lote 1 (`notificaciones` y `puntos`) + cierre de
cabo suelto del lote 1.** Antes de arrancar el lote 4 se detectó que
`handlePresupuestos` todavía traía el perfil del usuario con una query
cruda (`usuarios` — mismo shape que `obtenerPerfilChofer`, quedó afuera
del lote 1 por no existir esa función todavía) — se cerró con
`obtenerPerfilPresupuestos`, función propia en vez de reuso porque
`presupuestos` y `pedidos_chofer` son gates de permisos independientes.

Lote 4 se partió en sub-lotes por ser el núcleo más grande y sensible del
archivo (creación/confirmación de pedido, compartido por 9 handlers). Este
sub-lote 1 cubre la parte autocontenida — **notificaciones y puntos** —
y deja afuera `crearPedidoParaCliente`/`confirmarPedidoHandler` (reserva
de stock con rollback) para el sub-lote siguiente:

- **17 funciones nuevas en `lib/repos/pedidos.js`**: `sincronizarEstadoRuta`
  (rutas/entregas), `notificarEstado`/`notificarDespachoPorEmail`
  (WhatsApp/email de despacho), `_logNotif`/`notificarPedidoConfirmado`
  (confirmación de pedido, WhatsApp + email), `acreditarPuntos` (programa
  de fidelización + RPC principal con fallback manual), y
  `notificarPushAdmin`.
- Handler migrado sin cambiar comportamiento observable — mismos fallbacks,
  mismo manejo de errores best-effort, mismos `console.error` de
  diagnóstico.
- `grep -c "\.from(" lib/handlers/pedidos.js`: 97 → 37 tras lotes 2-3-4sub1
  (60 migrados en total desde el lote 1). Quedan los 37 del núcleo de
  creación/confirmación de pedido (`crearPedidoParaCliente`,
  `confirmarPedidoHandler`, router principal, reserva de stock) — próximo
  sub-lote.
- Suite completa: **671/671 OK** (sin tests nuevos en este sub-lote — el
  cambio es 1:1 wiring del handler a funciones ya cubiertas por el patrón
  de tests de repos existente; se evalúa sumar casos dedicados junto con
  el sub-lote de creación de pedido, que es donde vive la lógica con más
  ramas).

**Paso 8, lote 4, sub-lote 2 (`router principal` — GET/PATCH/DELETE de
`/api/pedidos`).** Cubre el `handler` exportado por defecto completo:
detalle (`GET ?id=`), lista paginada con filtros dinámicos (`GET`), cambio
de estado (`PATCH`), borrado físico (`DELETE ?accion=eliminar`) y
cancelación (`DELETE`, con liberación de stock reservado ítem por ítem,
reversión de puntos de fidelización, y anulación/NC de facturas
vinculadas).

- **17 funciones nuevas en `lib/repos/pedidos.js`**, incluyendo
  `listarPedidosFiltrados` (query dinámica con los mismos filtros
  condicionales que el handler original — mismo criterio que
  `listarDevolucionesFiltradas` del lote 3) y el circuito completo de
  cancelación (`listarItemsPedidoParaCancelar`,
  `listarStockParaLiberarReserva` + reuso de `liberarStockReservadoRpc`
  ya existente del lote 1, `marcarPedidoCancelado`,
  `revertirPuntosPedidoCanceladoRpc`, `listarFacturasVinculadasParaCancelar`,
  `anularFacturaPendiente`).
- Handler migrado sin cambiar comportamiento observable — incluye
  replicar tal cual el bug preexistente de la rama `!esAdmin` en la lista
  (si no se resuelve `cliId` por `cliente_id` directo ni por email, no
  filtra y devuelve todos los pedidos de la empresa); no se corrige en
  este lote porque el alcance es solo mover acceso a datos, no tocar
  lógica de negocio.
- `grep -c "\.from(" lib/handlers/pedidos.js` (tablas reales, sin
  `Buffer.from`/`storage.from`): 37 → 14. Quedan `verPedidoSugeridoHandler`,
  `confirmarPedidoSugeridoHandler`, `crearPedidoParaCliente`,
  `crearPedidoAdminHandler` y `confirmarPedidoHandler` — la alta de pedido
  desde cero con reserva de stock y rollback, el núcleo más sensible.
- Suite completa: **671/671 OK**.

**Paso 8, lote 4, sub-lote 3 (`pedido sugerido` + creación/confirmación
de pedido) — cierre del paso 8.** Último bloque: `verPedidoSugeridoHandler`,
`confirmarPedidoSugeridoHandler`, `crearPedidoParaCliente` (+
`crearPedidoAdminHandler`) y `confirmarPedidoHandler`. Es el núcleo de
alta de pedido, compartido por el portal cliente, el modal admin y la
tool `crear_pedido` del asistente.

- **12 funciones nuevas en `lib/repos/pedidos.js`**, más el re-export de
  `crearPedidoClienteRpc` (ya existía en `lib/repos/whatsapp-bot.js`,
  compartida con `notif.js` — se reusa en vez de duplicar, mismo criterio
  que `resolverPreciosClienteRpc` del lote 1).
- **Sin rollback manual que migrar**: la creación de pedido + ítems +
  reserva de stock ya es una única transacción en la RPC
  `crear_pedido_cliente` — este sub-lote solo mueve las lecturas y
  validaciones previas (cliente, stock disponible, precios de servidor,
  límite de crédito) al repo, no lógica de reserva/rollback propia del
  handler.
- Reuso de `listarStockParaValidarPedido` entre `crearPedidoParaCliente`
  y `confirmarPedidoHandler` — antes duplicaban la misma query.
- Handler migrado sin cambiar comportamiento observable.
- `grep -c "\.from(" lib/handlers/pedidos.js` (tablas reales): 14 → **0**.
  Los 3 `.from()` que quedan en el archivo son `supabase.storage.from()`
  (subida de fotos de remitos/devoluciones), fuera de alcance de este
  paso desde el inicio.
- Suite completa: **671/671 OK**.

**Paso 8 completo.** `lib/handlers/pedidos.js` (3164 líneas originales,
130 `.from()` de tablas) migró sus 130 accesos a datos a
`lib/repos/pedidos.js` en 4 lotes (+ 3 sub-lotes del lote 4), sin cambiar
comportamiento observable en ningún paso. Pendiente para más adelante:
sumar tests dedicados al circuito de creación/confirmación de pedido
(hoy cubierto indirectamente por la suite existente, sin casos propios
como los 29 de `presupuestos`).

**Paso 9 (`pos.js` — repo de datos) — cerrado, 4 sub-lotes.** Mismo
criterio de partir por concern que `pedidos.js`: `pos.js` (2047 líneas,
76 `.from()`/`.rpc()` directos originales) no se migró entero de una.

1. ✅ **Catálogo/stock del POS** (`productosHandler`, `depositosHandler`,
   `transferenciasStockHandler`, `transferirStockHandler`, favoritos,
   `stockAlertaHandler`).
2. ✅ **Config varios** (cliente rápido, hardware, PIN de supervisor,
   promociones).
3. ✅ **Caja y turno** (apertura/cierre, arqueo, movimientos de caja,
   reporte Z, historial, administración de cajas).
4. ✅ **Núcleo transaccional** (`registrarVentaHandler`,
   `anularVentaHandler`, `facturarVentaHandler`, `ticketHandler`,
   `ventasHandler`, `devolucionHandler`, `getDevolucionesHandler`) — el
   más sensible, toca stock/pagos/facturación AFIP en la misma operación.
   Reuso de `resolverPreciosClienteRpc` (`whatsapp-bot.js`),
   `obtenerDepositoPrincipal`/`asignarDepositoACaja` (sub-lote 1) y
   `obtenerPinSupervisor` (sub-lote 3). Tests nuevos:
   `tests/repos/pos.test.js` (18 casos — primera cobertura de repo para
   `pos.js`, los 3 sub-lotes anteriores quedan pendientes de tests
   propios). Detalle en `CHANGELOG_v588_fase7_pos_lote4_nucleo_venta.md`.
   Suite completa: **689/689 OK**.

`grep -c "\.from(\|\.rpc(" lib/handlers/pos.js`: 76 → **1** (lookup de
`perfil` en el router de auth — identidad, no dato de negocio). El repo
(`lib/repos/pos.js`) suma 66 funciones exportadas.

Con esto se cierran los pasos 8 (`pedidos.js`) y 9 (`pos.js`) — los dos
módulos que se dejaron para el final del punto 6 del orden de migración
por ser el corazón transaccional del sistema.

