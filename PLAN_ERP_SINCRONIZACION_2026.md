# Plan estratégico de sincronización — distrib ERP
### De "35 módulos que conviven" a "un sistema que actúa como uno solo"

---

## 0. Punto de partida (diagnóstico)

`distrib` ya es un ERP funcional, no un prototipo: 289 migraciones, ~35 handlers de negocio, 4 portales
(admin/cliente/chofer/proveedor), ~40 pantallas de admin cubriendo pedidos, rutas, POS, facturación ARCA,
cobranzas, cta-cte, cheques, conciliación bancaria, compras, proveedores, devoluciones, depósitos, reportes
financieros/stock/ventas, rentabilidad, fidelización, automatización, anomalías y auditoría. Además ya hay
piezas de infraestructura seria: circuit breaker + retry para llamadas externas, rate limiting, un asistente
de IA con tools propias, y una auditoría de seguridad multi-tenant (AUDITORIA_2026, etapas 1–16).

El problema no es que falten módulos. Es que crecieron **uno al lado del otro**, no **uno a través del otro**:

1. **No hay tiempo real entre portales.** Si un chofer marca una entrega, el admin no lo ve hasta refrescar.
2. **La lógica de negocio está encadenada a mano.** `facturas.js` llama a `stock.js` llama a `pagos.js`.
   Cada módulo nuevo obliga a tocar los módulos viejos para que "se enteren" de él.
3. **Notificaciones y auditoría se reimplementan módulo por módulo.** Sabemos, por AUDITORIA_2026, que las
   push notifications nunca llegaron a ningún dispositivo (faltaban las VAPID keys en Vercel) — sintomático
   de que no hay un servicio central de notificaciones, sino intentos sueltos.
4. **La capa de acceso a datos es inconsistente.** Hay una carpeta `lib/repos/` con 8 archivos, pero ~35
   handlers — la mayoría accede a Supabase directo, sin pasar por un repo. Eso hace que cualquier cambio de
   esquema obligue a tocar N lugares distintos en vez de uno solo.

Este plan ataca los cuatro puntos, en un orden pensado para que cada fase apoye a la siguiente y para que el
sistema en producción no se rompa en ningún momento del camino.

---

## 1. Principios que gobiernan todo el plan (no negociables)

Estos principios aplican a **todas** las fases, sin excepción:

- **Incremental, nunca big-bang.** Cada fase se implementa primero en un flujo piloto acotado, se valida en
  producción con datos reales, y recién después se generaliza al resto de los módulos.
- **Expand–contract, no romper en el camino.** Toda migración de esquema agrega columnas/tablas nuevas y
  convive con las viejas un tiempo, antes de eliminar lo viejo. Nunca un cambio que rompa lo que ya funciona
  de un día para el otro.
- **Feature flags por empresa (tenant).** Cada pieza nueva se activa primero para 1–2 empresas piloto
  (usando la tabla de suscripciones que ya existe), no para todos los clientes a la vez.
- **Un módulo piloto por fase, elegido por impacto real, no por facilidad.** El flujo pedido → stock →
  factura → cuenta corriente → notificación es el que más se repite y el que más se nota si falla — es el
  candidato natural a piloto en varias fases (ver sección 3).
- **Ninguna fase cierra sin tests.** Ya existe `tests/` con carpetas para repos, handlers, calc y webhooks —
  cada fase agrega los suyos ahí, no los deja para "después".
- **Rollback siempre disponible.** Cada fase debe poder desactivarse con un flag sin dejar datos
  inconsistentes, hasta que se dé de baja definitivamente el código viejo.

---

## 2. Orden de fases y por qué ese orden

| # | Fase | Por qué va ahí |
|---|------|-----------------|
| 1 | Tabla de eventos de dominio (outbox) | Es la base física sobre la que se paran las fases 2 a 6. Sin esto, todo lo demás son parches. |
| 2 | Tiempo real entre portales | Máximo impacto percibido con mínimo riesgo — no toca lógica de negocio, solo lectura. |
| 3 | Despachador de eventos (orquestación desacoplada) | Recién acá se empieza a desarmar el encadenado manual entre handlers. |
| 4 | Notificaciones unificadas | Depende de la fase 3 (consume eventos) y resuelve un bug ya conocido (push roto). |
| 5 | Auditoría de negocio centralizada | Depende de la fase 1 (los eventos son la fuente de la auditoría). |
| 6 | Motor de automatización sobre el bus de eventos | Generaliza lo que `automatizacion.js` ya hace hoy de forma puntual. |
| 7 | Capa de datos consistente + permisos cross-módulo | Es la más invasiva — se deja para cuando el resto ya es estable. |
| 8 | Observabilidad continua | Corre en paralelo a todas, pero se consolida al final. |

---

## Fase 1 — Tabla de eventos de dominio (outbox pattern)

**Objetivo:** que cada acción de negocio relevante quede registrada como un evento explícito, en vez de vivir
solo como efecto colateral de una función.

**Alcance técnico:**
- Nueva tabla `eventos_negocio`: `id, empresa_id, tipo_evento, payload jsonb, origen (handler que lo emitió),
  creado_en, procesado_en, estado (pendiente/procesado/error)`.
- Un único helper `emitirEvento(tipo, payload, empresaId)` en `lib/eventos.js`, usado por los handlers que
  van sumándose fase a fase (no se toca todo de una vez).
- Piloto: instrumentar `pedidos.js` y `facturas.js` para que emitan `pedido_creado`, `pedido_facturado`,
  `factura_anulada` — sin que todavía nadie escuche esos eventos (eso es la fase 3).

**Entregables:** migración de la tabla, helper `emitirEvento`, 2 handlers piloto instrumentados, tests en
`tests/handlers/`.

**Criterio de éxito:** cada pedido facturado en las empresas piloto deja una fila en `eventos_negocio`
verificable por SQL, sin cambiar el comportamiento visible del sistema.

**Riesgo principal:** que instrumentar handlers introduzca lentitud. Mitigación: el insert a
`eventos_negocio` es *fire-and-forget* con manejo de error propio — si falla, no debe romper la operación
original.

**Talla:** M.

---

## Fase 2 — Tiempo real entre portales (Supabase Realtime)

**Objetivo:** que un cambio hecho en un portal se vea reflejado en los demás sin refrescar la página.

**Alcance técnico:**
- Activar Supabase Realtime sobre las tablas de mayor impacto visible primero: `pedidos`, `entregas_ruta`,
  `stock`.
- En frontend, un módulo compartido `frontend/shared/realtime.js` que cada portal importa y suscribe según
  qué tablas le interesan (el admin se suscribe a todo lo de su empresa; el chofer solo a sus rutas del día).
- Filtrado por `empresa_id` en cada suscripción — esto es crítico dado que ya se auditó la separación
  multi-tenant; una suscripción mal filtrada sería una fuga de datos entre empresas.

**Entregables:** `realtime.js` compartido, integración en dashboard admin y en la vista de ruta del chofer
(los dos casos de uso con mayor beneficio inmediato), documentación de qué tablas están expuestas por
Realtime y con qué filtro.

**Criterio de éxito:** un chofer marca una entrega desde el celular y el admin la ve aparecer en su
dashboard sin recargar, en menos de 2 segundos, en las empresas piloto.

**Riesgo principal:** exponer una tabla por Realtime sin el filtro de tenant correcto. Mitigación: cada
suscripción nueva pasa por el mismo checklist que ya usaron en la auditoría de RLS (etapas 1–16).

**Talla:** M.

**Estado (actualizado 2026-08-02):** cerrada. La integración en dashboard admin ya existía (suscripción a
`pedidos` filtrada por `empresa_id`). Faltaba el segundo caso de uso que el plan pedía explícitamente —
la vista de ruta del chofer (`frontend/chofer/index.html`) — y nunca se había conectado. Se agregó:

- `<script src="/frontend/shared/realtime.js?v1" defer>` en `frontend/chofer/index.html`.
- Suscripción a la tabla **`entregas`** (no `entregas_ruta` — esa tabla no existe en el esquema real; el
  nombre correcto, confirmado contra `lib/repos/rutas.js`/`lib/handlers/pedidos.js`, es `entregas`),
  filtrada por `ruta_id=eq.<rutaId>` — el `ruta_id` de la ruta del día que ya devuelve
  `GET /api/chofer/remitos`. Cubre los dos eventos relevantes para el chofer: `confirmarRuta()` (admin)
  inserta filas en `entregas` al asignar pedidos a la ruta, y `marcarEntregaCompletada()` las actualiza al
  cerrar una entrega.
- Filtro más ajustado que el del dashboard a propósito: por `ruta_id` propio, no por `empresa_id` —
  el chofer nunca recibe en el payload del canal filas de rutas de otros choferes de la misma empresa
  (mismo principio de "ninguna suscripción sin filtro de tenant correcto" del plan, llevado un nivel más
  abajo porque acá el dato es por-chofer, no por-empresa).
- Debounce de 800ms antes de refrescar la ruta (`cargarRuta()`), mismo criterio que `dashboard.html`.
- Sin tests automatizados (es frontend puro, sin framework de test de UI en este repo — igual que el resto
  de `frontend/`); verificado con `node --check` sobre los bloques `<script>` inline.

Criterio de éxito re-verificado: con este cambio, una entrega marcada por el chofer sigue reflejándose en
el dashboard admin (ya funcionaba) y, en la dirección inversa, un pedido agregado a la ruta por el admin
ahora se refleja en la app del chofer sin recargar.

---

## Fase 3 — Despachador de eventos (orquestación desacoplada)

**Objetivo:** que la lógica encadenada a mano ("facturar también descuenta stock, también actualiza
cta-cte, también...") pase a ser: un handler emite un evento, y quien necesite reaccionar se suscribe a ese
evento — sin que el emisor sepa quién lo escucha.

**Alcance técnico:**
- Un despachador (`lib/eventos-dispatcher.js`) que lee `eventos_negocio` pendientes y ejecuta los
  "listeners" registrados para cada `tipo_evento`.
- Puede correr como job periódico (cron ya usado en el proyecto para el trial automático) o, si el volumen
  lo justifica más adelante, como Edge Function disparada por trigger de Postgres.
- Piloto: mover la actualización de stock post-facturación de estar hardcodeada dentro de `facturas.js` a
  ser un listener de `pedido_facturado`. El comportamiento observable no cambia; lo que cambia es que ahora
  `facturas.js` no necesita conocer `stock.js`.

**Entregables:** despachador, primer listener migrado (stock), los handlers viejos conservan el llamado
directo detrás de un feature flag hasta confirmar que el listener nuevo funciona igual — recién ahí se
retira el código viejo (principio expand-contract).

**Criterio de éxito:** se puede agregar un nuevo listener (por ejemplo, para fidelización) sin tocar una
sola línea de `facturas.js`.

**Riesgo principal:** doble ejecución (el código viejo y el listener nuevo corriendo a la vez) duplicando
efectos como descuento de stock. Mitigación: el flag es excluyente, nunca ambos caminos activos para la
misma empresa a la vez.

**Talla:** L — es la fase de mayor riesgo del plan, por eso va después de haber validado tiempo real (fase
2) con bajo riesgo primero.

**Estado (actualizado 2026-08-03):** código cerrado (`lib/eventos-dispatcher.js`, listeners en
`lib/eventos-listeners/`), gateado por el flag por-tenant `empresas.config.fase3_despachador_eventos`
(`lib/eventos.js::usaDespachadorEventos`). **Auditoría de datos reales, no solo de código:** al cruzar
`eventos_negocio` contra las tablas que debería respaldar (`pedidos`, `entregas`, `cheques`, `facturas`),
32 de 44 filas existentes (73%) no tenían fila real correspondiente — insertadas a mano por SQL en algún
momento, no generadas por el flujo real de la app. Ningún cliente activo había corrido el piloto todavía:
la única empresa con eventos, Distribuidora del Litoral S.A., estaba `saas_plan='suspendido'` (sin
factura en `saas_facturas` que lo explique — inconsistente con el flujo real de `saas_suspender_empresa`).

Acciones tomadas para dejar el piloto en condiciones reales de correr:
- Litoral reactivada al estado que dejaría `saas_confirmar_pago()` (`saas_plan='activo'`,
  `saas_suspendida=false`, `activa=true`) — ya tenía el flag de piloto activo y datos reales (11 clientes,
  258 productos), así que es la candidata natural para generar el primer lote de eventos genuinos.
- `del sol srl` (trial activo, vence 2026-08-11, CUIT real `20-34821142-1`) recibió el flag
  `fase3_despachador_eventos=true`, pero **tiene 0 clientes y 0 productos cargados** — parece una cuenta de
  prospecto real en proceso de alta, no un piloto usable todavía. No se le cargaron datos de negocio
  ficticios para no ensuciar la cuenta de un cliente real; queda pendiente de que complete su propia carga
  antes de sumarla como segundo piloto.

**Pendiente real:** generar el flujo pedido→factura→entrega en Litoral **a través de la app** (no por SQL
directo, para no repetir el problema de datos huérfanos) y volver a auditar `eventos_negocio` contra
`entregas`/`facturas` para confirmar que el 0% de eventos huérfanos se mantiene con tráfico genuino.

---

## Fase 4 — Notificaciones unificadas

**Objetivo:** un solo servicio de notificaciones que todos los módulos usan, en vez de que cada uno
reinvente "cómo aviso esto".

**Alcance técnico:**
- Resolver primero el bug ya diagnosticado en AUDITORIA_2026: VAPID keys ausentes en Vercel + portales que
  nunca se registraron para push. Sin esto, cualquier notificación nueva seguiría sin llegar a ningún lado.
- Consolidar `lib/handlers/notif.js` como el único punto de salida (push, email vía Resend, y en el futuro
  WhatsApp) — todos alimentados por listeners del despachador de eventos (fase 3), no por llamadas directas
  desde cada handler.
- Centro de notificaciones en cada portal (ya existe `notif-log.html` en admin — se generaliza a los otros
  3 portales).

**Entregables:** push funcionando de punta a punta (verificado con un caso real), `notif.js` como servicio
único, listeners de notificación para `pedido_creado`, `pedido_facturado`, `entrega_completada`,
`cliente_en_mora`.

**Criterio de éxito:** una notificación de "cliente en mora" generada en el admin le llega efectivamente al
celular del vendedor o chofer correspondiente, sin intervención manual.

**Talla:** M.

---

## Fase 5 — Auditoría de negocio centralizada

**Objetivo:** que la auditoría no sea solo "quién cambió qué fila" (nivel base de datos, ya cubierto en
AUDITORIA_2026), sino también "qué decisión de negocio se tomó y por qué" (nivel evento).

**Alcance técnico:**
- La tabla `eventos_negocio` de la fase 1 ya es, de hecho, la base de esta auditoría — se le suma una vista
  de solo lectura pensada para consulta humana (`auditoria.html` ya existe, se extiende para leer de acá).
- Reglas de retención: los eventos de negocio quedan indefinidamente (a diferencia de logs técnicos, que
  pueden rotar), porque son el historial contable/operativo de la empresa.

**Entregables:** vista de auditoría de negocio en `auditoria.html`, filtros por tipo de evento y rango de
fecha, export a CSV para el contador (reutilizando lo que ya existe en `export-contable.js`).

**Criterio de éxito:** ante la pregunta "¿por qué este pedido no se facturó?", la respuesta se encuentra en
la auditoría sin tener que revisar logs de servidor.

**Talla:** S — es mayormente consumir algo que la fase 1 ya generó.

---

## Fase 6 — Motor de automatización sobre el bus de eventos

**Objetivo:** generalizar lo que `automatizacion.js` y `anomalias.html` ya hacen puntualmente, para que
cualquier módulo pueda definir reglas del tipo "cuando pase X, hacé Y" sin código nuevo por regla.

**Alcance técnico:**
- Tabla `reglas_automatizacion`: `empresa_id, evento_disparador, condicion jsonb, accion jsonb, activa`.
- El despachador de eventos (fase 3) evalúa estas reglas además de los listeners de código fijo — esto es lo
  que permite que un cliente configure sus propias automatizaciones sin que cada una requiera un deploy.
- Ejemplos de reglas que hoy seguramente están hardcodeadas y podrían migrar acá: alertas de stock bajo,
  aviso de mora a los N días, sugerencia de reposición.

**Entregables:** tabla + motor de evaluación de condiciones simple (comparaciones, no un lenguaje completo),
UI en `automatizacion.html` para que el propio cliente arme sus reglas.

**Criterio de éxito:** se puede crear una regla nueva desde la UI, sin código, y verla ejecutarse ante el
evento correspondiente.

**Talla:** L.

---

## Fase 7 — Capa de datos consistente (repos) + permisos cross-módulo

**Objetivo:** que todo acceso a datos pase por `lib/repos/`, no por Supabase directo desde cada handler —
y que los permisos (qué puede ver/hacer cada rol) se resuelvan en un solo lugar, no repetidos módulo por
módulo.

**Alcance técnico:**
- Esta es la fase más grande e invasiva del plan — por eso va después de que las fases 1–6 ya demostraron
  que el enfoque incremental funciona.
- Se hace módulo por módulo, empezando por los que ya tienen repo parcial (`clientes`, `empresas`) y
  extendiendo de a uno: `productos`, `pedidos`, `stock`, `cta-cte`...
- Un `PermisosService` único, consultado por rol (admin/chofer/cliente/proveedor) y por acción — hoy
  probablemente cada handler valida permisos a su manera.

**Entregables:** repos completos para los módulos de mayor uso, `PermisosService` documentado, checklist de
migración por módulo (para no tener que rediseñar el proceso cada vez).

**Criterio de éxito:** un cambio de esquema en `productos` requiere tocar un solo archivo (`repos/productos.js`),
no N handlers dispersos.

**Talla:** XL — se planifica como trabajo continuo de varios meses, módulo por módulo, no como una sola
entrega.

**Estado (actualizado 2026-08-02):** en curso, módulo por módulo.

- **Cerrados (21):** `clientes`, `empresas`, `productos`, `cta_cte`, `stock`, `notif`, `pedidos`, `pos`,
  `migracion` (ver CHANGELOG_v591_fase7_migracion.md; de los 56 `.from()`/`.rpc()` directos que tenía el
  handler, quedan sin migrar a propósito y documentado en comentarios: los 31 `.rpc('migracion_*', ...)`,
  los 2 `.from('audit_log').insert(...)` y 1 `.from(tabla)` dinámico en `mapearSesionMaestro`), `proveedores`,
  `rutas-live`, `facturas`, `admin`, `pagos`, `cierre`, `portal_proveedor`, `cc_proveedores`, `automatizacion`,
  `stock-auto`, `maestros`, `chofer_invitacion`.
  **Verificado 2026-08-02** contra el código real (no solo contra este documento, que había quedado
  desactualizado): los 12 módulos que este archivo listaba como "pendientes por volumen" ya estaban migrados.
  Los `.from()` que aparecían en un grep superficial eran falsos positivos —
  `Buffer.from(...)` en `proveedores.js`/`pagos.js`, `supabase.storage.from('facturas-proveedor')` (Storage
  API, no tabla) en `portal_proveedor.js`, y un comentario de texto (no código) en `chofer_invitacion.js`.
  Los 12 tienen su repo correspondiente en `lib/repos/`.
- **Cerrado 2026-08-02:** `usuarios` — se creó `lib/repos/usuarios.js` (I/O contra tabla `usuarios` +
  Admin API de Auth, mismo criterio que `chofer-invitacion.js`) y se migraron los 8 `.from('usuarios')`
  directos que tenía `lib/handlers/usuarios.js`. Las reglas de negocio (gate dueno/admin, protección de
  pares admin/dueno, no dejar la empresa sin dueño, no autodesactivarse) quedan igual, en el handler.
  `listarUsuariosEquipo()` — el único export consumido por un segundo caller (`lib/asistente-tools.js`) —
  mantiene su firma y contrato `{ok, usuarios}` sin cambios. Test nuevo: `tests/handlers/usuarios.test.js`
  (13 casos). Suite completa: 813/819 (mismas 6 fallas preexistentes de `admin-permisos.test.js`, sin
  relación con este cambio). Con esto, **Fase 7 queda con los 22 módulos de la lista original cerrados** —
  solo restan los handlers chicos (<10 usos) que se absorben de a uno cuando toca tocarlos por otro motivo.

  Handlers chicos aún sin repo dedicado (menos de 10 usos cada uno): `piloto`, `export-contable`, `ciclos`,
  `auto-imagenes`, `búsqueda`, `asistente`, `fidelización`, `setup`, `saas`, `importar`, `auditoría`. Se van
  absorbiendo de a uno cuando toca tocar ese módulo por otro motivo, no como barrido dedicado.

---

## Fase 8 — Observabilidad continua

**Objetivo:** poder ver, en cualquier momento, si el sistema interconectado está funcionando como se espera.

**Alcance técnico:**
- Dashboard de salud del despachador de eventos: eventos pendientes, en error, tiempo promedio de
  procesamiento.
- Alertas cuando un evento queda en estado `error` más de X minutos (reutilizando el circuit breaker /
  retry que ya existe en `lib/circuit-breaker.js` y `lib/retry.js`).
- Métricas de negocio derivadas de `eventos_negocio` (no solo técnicas): pedidos por hora, tiempo promedio
  pedido→facturación, etc.

**Entregables:** panel de salud del bus de eventos, alertas configuradas, métricas de negocio expuestas en
`reportes-financieros.html` o similar.

**Criterio de éxito:** un problema en la cadena de eventos se detecta por una alerta, no porque un cliente
llama a preguntar por qué no le llegó una factura.

**Talla:** M, distribuido a lo largo de todas las fases anteriores.

**Estado (actualizado 2026-08-03):** cerrada (ver CHANGELOG_v599_fase8_observabilidad_continua.md). No se
agregó tabla nueva — es lectura/agregación sobre lo que las Fases 1-4 ya generan en `eventos_negocio`:

- `lib/repos/observabilidad.js` (nuevo) con 3 queries: resumen por ventana de tiempo, eventos en error hace
  más de 2 h (`MINUTOS_ERROR_PROLONGADO = 120`) y eventos `pedido_creado`/`pedido_facturado` para las
  métricas de negocio, con la agregación hecha en JS sobre un recorte acotado
  (`LIMITE_FILAS_AGREGACION = 5000` — documentado como el primer lugar a revisar si el volumen crece).
- Dos endpoints nuevos en `lib/handlers/admin.js`: `GET /api/admin/salud-eventos?horas=` (conteos por
  estado, desglose por `tipo_evento` con tiempo promedio de procesamiento, y listado de errores
  prolongados) y `GET /api/admin/metricas-negocio?horas=` (pedidos por hora y tiempo promedio
  pedido→facturación, matcheando por `payload.pedido_id`).
- `handleAlertas` con categoría 9 nueva: los eventos en error prolongado aparecen en la campanita y en
  `/admin/avisos` (`tipo: evento_error_prolongado`), resolviéndose solos cuando el evento pasa a
  `procesado` (mismo criterio que `cheque_vencido`).
- Pantalla nueva `frontend/admin/observabilidad.html` ("Salud del sistema"), con su entrada en el nav y
  las rutas correspondientes en `vercel.json`.
- `tests/repos/observabilidad.test.js` (4 tests, foco en filtro por `empresa_id` y en no confundir
  `creado_en` con `procesado_en`). Suite completa 817/819 (las 6 fallas de
  `tests/handlers/admin-permisos.test.js` son preexistentes, sin relación con esta fase).

Pendiente de validar con datos reales de producción: si `MINUTOS_ERROR_PROLONGADO = 120` genera ruido en
empresas de poca actividad o, al revés, tarda en avisar — es el primer parámetro a ajustar. El panel es
por-tenant, no una vista global cross-tenant, coherente con el resto de `admin.js`.

Nota: `AUDITORIA_2026/etapas/08_observabilidad.md` tiene un nombre parecido pero pertenece a una auditoría
anterior, no a este plan — no confundir avance de ese documento con avance de esta fase.

**Actualización 2026-08-09 (v685):** primera validación real contra producción del pendiente de arriba.
`MINUTOS_ERROR_PROLONGADO = 120` sigue sin poder validarse (no hay ningún evento en estado `error` en
producción todavía). Pero apareció un hallazgo distinto: 3 eventos `pedido_facturado` con más de 4 días en
`pendiente`, nunca procesados — no es un bug, es el comportamiento esperado para tipos de evento sin
listener registrado (`pedido_facturado`/`factura_anulada`, ver comentario en `lib/eventos-dispatcher.js`),
pero el panel "Salud del sistema" los mostraba idénticos a una cola realmente atascada. Fix aplicado (ver
CHANGELOG_v685_fase8_distincion_pendientes_sin_listener.md): nuevo export `TIPOS_EVENTO_SIN_LISTENER` en
`eventos-dispatcher.js`, anotación `pendiente_sin_listener` en `handleSaludEventos`, y aviso visual en el
panel (card + badge por tipo). No cambia el contrato de `despacharEvento`/`despacharPendientes` ni ninguna
tabla — es puramente de anotación/presentación.

---

## 3. El piloto recomendado (para no discutir en abstracto)

Un solo flujo real, de punta a punta, usado como caso de prueba en las fases 1 a 5:

**Pedido → Facturación → Stock → Cuenta corriente → Notificación**

Es el flujo más repetido del sistema y el que más se nota cuando falla. Elegir 1–2 empresas piloto (usando
el flag por tenant del principio general) y llevar este flujo completo a través de las fases 1 a 5 antes de
generalizar a cualquier otro flujo. Recién con esto funcionando de punta a punta en producción real, se
decide el orden de los próximos flujos a migrar (cobranzas, compras, devoluciones...).

---

## 4. Cómo se mide que esto funcionó

- **Tiempo de propagación:** de la acción en un portal a que se refleje en otro — objetivo: bajo 2 segundos.
- **Notificaciones entregadas / notificaciones esperadas:** hoy probablemente cercano a 0% por el bug de
  VAPID; objetivo post-fase 4: arriba de 95%.
- **Líneas de código de "orquestación manual" eliminadas:** cuántos `require()` cruzados entre handlers de
  negocio se pudieron retirar después de la fase 3.
- **Cobertura de auditoría de negocio:** % de tipos de evento relevantes que quedan efectivamente
  registrados en `eventos_negocio`.
- **Tiempo para agregar un módulo nuevo:** si hoy agregar "fidelización" implica tocar 5 handlers viejos, el
  objetivo post-fase 6 es que solo implique agregar un listener nuevo.

---

## 5. Qué NO hacer (anti-patrones a evitar activamente)

- No rearquitecturar todo de una — ya se descartó, pero vale repetirlo como línea roja.
- No activar Realtime o el despachador de eventos para todas las empresas a la vez sin haber validado con
  el piloto primero.
- No dejar el código viejo y el nuevo corriendo en paralelo para la misma empresa (fase 3) — es la fuente
  más probable de bugs de doble-ejecución (como el bug de doble cobro que ya se resolvió una vez en
  `emitirFactura`/`registrar_cobro_completo` — no repetir ese patrón de error).
- No confundir "auditoría técnica" (quién tocó qué fila, ya cubierta) con "auditoría de negocio" (qué
  decisión se tomó) — son la fase 5, y usan la misma tabla de eventos pero cumplen objetivos distintos.
