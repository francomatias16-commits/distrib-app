# Auditoría de bugs — Fluxo v954 (pre-lanzamiento)

Documento maestro y vivo. Se va completando etapa por etapa a medida que
avanza la auditoría, sin perder lo ya encontrado. Última actualización:
Etapa 7 (seguridad transversal) CERRADA v965. Etapa 8 (cobertura de tests
vs. bugs históricos) EN CURSO v967 — v966 agregó tests de regresión para
los 2 hallazgos 🔴 Crítico que no tenían ninguno (`whatsappHandler` sin
auth y `crearDevolucionCore`, el del incidente real de ~$9,86M); v967
investigó y corrigió los 5 tests preexistentes rotos que v966 había
dejado pendientes (los 5 eran mocks desactualizados, no bugs reales) más
uno adicional encontrado al correr la suite real (`eventos-dispatcher.test.js`,
mismo patrón). **Suite completa en verde: 1032/1032 tests, 52/52
archivos**, verificado 3 veces. Etapas 2b y 4 siguen cerradas de rondas
anteriores. Etapas 3, 5 y 6 marcadas como completas por confirmación
directa del usuario (sin changelog propio localizado en el repo a la
fecha — si aparece, reemplazar esa nota por la referencia concreta).
Queda pendiente Etapa 9 (cierre e informe final) y terminar de barrer el
resto de hallazgos 🟠/🟡 ya resueltos contra `tests/` dentro de la Etapa 8
(el barrido hecho hasta ahora priorizó severidad real, no cobertura
completa).

> **Reconciliación 2026-08-25:** este es, de los documentos de esta ronda,
> el que menos necesitaba corrección — la mayoría de los ~30 hallazgos ya
> vienen marcados ✅ con comentario en el propio código citando la
> auditoría, y lo verificado (spot-check de #15 en `lib/handlers/score.js`,
> #17 en `ui-utils.js`, #14 en `notif.js`) coincide con lo que dice el
> documento. Dos correcciones puntuales:
> - **La suite de tests corrida de verdad da 1185/1185 (72/72 archivos)**,
>   no 1097/1097 (68/68) como dice la cabecera — sigue en verde, la cifra
>   solo quedó vieja porque se siguieron agregando tests después de v970.
> - El changelog citado como evidencia de la Etapa 7
>   (`CHANGELOG_v965_etapa7_seguridad_transversal.md`) **no está en el
>   zip** — sí están `CHANGELOG_v969_etapa8_cierre_real.md` e
>   `INFORME_FINAL_ETAPA9.md`, que si se localizan. Puede ser solo un
>   changelog que no viajó en este export; no encontré motivo para dudar
>   del contenido de la Etapa 7 en sí (los hallazgos de seguridad que cita
>   sí están resueltos en el código).
> - Los dos puntos que siguen genuinamente abiertos (**#1, backup nunca
>   restaurado en un proyecto de prueba**, y **#2, checklist de QA manual
>   "toca plata real" nunca corrido en navegador**) siguen abiertos —
>   confirmé contra `AUDITORIA_2026/etapas/09b_backup_automatizado_setup.md`,
>   que en su última línea sigue diciendo textualmente "pendiente de
>   verificación". Son los dos hallazgos que más importa cerrar antes de
>   lanzar, y ninguno es un fix de código — son una prueba de restore y una
>   pasada manual de QA.

---

## Cómo leer este documento

- **Estado del plan**: tabla con las 9 etapas, cuál está cerrada, en curso o
  pendiente.
- **Hallazgos consolidados**: TODOS los hallazgos de todas las etapas,
  ordenados por severidad real (no por etapa), que es el orden en que
  conviene resolverlos antes de lanzar.
- **Detalle por etapa**: la evidencia completa de cómo se llegó a cada
  hallazgo, para trazabilidad.
- **Lo que ya está bien**: para no perder de vista que gran parte del
  sistema ya fue auditado y corregido en rondas anteriores — no hay que
  volver a desconfiar de lo ya cerrado sin motivo nuevo.

### Leyenda de severidad
- 🔴 **Crítico** — pérdida de datos, brecha de seguridad/multi-tenant, dinero
  mal calculado, caída del sistema.
- 🟠 **Alto** — funcionalidad rota o inconsistente en un flujo real de uso.
- 🟡 **Medio** — edge case, UX degradada, deuda técnica con riesgo futuro.
- ⚪ **Bajo** — cosmético, mejora de código.
- ✅ **Verificado OK** — se revisó a fondo y no es un hallazgo, se deja
  registrado para no re-auditarlo de nuevo sin motivo.

---

## Estado del plan (9 etapas)

| # | Etapa | Estado |
|---|-------|--------|
| 0 | Inventario y mapa de dependencias | 🟢 Completa |
| 1 | Base de datos (migraciones, RLS, triggers) | 🟢 Completa (primer barrido) |
| 2 | Backend/API — módulos dinero-crítico (pagos, facturas AFIP, stock) | 🟢 Completa (primer barrido) |
| 2b | Backend/API — Pedidos completo (`pedidos.js`) + resto de handlers | 🟡 En curso (`pedidos.js`/`usuarios.js`/`clientes.js`/`auth.js`/`cierre.js`/`cc_proveedores.js`/`saas.js`/`conciliacion-bancaria.js`/`score.js`/`notif.js` ✅ revisados; ~27 handlers restantes) |
| 3 | Integraciones externas (WhatsApp, OAuth Mercado Pago, Prisma, BCRA, Serper) | 🟢 Completa (confirmado por el usuario; sin changelog propio localizado en el repo) |
| 4 | Frontend por módulo (Productos, POS, Pedidos, Clientes, Stock, Cobranzas, Cta-Cte, Facturación, Cheques, Rutas y portales cliente/chofer/proveedor) | 🟢 Completa (hallazgo 🟡 #24 resuelto — última ronda de la Etapa 4) |
| 5 | Offline-first / sincronización | 🟢 Completa (confirmado por el usuario; sin changelog propio localizado en el repo) |
| 6 | Consistencia end-to-end entre módulos | 🟢 Completa (confirmado por el usuario; sin changelog propio localizado en el repo) |
| 7 | Seguridad transversal (fuera de lo ya cubierto en Etapa 1-2) | 🟢 Completa (v965 — ver `CHANGELOG_v965_etapa7_seguridad_transversal.md`) |
| 8 | Cobertura de tests vs. bugs históricos | 🟢 Completa (v970 — suite verificada dinámicamente en verde **1097/1097** (68/68 archivos); #8/#9 y hallazgo #16 XSS con test de regresión propio — ver `CHANGELOG_v969_etapa8_cierre_real.md` y `CHANGELOG_v970_etapa8_verificacion_dinamica_y_hallazgo5.md`) |
| 9 | Cierre e informe final priorizado | 🟢 Completa (v970 — ver `INFORME_FINAL_ETAPA9.md`) |

---

## Hallazgos consolidados (orden real de prioridad antes de lanzar)

### 🔴 Crítico

**17. ✅ RESUELTO (v962, esta ronda — Etapa 4, `stock.js`). `window.sanitize`/`escHtml` (única fuente de verdad de sanitización XSS del admin, `ui-utils.js`) NO era segura en contexto de atributo HTML — solo en contexto de texto.**

`frontend/admin/js/ui-utils.js` (`window.sanitize`, alias `window.s`, usada
como `escHtml()` en cada módulo que la importa — 53 archivos del admin y
los portales).

La implementación anterior era `div.textContent = str; return div.innerHTML`.
Ese patrón delega en el algoritmo de serialización de NODO DE TEXTO del
HTML Living Standard, que solo escapa `&`, `<`, `>` (y U+00A0) — las
comillas simples/dobles no hacen falta ahí porque un nodo de texto no las
necesita. El problema es que la función se usa en todo el admin para
interpolar valores de usuario (nombre de producto, depósito, cliente,
responsable, etc. — campos sin restricción de caracteres, solo
`maxlength`) DENTRO de atributos HTML entre comillas dobles, patrón
repetido decenas de veces por archivo:

```js
`<button data-nombre="${escHtml(nombre)}">…`
`<img alt="Foto de ${escHtml(nombre)}" …>`
```

Un nombre como `Producto" onmouseover="alert(1)` rompía el atributo y
quedaba XSS persistente ejecutable con solo pasar el mouse por encima —
para CUALQUIER usuario que viera esa fila (otro operador del mismo comercio,
un dueño viendo el panel desde otro dispositivo, etc.), no solo quien cargó
el dato. Se detectó auditando `frontend/admin/js/stock.js` (`renderTabla`,
`renderAvatarFoto`, `renderTablaDepositosAdmin`) pero el vector real está en
la función compartida — afecta a los 53 archivos que la usan, no solo a
Stock.

✅ *Aplicado en v962*: `window.sanitize` reescrita como escapado manual de
`&`, `<`, `>`, `"` y `'` (en ese orden — `&` primero para no doble-escapar
las entidades agregadas por el resto), sin depender del DOM. Sigue siendo
válida en contexto de texto (las entidades se decodifican al renderizar) y
ahora también es segura en contexto de atributo. Fix centralizado en el
único archivo fuente — no hace falta tocar los 53 llamadores. Tests nuevos
en `tests/frontend/ui-utils-sanitize.test.js` (comillas simples/dobles,
`&`/`<`/`>`, no doble-escapado, `null`/`undefined`/número, alias `window.s`).

**0. ✅ RESUELTO (v955). La herramienta de devoluciones del asistente de voz reimplementa la lógica de `crearDevolucionCore` SIN las 3 protecciones agregadas tras el incidente real de producción v805.**
`lib/asistente-tools.js` — tool `registrar_devolucion_pedido` (función
`execute`, apoyada en `resolverDevolucionPedido`, línea ~4371).

Contexto real (documentado en el propio repo,
`CHANGELOG_v805_auditoria_devoluciones_validacion_cantidad_precio.md`): el
17/08/2026 se aprobó en producción una devolución de **4.555 unidades** de
un producto que el cliente había comprado 42 unidades en toda su historia,
vinculada a un pedido que ni siquiera incluía ese producto. Generó 4.555 u.
de stock fantasma y una nota de crédito pendiente por **$9.865.288,69**
(revertido a mano, nunca llegó a emitirse ante ARCA). La causa raíz: el
alta manual (`crearDevolucionCore`) solo validaba "¿el cliente compró esto
alguna vez?", sin tope de cantidad ni verificación de pertenencia al
pedido. Se corrigió agregando 3 controles server-side a
`crearDevolucionCore`:
1. cantidad ≤ comprado histórico − ya reservado en otras devoluciones no
   rechazadas del mismo producto+cliente,
2. si viene `pedido_id`, el producto tiene que pertenecer a ESE pedido,
3. `precio_unitario` se recalcula server-side (del pedido vinculado o
   `precio_base` actual) — nunca se usa el que mande el body.

**Verifiqué que esos 3 controles están vigentes en `crearDevolucionCore`
hoy** (usada por la app del chofer y por el alta manual del admin) — bien
resuelto ahí.

**Pero la tool del asistente de voz `registrar_devolucion_pedido` NO llama
a `crearDevolucionCore`.** El propio comentario en el código dice
literalmente que "se leyó crearDevolucionCore() completo" para replicar la
lógica de nota de débito automática — pero lo que se replicó es el INSERT
en `devoluciones`/`devolucion_items` y la generación de notas de débito;
los 3 controles del punto anterior (que son justamente el fix del
incidente real) **no están**. Concretamente, en `resolverDevolucionPedido`:
- No hay ningún chequeo contra `obtenerComprasPorProductoCliente` /
  `obtenerDevueltoPorProductoCliente` — se puede pedir devolver cualquier
  cantidad de cualquier producto que el asistente logre resolver por
  nombre, sin importar cuánto compró realmente el cliente.
- No hay verificación de que el producto pertenezca al pedido vinculado.
- El precio unitario se toma tal cual de `item.precio_unitario` que manda
  el modelo/usuario (`Number(item.precio_unitario) || 0`) — nunca se
  recalcula server-side. Si el motivo es "producto_defectuoso", ese monto
  (cantidad × precio_unitario, ambos sin validar) se usa directo para
  crear una nota de débito automática al proveedor.

Es exactamente la misma clase de bug que ya costó un incidente real de
~$9,86M en este mismo módulo, ahora accesible por una superficie nueva
(un asistente conversacional, con todo lo que eso implica de
interpretación de lenguaje natural y posible error de "cuánto"/"cuál
pedido" al resolver la intención del usuario). El `requiereConfirmacion:
true` obliga a que un humano apruebe un resumen en texto antes de
ejecutar, pero ese resumen no expone ningún cruce contra el historial real
de compras — no protege contra el mismo error que ya ocurrió una vez.
→ *Fix:* hacer que `registrar_devolucion_pedido` llame directamente a
`crearDevolucionCore` (mismo patrón que ya usan `pos.js` y `pedidos.js`)
en vez de reimplementar el INSERT a mano, para heredar automáticamente
cualquier control presente y futuro sobre este flujo. Si por algún motivo
no puede reusarse tal cual (la tool no tiene chofer_id/offline_local_id),
como mínimo replicar los 3 controles de v805 antes de habilitar esta tool
en producción.
✅ *Aplicado en v955*: `registrar_devolucion_pedido` llama ahora a
`crearDevolucionCore` (exportada), pasando `usuarioId` como `chofer_id`.
Ver `CHANGELOG_v955_fix_devolucion_asistente_v805_y_timezone_chofer.md`.

**1. Backup de Supabase nunca probado en restauración (infraestructura, no código).**
Plan Free de Supabase (sin PITR nativo). Hay mitigación parcial ya funcionando
(backup semanal automático vía GitHub Actions: `pg_dump` + cifrado GPG,
retención 90 días — workflow `backup-supabase.yml` corriendo en verde), pero
la restauración de ese backup **nunca se ejecutó ni se probó**. El propio
equipo lo señaló como "el hallazgo más grave de toda la auditoría" y sigue
abierto a la fecha del último checklist (16/08).
→ *Acción:* restaurar el backup más reciente contra un proyecto Supabase de
prueba. ~20 minutos. Es lo único que priorizaría por encima de cualquier bug
de código: si algo corrompe datos en producción hoy, no hay certeza de poder
volver atrás.

**14. ✅ RESUELTO (v960, esta ronda). `/api/notif/whatsapp` (envío de templates WhatsApp) no tenía NINGÚN control de acceso — cualquiera, sin login, podía disparar mensajes reales.**
`lib/handlers/notif.js` — `whatsappHandler` (`_svc=whatsapp`, usado por
`pedidos.js` y `rutas.js` del admin para avisar despacho/entrega/ruta
asignada).

A diferencia de todos los demás `_svc` de este mismo archivo
(`reintentar-email`, `whatsapp-conversacion-accion`,
`whatsapp-embedded-signup`, todos con `verificarToken()`+`puede()`),
`whatsappHandler` solo pasaba por el rate limiter general de WhatsApp
(`limiterWhatsApp`) — sin Bearer, sin rol, sin nada. Además tomaba
`empresa_id` directo del body en vez de la sesión.

Impacto real, no teórico:
- **Sin `empresa_id` en el body** (que es exactamente cómo lo llamaban
  `pedidos.js`/`rutas.js` — ninguno de los dos lo mandaba) el handler cae
  en el fallback de `resolverCredencialesWhatsapp()`: el número/token
  **compartido de la plataforma**, gateado solo por la env var global
  `WA_NOTIF_SALIENTES_HABILITADAS`. Con esa env en `true` (el estado
  esperado en producción para que las notificaciones de pedidos
  funcionen), cualquiera con la URL del endpoint — sin cuenta, sin
  login — podía enviar cualquiera de los templates aprobados
  (`pedido_despachado`, `ruta_asignada`, etc.) a cualquier número de
  teléfono. Costo real por Meta por cada envío, y superficie de
  phishing/spam usando plantillas que simulan avisos legítimos de
  pedido ("tu pedido está en camino").
- **Con `empresa_id` explícito** (aceptado igual, el body nunca se
  validaba) se podía además elegir de qué empresa con número propio se
  descontaba/facturaba el envío — mismo patrón de suplantación de tenant
  que AUTOMATIZACION-001 (confiar en un `empresa_id`/identificador que
  manda el cliente en vez de derivarlo siempre de la sesión), pero acá
  sin necesitar ninguna cuenta en absoluto.
→ *Fix aplicado*: `whatsappHandler` ahora exige `verificarToken()` +
`puede(perfil, 'enviar', 'whatsapp_template')` (rol nuevo agregado a
`permisos-service.js`, mismo set que `whatsapp_panel`: dueño/admin/
vendedor), y `empresa_id` se toma siempre de `perfil.empresa_id`, nunca
del body. Corregidos también los dos callers del frontend
(`pedidos.js` función `enviarWhatsApp`, `rutas.js` función
`notificarChofer`) que no mandaban el header `Authorization` — mismo
bug de origen que el resto de los fetch de esos archivos ya corrige
(ver BUG-08 en `rutas.js`, que solo cubría el chequeo de `resp.ok`, no
la falta de auth). Sin uso interno de `whatsappHandler` como función
(los crons de cheques/deuda usan `enviarAvisoChequesPorVencer`, una
función separada), así que el fix no rompe ningún flujo automático.
**Pendiente:** deploy (`vercel --prod`) — el fix está en el código de
este ZIP, no en producción todavía.

### 🟠 Alto

**15. ✅ RESUELTO (v960, esta ronda). `GET /api/score?accion=cliente` sin chequeo de rol — un cliente del portal podía ver el score/deuda/límite de crédito de OTRO cliente de la misma empresa.**
`lib/handlers/score.js`, acción `cliente` (usada por `frontend/admin/js/clientes.js` y `riesgo-cheques.js` para mostrar la ficha de score de un cliente en el admin).

Este mismo archivo ya tiene, para las acciones `alertas`, `resolver-alerta`
y `reglas`, un comentario `FIX (auditoría, etapa 12)` explicando
exactamente este patrón de bug: sin un chequeo de rol después de
`verificarToken()`, cualquier usuario autenticado de la empresa —
incluido un cliente con acceso al portal (`rol: 'cliente'`) — podía
llamar el endpoint directo (no hace falta pasar por el admin, alcanza
con el token válido de su propia sesión de portal) y listo. La acción
`cliente` (que trae `historialScore`, `obtenerScoreCliente` —
`score_actual`, `limite_credito`, `dias_credito` — y si recibió una
oferta de plan de pago por deuda) se quedó afuera de esa corrección: no
tenía ningún chequeo de rol, solo exigía sesión válida. Los repos
subyacentes (`ScoreRepo.historialScore`, `ClienteRepo.obtenerScoreCliente`,
`NotifRepo.ultimoEnvio`) solo scopean por `empresa_id`, no por el
`cliente_id` del que hace la consulta — así que un cliente logueado en
el portal podía pasar el `cliente_id` de un competidor/otro cliente de
la misma distribuidora (dato no secreto — aparece en URLs, listados
públicos de precios, etc.) y ver su información financiera de riesgo.
→ *Fix aplicado*: mismo gate que las acciones hermanas —
`['dueno','admin','vendedor','contador'].includes(perfil?.rol)`.

**22. ✅ RESUELTO (v962, esta ronda — Etapa 4, `rutas.js`). XSS almacenado en el popup del mapa de seguimiento en vivo de Rutas — `receptor`, `cliente` y `dir` insertados sin escapar en el `.bindPopup()` de Leaflet, con escalamiento chofer → admin.**
`frontend/admin/js/rutas.js`, `inicializarMapa()` (mapa de la pestaña
"Seguimiento", tab `seguimiento`).

Mismo patrón que los hallazgos #16/#19/#20/#21 de rondas anteriores, con un
agravante propio: el mismo archivo `rutas.js` ya tiene el fix correcto
aplicado en otros tres lugares que muestran `e.receptor` (modal de detalle
de entrega, tabla de reportes, popup del mapa de reporte cerrado) — solo
quedó afuera el popup del mapa de seguimiento *en vivo*. `receptor` es un
campo de texto libre (`frontend/chofer/remito.html`, input
`#receptorEntrega`, placeholder "Ej: Juan (encargado)") que el chofer carga
al confirmar una entrega; viaja tal cual hasta este popup. Es una vía de
escalamiento real: un chofer (rol de menor privilegio) confirma una entrega
con un `receptor` malicioso (`<img src=x onerror=...>`) y el payload corre
en el navegador de cualquier dueño/admin/vendedor que tenga abierto el mapa
de seguimiento en vivo mientras la entrega se confirma — sin necesitar que
nadie abra el detalle ni el reporte cerrado de esa ruta. `cliente`
(razón social) y `dir` (domicilio), en el mismo popup, tenían el mismo
problema aunque son datos cargados por un rol de mayor privilegio (ABM de
Clientes).
→ *Fix aplicado*: `cliente`, `dir` y `e.receptor` envueltos en `esc()`
dentro del `.bindPopup()`, igual que ya hacían los otros tres lugares del
archivo.

**16. ✅ RESUELTO (v960, esta ronda). XSS almacenado en el panel de alertas de score de Clientes — nombre de cliente insertado sin escapar en el `innerHTML`.**
`frontend/admin/js/clientes.js`, `renderAlertasScorePanel()` (widget
`#panel-alertas-score`, visible en `clientes.html`).

`a.mensaje` sí pasaba por `sanitize()`, pero `a.clientes?.razon_social`
se insertaba crudo dentro de un `<strong>` — a diferencia de absolutamente
todo el resto del archivo, que usa `sanitize()`/`escHtml()` de forma
consistente (confirmado revisando los 56 `innerHTML` del archivo). A
diferencia del hallazgo ⚪ #6b de Pedidos (un `<select>`, donde el propio
modelo de contenido del navegador bloquea la mayoría de payloads), acá es
un `<div>` normal — sí es explotable. Como `razon_social` lo carga
cualquier usuario con permiso de ABM de Clientes (dueño/admin/**vendedor**),
esto es una vía de escalamiento real: un vendedor (rol de menor
privilegio) da de alta un cliente con un nombre malicioso
(`<img src=x onerror=...>`), y el payload corre en el navegador de
cualquier dueño/admin/contador que abra la página de Clientes con
alertas de score pendientes — mismo tipo de hallazgo que MIGRACION-001.
→ *Fix aplicado*: envuelto en `sanitize()`, igual que `a.mensaje` en la
misma línea de arriba.
→ *Test de regresión* (v969): `tests/frontend/clientes.test.js` — se
había quedado afuera de la tabla de cierre de la etapa 8 en v968 pese a
que el changelog daba por cerrado el bloque de XSS almacenado.

**2. Checklist de QA manual "toca plata real" nunca ejecutado en navegador.**
El propio checklist de pre-lanzamiento interno tiene ~10 verificaciones de UI
redactadas pero no probadas contra un navegador real, incluyendo una marcada
explícitamente **"toca plata real, no saltear"**: que el precio de catálogo,
carrito y checkout coincidan cuando hay una regla de precio especial
aplicada (F4-02). También las animaciones nuevas del dashboard, validadas
"solo por sintaxis, nunca en navegador real". Son regresiones que el propio
equipo ya sospecha y no cerró — más urgente que buscar bugs nuevos.
→ *Acción:* correr el checklist de `AUDITORIA_PRE_LANZAMIENTO.md` sección
"🔴 BLOQUEANTE — antes de publicar" en un navegador real antes de publicar.

**3. ✅ RESUELTO (v967, esta ronda). Dos migraciones de seguridad RLS sin prefijo de orden.**
`supabase/migrations/fase5_eventos_negocio_rls_dueno_admin.sql` y
`fix_rls_notif_log_scope_por_rol.sql` son las únicas 2 de 403 migraciones
sin prefijo numérico ni timestamp. Supabase aplica migraciones en orden
alfabético de archivo; los dígitos ordenan antes que las letras en ASCII, así
que estas 2 **siempre se van a aplicar después de cualquier migración futura**
que use el prefijo estándar (el 100% de las demás). Ambas son fixes reales de
seguridad ya aplicados (cierran una fuga donde cualquier cliente/chofer podía
leer `notif_log` o `eventos_negocio` de otros clientes de la misma empresa).
Riesgo: una migración nueva que vuelva a tocar esas policies quedaría
aplicada ANTES que estos fixes, reabriendo el agujero sin que se note (el fix
"ya está en el repo" a simple vista).
→ *Fix:* renombrar ambos archivos con timestamp real (ej.
`20260821000000_fase5_...sql`) y agregar un test de RLS que falle si
`eventos_negocio` o `notif_log` vuelven a quedar legibles fuera de
dueño/admin/cliente propio (ver Etapa 8).
✅ *Aplicado en v967*: ambos archivos renombrados
(`20260824030001_fase5_...`/`20260824030002_fix_rls_notif_log_...`) y
registrados en `schema_migrations_registry` (nunca habían tenido fila ahí
— por no tener prefijo numérico, el script de reconciliación las
ignoraba; confirmado que ya estaban aplicadas en producción bajo el
nombre viejo, así que el rename no vuelve a ejecutar el contenido). Test
de regresión: `tests/scripts/migraciones-orden.test.js`.

**Hallazgo adicional descubierto al correr ese test por primera vez
contra la suite real** (no estaba en el radar de esta ronda): la
comparación de prefijos del test reveló que `540_reconstruccion_
retroactiva_calcular_deuda_cliente_cons_01_02_03.sql` y `541_fix_
calcular_score_cliente_componente_deuda_cons_04.sql` (Etapa 6, sesión
2026-08-24, sin relación con RLS) tenían exactamente el mismo problema:
prefijo secuencial corto sin timestamp, nunca registrados en
`schema_migrations_registry`. Mismo riesgo de orden que el hallazgo
original. Renombrados igual (`20260824030004`/`20260824030005`) y
registrados en la misma migración de registro. De paso se ajustó la 3ra
aserción del test: comparar el prefijo de fase5/notifLog contra *todas*
las demás migraciones como string daba falsos positivos contra el resto
de prefijos secuenciales cortos legacy (001-525, ~364 archivos —
conviven con el formato timestamp vigente desde ~513 sin que sea un
riesgo real, son historia ya aplicada). Se acotó la comparación al
formato de 14 dígitos vigente, que es el único relevante para "qué
migración futura podría colarse antes". **Suite completa verificada 3
veces: 1044/1044 tests, 54/54 archivos, en verde.**

**7. ✅ RESUELTO (v955). `GET /api/chofer/clientes` calcula "hoy" en UTC, no en horario Argentina — mismo bug que ya se había corregido en la ruta hermana `remitos`.**
`lib/handlers/pedidos.js:2746` — `const hoy = new Date().toISOString().slice(0, 10)`.

Unas 400 líneas antes, en la misma función `handleChofer`, la ruta
`GET /api/chofer/remitos` tiene un fix explícito y bien documentado para
exactamente este problema: calcular "hoy" con `toISOString()` da la fecha
en UTC, y como Vercel corre en UTC y Argentina es UTC-3, entre las 21:00 y
las 23:59 hora ART el sistema ya está calculando "mañana". Ahí se
reemplazó por `hoyArgentina()`
(`new Date().toLocaleDateString('en-CA', { timeZone:
'America/Argentina/Buenos_Aires' })`).

La ruta `GET /api/chofer/clientes` (pantalla "Mis clientes" del chofer,
usada para ver domicilio/teléfono de a quién le está repartiendo) nunca
recibió ese mismo fix — sigue usando `new Date().toISOString().slice(0,
10)`. Efecto concreto: cualquier chofer que abra "Mis clientes" entre las
18:00 y 20:59 UTC (21:00–23:59 hora Argentina) — horario totalmente
plausible para terminar un reparto — va a consultar `listarRutasDelDia`
con la fecha de mañana, que casi seguro no tiene rutas creadas todavía, y
la pantalla le va a mostrar una lista vacía de clientes aunque su ruta de
hoy siga activa y con entregas pendientes. No afecta a `remitos` (ya
corregido) ni a `entregar`/`no-entregar` (no dependen de la fecha), solo a
esta pantalla puntual.
→ *Fix:* reusar la misma `hoyArgentina()` (ya definida más arriba en el
mismo archivo, dentro del bloque de `remitos`) en vez de recalcular la
fecha en UTC — moverla a una función de módulo si hace falta compartirla
entre ambos bloques sin duplicar código.
✅ *Aplicado en v955*: `hoyArgentina()` subida a scope de módulo, usada por
`remitos` y `clientes` por igual.

**10. ✅ RESUELTO (v957). Cambiar/resetear la contraseña no invalida las sesiones (refresh tokens) existentes del usuario.**
`lib/handlers/auth.js` — `handleChangePassword` y
`handleConfirmarCodigoWhatsapp` actualizaban la contraseña en Supabase Auth
pero nunca tocaban la tabla `refresh_tokens` propia del proyecto (usada por
el login cookie-JWT del portal admin/chofer). Si una sesión estaba
comprometida (refresh token robado — XSS, dispositivo perdido, log
filtrado), la vía "obvia" para el usuario de cortar el acceso —cambiar la
contraseña— no lograba nada: el atacante seguía pudiendo pedir access
tokens nuevos con el refresh token que ya tenía hasta que expirara solo (7
días) o hasta que alguien lo revocara a mano. No hay otro archivo en el
repo con este patrón (es la única tabla `refresh_tokens` del proyecto), así
que no es una inconsistencia con un precedente propio, sino un gap real en
el diseño del flujo de sesiones.
→ *Fix:* revocar (`revocado = true`) todos los refresh tokens activos del
usuario inmediatamente después de un cambio de contraseña exitoso, mismo
criterio que cualquier sistema de auth con "cerrar todas las demás
sesiones" implícito en un cambio de contraseña.
✅ *Aplicado en v957*: nueva `revocarSesionesUsuario()` en `auth.js`,
llamada desde `handleChangePassword` y `handleConfirmarCodigoWhatsapp`
(reset por WhatsApp del portal cliente) tras actualizar la contraseña.
**Gap residual conocido y no cerrado**: el reset por email
(`handleResetPassword` → link mágico de Supabase) completa la actualización
100% client-side (`sb.auth.updateUser()` en `restablecer-password.html`),
sin volver a pasar por este backend — no hay hook server-side disponible
para revocar sesiones en ese camino sin agregar un webhook de Supabase Auth
o un endpoint de confirmación propio. Queda documentado para una vuelta
futura si se prioriza cerrar el 100% de los caminos.

**11. ✅ RESUELTO (v957). `procesarNotifVencimiento` (recordatorio de deuda por WhatsApp, `cierre.js`) descartaba cualquier error en silencio total — ni siquiera `console.error`.**
`lib/handlers/cierre.js` — el `fetch(...)` a `/api/notif/whatsapp` tenía un
`.catch(() => {})` que tragaba el error sin dejar rastro, a diferencia de
prácticamente cualquier otro disparo de WhatsApp del repo (que como mínimo
hacen `console.error`, y varios —`notificarPedidoConfirmado`,
`notificarEstado` desde v956— además loguean en `notif_log`). Si el aviso
de vencimiento fallaba (token vencido, rate limit de Meta), no quedaba
ningún indicio de que el cliente nunca se enteró de su deuda próxima a
vencer.
→ *Fix:* chequear `resp.ok`, loguear éxito/falla vía `NotifRepo.registrarLog`
(tipo `recordatorio_vencimiento`, canal `whatsapp`) y `console.error` en
caso de falla — mismo criterio que el resto del repo.
✅ *Aplicado en v957*.

### 🟡 Medio

**24. ✅ RESUELTO (v962, esta ronda — Etapa 4, portal cliente `checkout.html`). XSS almacenado en la pantalla "Confirmar Pedido" — nombre y unidad de producto insertados sin escapar en el `innerHTML`, único archivo del portal cliente sin ninguna función de escape.**
`frontend/cliente/checkout.html`, render de la lista de ítems del pedido
sugerido (pantalla pública de confirmación que llega al cliente por
WhatsApp/link, antes de loguearse).

Mismo patrón que #16/#19/#20/#21/#22: `item.productos?.nombre` y
`item.productos?.unidad` se interpolaban crudos dentro de un
`div.innerHTML`. A diferencia de los demás archivos del portal cliente
(`inicio.html`, `catalogo.html`, `carrito.html`, `cuenta.html`,
`pedidos.html`, `notificaciones.html` — los seis usan una función `esc()`
de forma consistente), este archivo no tenía ninguna función de escape
definida: es el único punto de todo el portal cliente donde el dato viaja
sin pasar por ningún filtro. El nombre/unidad de producto lo carga
cualquier usuario con permiso de ABM de Productos (dueño/admin/vendedor)
— mismo vector de escalamiento que los hallazgos anteriores.
→ *Fix aplicado*: agregada la misma función `esc()` que usan los otros
archivos del portal cliente y envueltos ambos campos.

**18. ✅ RESUELTO (v962, esta ronda — Etapa 4, `stock.js`). `guardarAjuste()` traducía CUALQUIER excepción del `catch` general a un mensaje fijo de "problema de conexión", incluso cuando el error real no tenía nada que ver con la red.**
`frontend/admin/js/stock.js`, `guardarAjuste()` (modal único de
ingreso/egreso/transferencia/ajuste/producción, línea ~1354).

Cada rama (`transferir_stock`, `registrar_conteo_stock`,
`producir_con_insumos`, `ajustar_stock`) ya distingue correctamente error de
red (encola offline vía `esErrorDeRed` + `StockOffline`) de rechazo de
negocio (`!data?.ok` → `toast(data?.error || …)`, mensaje específico del
backend). Pero cualquier excepción que no encajara en esas dos rutas —
error de sintaxis en el propio JS, un `throw error` de Supabase que no sea
de red (permiso RLS, columna inexistente, timeout distinto a network
error), etc. — caía en el `catch` final, que mostraba siempre "No se pudo
guardar el movimiento por un problema de conexión" sin importar la causa
real. Un usuario viendo ese mensaje reintentaba una y otra vez pensando que
era su wifi, cuando el problema podía ser, por ejemplo, un permiso mal
configurado que ningún reintento iba a arreglar — y de soporte no había
forma de distinguir el caso real sin pedir la consola del navegador.
→ *Fix aplicado*: el mensaje genérico ahora deja explícito que puede no ser
de conexión ("Probá de nuevo en unos segundos; si persiste, avisá a
soporte" en vez de implicar que es la red) y se loguea `console.error(err)`
antes del toast (ya estaba, se mantiene) para que soporte pueda pedir el
log real en vez de asumir a ciegas que es un corte de red.

**19. ✅ RESUELTO (v962, esta ronda — Etapa 4, `cobranzas.js`). XSS almacenado en la tabla de "Facturas pendientes" — número de factura, nombre de cliente y etiqueta de prioridad insertados sin escapar en el `innerHTML`.**
`frontend/admin/js/cobranzas.js`, función de render de la tabla de facturas
(cargada junto a `cta-cte.js` en `cobranzas.html`).

Mismo patrón que el hallazgo 🟠 #16 en Clientes: `f.numero_factura`,
`f.cliente_nombre` y el `label` del chip de prioridad se interpolaban
crudos dentro de celdas `<td>`, mientras el resto del archivo sí pasaba
datos de usuario por `window.sanitize()`. `cliente_nombre` en particular lo
carga cualquier usuario con permiso de ABM de Clientes — mismo vector de
escalamiento que #16: un nombre malicioso cargado por un rol de menor
privilegio se ejecuta en el navegador de cualquiera que abra Cobranzas.
→ *Fix aplicado*: los tres valores envueltos en `window.sanitize()`.

**20. ✅ RESUELTO (v962, esta ronda — Etapa 4, `cta-cte.js`). XSS almacenado en la tabla de "Saldos por cliente" — nombre del cliente insertado sin escapar en el `innerHTML`, de forma inconsistente con la línea siguiente.**
`frontend/admin/js/cta-cte.js`, `renderTabla()` (vista principal de Cuenta
corriente).

`nombre` (`c.nombre_fantasia || c.razon_social`) se insertaba crudo en el
`<div>` del nombre del cliente, mientras dos líneas más abajo el propio
código SÍ envuelve `c.razon_social` en `sanitize()` cuando difiere del
nombre de fantasía mostrado — inconsistencia dentro de la misma función,
mismo dato. El resto del archivo (movimientos del panel de detalle, modal
de cobro, envío de estado de cuenta) sanitiza correctamente o usa
`.value`/`.textContent`, que no son vector de XSS.
→ *Fix aplicado*: `nombre` envuelto en `sanitize()`.

**21. ✅ RESUELTO (v962, esta ronda — Etapa 4, `facturacion.html`). XSS almacenado en la pestaña "Comprobantes históricos" — número original, cliente y observaciones insertados sin escapar en el `innerHTML`.**
`frontend/admin/facturacion.html`, script inline `type="module"`,
`renderComprobantesHist()` (pestaña de solo lectura sobre
`comprobantes_historicos`, poblada únicamente desde el wizard de
migración — `frontend/admin/js/migracion.js` / `lib/handlers/migracion.js`,
fuera del alcance de esta ronda).

A diferencia de `facturacion.js` y `notas-credito.js` (los otros dos
scripts cargados en la misma página), que sanitizan de forma consistente
todo dato de usuario antes de interpolarlo, este script inline no lo
hacía: `r.numero_original`, `r.clientes?.nombre_fantasia/razon_social` y
`r.observaciones` se insertaban crudos. Estos tres campos son texto libre
cargado a mano por quien corre el wizard de migración de datos
históricos (por eso vienen sin restricción de caracteres, a diferencia
del resto de los campos de una factura normal, que son numéricos/CAE/
fechas generados por el sistema) — mismo patrón de XSS almacenado que los
hallazgos #16/#19/#20, con el agravante de que esta vista es de solo
lectura para cualquiera con acceso a Facturación, no solo para quien
cargó el dato.

De paso, el mensaje de error de `cargarComprobantesHistoricos()` (catch)
también se interpolaba sin sanitizar en el mismo `innerHTML` — improbable
como vector real (el mensaje sale de `data.error` del propio backend o de
un error de JS), pero se corrigió por consistencia defensiva.

→ *Fix aplicado*: los tres campos y el mensaje de error envueltos en
`window.sanitize()` (el script es un módulo, así que no tiene acceso a la
función local `escHtml()` de `facturacion.js` — se referencia
`window.sanitize` directo, igual que hacía ya `notas-credito.js`).

 El propio mecanismo de alerta "WhatsApp desconectado" (`alertarTokenWhatsAppVencido`) puede fallar en silencio total.**
`lib/handlers/notif.js` — los 2 puntos donde se detecta el error 190 de Meta
(token vencido/inválido), uno en el endpoint de templates salientes y otro
en el webhook entrante, llamaban a `alertarTokenWhatsAppVencido(...).catch(()
=> {})`. A diferencia de `notifAuto()` (que envuelve todo internamente en
try/catch y siempre deja rastro en `notif_log`, ver comentario de
`_auto-push.js`), `alertarTokenWhatsAppVencido` NO tiene ese blindaje
interno: si `listarAdminsDueno`, `ultimoEnvioPorTipo` o `registrarLog` fallan
(hiccup de DB), la función entera rechaza y el `.catch(() => {})` del caller
se traga el error sin dejar ningún indicio. El propio comentario del código
dice explícitamente que esta alerta existe para que "el corte de WhatsApp no
pase desapercibido hasta que alguien revise logs de Vercel días después" —
exactamente el escenario que puede ocurrir si la alerta misma falla sin
loguear nada. Mismo patrón de `marcarEstadoTokenWhatsapp` (limpia el flag de
"necesita reconexión" cuando un envío vuelve a andar): si falla en silencio,
el panel queda mostrando "necesita reconexión" para siempre aunque WhatsApp
ya esté funcionando de nuevo.
→ *Fix:* agregar `console.error` en los 4 call-sites (`notif.js`, endpoint de
templates + webhook, para `alertarTokenWhatsAppVencido` y
`marcarEstadoTokenWhatsapp`) — no bloquea la respuesta HTTP (sigue siendo
fire-and-forget), pero deja rastro en los logs de Vercel en vez de silencio
total.
✅ *Aplicado en v958*.

**13. ✅ RESUELTO (v958). Recalculo de score del cliente tras registrar una devolución (`pedidos.js`) descarta cualquier error sin loguear nada.**
`lib/handlers/pedidos.js` (bloque de registro de devolución) —
`calcularScoreClienteRpc(...).then(() => {}).catch(() => {})`, fire-and-forget
a propósito (no debe bloquear la respuesta de la devolución) pero sin
ningún `console.error`. El mismo archivo tiene el patrón correcto ~300
líneas más abajo, en la revisión de devoluciones (aprobar/rechazar): ese
call-site sí espera con `await` dentro de un `try/catch` con comentario
explícito (`FIX v803`, sobre el bug real de que este RPC devuelve un
"thenable" que no tiene `.catch()` propio — de ahí que el fire-and-forget
tenga que ser `.then().catch()` y no `.catch()` directo). El mecanismo en sí
está bien armado (no revienta con 500), pero si el recálculo falla de
verdad, el score del cliente queda desactualizado tras la devolución sin que
quede ningún rastro para detectarlo.
→ *Fix:* agregar `console.error` al `.catch()` existente, mismo criterio que
`ofrecerPlanDePago` (`score.js`) unas líneas más abajo en el propio archivo.
✅ *Aplicado en v958*.

**8. ✅ RESUELTO (v956). `notificarEstado` (WhatsApp de "pedido despachado") no chequea la respuesta ni deja rastro en `notif_log` — a diferencia de todas sus funciones hermanas.**
`lib/handlers/pedidos.js:644` — `await fetch(...)` sin capturar el
resultado, sin `try/catch`, sin `_logNotif`.

El propio archivo tiene el patrón correcto documentado y aplicado en 2
lugares: `notificarPedidoConfirmado` (línea ~1513) chequea `resp.ok`,
loguea éxito y falla en `notif_log` vía `_logNotif`, y envuelve todo en
`try/catch` para capturar errores de red. `notificarDespachoPorEmail`
(la función justo después de `notificarEstado`, misma llamada disparada
en el mismo evento) tiene un comentario `FIX (Hallazgo 2, auditoría
notificaciones)` explícito documentando que ANTES no dejaba rastro de
éxito/falla y que eso ya se corrigió. `notificarEstado` — la versión
WhatsApp de ese mismo aviso de despacho — nunca recibió el mismo trato:
si `/api/notif/whatsapp` devuelve un error (token vencido, template
inválido, rate limit de Meta), la promesa igual resuelve (fetch solo
rechaza por falla de red, no por status HTTP) y el `.catch(console.error)`
del caller nunca se dispara — el aviso de despacho por WhatsApp puede
fallar en silencio total, sin log, sin entrada en `notif_log`, sin nada
que un futuro botón de "reintentar" pueda usar.
→ *Fix:* aplicar el mismo patrón que `notificarPedidoConfirmado`: chequear
`resp.ok`, loguear resultado (éxito/falla) vía `_logNotif` con tipo
`pedido_despachado`/canal `whatsapp`, y envolver en `try/catch`.
✅ *Aplicado en v956*: `notificarEstado` reescrita siguiendo exactamente el
patrón de `notificarPedidoConfirmado` — chequea `resp.ok`, loguea éxito y
falla vía `_logNotif` (motivos `sin_telefono`/`error_envio`/`excepcion`), y
todo el fetch queda envuelto en `try/catch`. El caller (línea 426) no
cambió: sigue siendo fire-and-forget con `.catch(console.error)`, pero
ahora el log real queda en `notif_log` antes de eso.

**9. ✅ RESUELTO (v956). `confirmar_pedido_sugerido` (RPC) tiene una condición de carrera check-then-update, a diferencia del patrón atómico que el propio archivo usa para el caso equivalente en Presupuestos.**
`supabase/migrations/068_piloto_whatsapp.sql` (función
`confirmar_pedido_sugerido`, sin cambios posteriores) — hace un
`SELECT ... WHERE estado = 'sugerido'` y, si existe, un `UPDATE` aparte
sin `WHERE estado = 'sugerido'` ni `SELECT ... FOR UPDATE`. Dos requests
concurrentes al link público de confirmación (`confirmarPedidoSugeridoHandler`,
sin login, doble tap del cliente o reintento de red del lado del
WhatsApp bot) pueden pasar ambas el chequeo antes de que la primera
actualice, y las dos ejecutan el `UPDATE`.

Impacto real acotado: el estado final es idempotente (ambas escriben
`estado = 'pendiente'`), no se duplica el pedido ni se generan dos
efectos secundarios de negocio distintos — pero sí queda una segunda fila
de auditoría (`registrarAuditoriaSilenciosa`) para la misma transición,
y en general es una construcción fragile: cualquier efecto secundario que
se agregue a futuro dentro de esta RPC (o justo después, en el handler)
heredaría la misma condición de carrera sin que sea obvio a simple vista.

El propio archivo demuestra el patrón correcto para el problema gemelo:
`handlePresupuestos` (PATCH, estado `aceptado`) usa
`bloquearPresupuestoAceptado` — un lock optimista documentado como
"v85: el UPDATE solo procede si estado sigue siendo 'enviado' — previene
que dos vendedores simultáneos generen dos pedidos del mismo presupuesto"
— exactamente el mismo tipo de guard que le falta a
`confirmar_pedido_sugerido`.
→ *Fix:* reescribir la RPC como un único `UPDATE ... WHERE id = $1 AND
empresa_id = $2 AND cliente_id = $3 AND estado = 'sugerido' RETURNING
numero_pedido` (o agregar `SELECT ... FOR UPDATE` antes del check),
mismo criterio que `bloquearPresupuestoAceptado`.
✅ *Aplicado en v956*: `confirmar_pedido_sugerido` reescrita como UPDATE
atómico único (migración `20260824000000_537_...sql`) — el WHERE incluye
`estado = 'sugerido'`, así que solo una ejecución concurrente puede
afectar la fila; la segunda recibe `ok:false` sin haber tocado nada. De
paso, `confirmarPedidoSugeridoHandler` ya no llama a
`registrarAuditoriaSilenciosa` cuando `data.ok` es `false`, evitando la
fila de auditoría fantasma que generaba el request perdedor de la carrera.

**4. 🟡 ACOTADO (v970, esta ronda). Presupuesto "aceptado" sin generar pedido — riesgo real menor al que sugería el comentario original.**
`lib/asistente-tools.js:433` — el comentario del código llama a este caso
"un caso de bug a revisar manualmente". Revisado el bloque completo de
aceptación en `lib/handlers/pedidos.js`: ya existe compensación manual
(`revertirPresupuestoAEnviado`) en los 3 puntos de falla conocidos
(creación del pedido, creación de ítems, reserva de stock) — no es un bug
activo. Como no es transaccional a nivel DB (pasos secuenciales), solo un
crash/timeout de la función a mitad de camino podría dejarlo trabado en
`aceptado` sin pedido. → *Mejora futura opcional, no bloqueante:* job de
reconciliación de respaldo que detecte ese caso de borde puntual.

**5. ✅ RESUELTO (v970, esta ronda). Faltaban `robots.txt` y `sitemap.xml`.**
Confirmado que no existían en `frontend/`. Creados ambos + 2 rewrites
nuevos en `vercel.json` (mismo patrón que `/manifest.json`). robots.txt
permite indexar landing/registro/legales/catálogo público y bloquea
admin/portales privados/`api`/`frontend`; sitemap.xml lista las páginas
públicas estáticas. **Pendiente manual:** ningún dominio de producción
está hardcodeado en el repo — ambos archivos usan el placeholder
`TU-DOMINIO-DE-PRODUCCION`, hay que reemplazarlo antes de deployar.

### ⚪ Bajo

**23. ✅ RESUELTO (v962, esta ronda — Etapa 4, `rutas.js`/`remito.js`). Dos inconsistencias menores de escaping, mismo patrón que #6b/#19/#20.**
`frontend/admin/js/rutas.js`, `cambiarTipoInvitacion()` (`<select>` "invitar
chofer existente"): `c.nombre` se insertaba crudo en el `<option>`, sin
`esc()`, mientras el resto del archivo (`avatarChofer()`, tabla de
reportes) sí lo escapa para el mismo dato. Igual que #6b, el modelo de
contenido de `<select>` acota bastante lo explotable, pero corresponde
corregirlo por consistencia.
`frontend/admin/js/remito.js`, pie del remito imprimible: `empresa.cuit` se
concatenaba crudo, mientras dos usos anteriores del mismo campo en el mismo
archivo sí lo pasan por `sanitize()`. Dato cargado únicamente por
dueño/admin en la configuración de la empresa (no por un rol de menor
privilegio), riesgo bajo, pero misma inconsistencia.
→ *Fix aplicado*: ambos envueltos en `esc()`/`sanitize()`, igual que el
resto de cada archivo.

**6b. ✅ RESUELTO (v960, esta ronda). Inconsistencia de escaping en el `<select>` de clientes del modal "Nuevo pedido".**
`frontend/admin/pedidos.html`, script inline "Modal nuevo pedido admin"
(`_ensureCtx`): las opciones del selector de cliente se armaban con
`c.razon_social || c.nombre_fantasia` crudo, sin pasar por el helper
`_esc2()` que el mismo bloque usa en todos los demás puntos (nombre de
ítem del carrito). El mismo dato (`razon_social`) sí se sanitiza en
`devoluciones.js` (`s(...)`) al armar su propio `<option>`, lo que
confirma que es una omisión puntual, no un criterio intencional. No es
explotable como XSS clásico hoy — el modelo de contenido de `<select>`
descarta la mayoría de tags al parsear vía `innerHTML` (`<img
onerror=...>` no llega a crearse como elemento dentro de un `<select>`)
— pero `razon_social`/`nombre_fantasia` los carga cualquier usuario con
permiso de ABM de Clientes (dueño/admin/vendedor), no solo el dueño de
la empresa, así que vale corregirlo por el mismo criterio de
defense-in-depth que ya se aplicó en MIGRACION-001. Fix: envuelto en
`_esc2()`, igual que el resto del archivo.

**6. ✅ RESUELTO (v542, migración `20260824040000_542_stock_minimo_entero.sql`). Inconsistencia menor en `stock_minimo`.**
`frontend/admin/js/productos.js:1387-1400` y
`frontend/admin/productos.html` (`input#fp-stock_minimo`): el input tiene
`step="1"` (sugiere entero) pero el JS parseaba con `parseFloat`, y la columna
real en DB era `numeric(12,3)`. No era un bug funcional (no truncaba ni rompía
nada), pero era un cabo suelto de intención: si la idea de UX es "solo
enteros" —como se decidió explícitamente para cantidades de stock en v690—
acá había quedado afuera sin decisión documentada.
Fix: `productos.stock_minimo` pasa a `integer` (sin pérdida de datos reales,
se verificó que no había forma de cargar un valor fraccionario desde ningún
flujo actual); `fn_crear_producto`, `fn_productos_lista` y
`fn_reportes_stock_criticos_lista` actualizadas al mismo tipo en su firma/
salida; `productos.js` pasa a `parseInt`, mismo criterio que v690 aplicó al
resto de las cantidades del sistema.

---

## ✅ Ya verificado y confirmado OK (no re-auditar sin motivo nuevo)

- **Webhook de Mercado Pago**: falla CERRADO si falta `WEBHOOK_SECRET_MP`
  (fix SEC-013 vigente); firma verificada con `timingSafeEqual` (anti timing
  attack).
- **Idempotencia de cobros MP**: doble capa real — CAS a nivel de UPDATE
  (`soloSiNoCompletada`) + índice único `idx_cobros_offline_local_id` a
  nivel de RPC. Webhook y polling manual (`verificarPago`) usan el mismo
  `offline_local_id` (`mp:${payment_id}`), por lo que no se duplica el
  cobro en cta_cte aunque ambos caminos corran en paralelo para el mismo
  pago.
- **Falla de conciliación de cobros**: si falla aplicar un cobro aprobado en
  cta_cte, queda encolado en `cola_financiera` para reproceso — no se pierde
  en un log silencioso.
- **Gap conocido y aceptado (no es hallazgo nuevo)**: el cobro QR del POS no
  tiene fila propia en `pedidos`/`transacciones_pago`, depende del polling
  del frontend. Deuda técnica ya documentada en
  `CHANGELOG_v760_qr_mercadopago_pos.md`.
- **Facturación AFIP/ARCA**: `reintentarFacturaHandler` bloquea con 409 el
  estado `cae_obtenido_sin_persistir` en vez de permitir reintentar — evita
  pedir un segundo CAE cuando ARCA ya autorizó el primero (el error más caro
  posible en este dominio: "comprobante fantasma" ante ARCA).
- **Notas de crédito**: si el crédito falla al aplicarse en cta_cte después
  de obtener CAE real, NO se reintenta la emisión (evitaría NC duplicada
  contra ARCA) — queda en `notas_error` para aplicación manual.
- **Stock**: ajustes concurrentes pasan por `ajustar_stock()` con `FOR UPDATE`
  a nivel de fila. Sin race condition evidente en decremento de stock.
- **Las 7 tablas marcadas "RLS sin policy"** (`api_rate_limits`,
  `asistente_articulos`, `asistente_uso`, `chofer_invitaciones`,
  `contador_uso_apis`, `demo_snapshots`, `pos_scanner_tokens`): no es una
  vulnerabilidad activa — el acceso está cortado por `REVOKE ALL FROM anon,
  authenticated` a nivel de grant (no de policy), solo `service_role`
  (que bypassea RLS de cualquier forma) puede leerlas. Es deuda de
  documentación, no un agujero real.
- **Dispatcher único de API** (`api/index.js`): arquitectura de lazy-import
  con cache por lambda ya resuelve un problema real de cold-start/504
  (v861); manejo de errores no filtra detalles internos al cliente (solo
  correlation_id, el stack completo queda en logs/Sentry).
- **POS — registro de venta** (`lib/handlers/pos.js:registrarVentaHandler`):
  revalida server-side TODO lo que ya validó el frontend (precios vía
  `resolver_precios_cliente`, descuentos por línea y global con umbral +
  PIN de supervisor hasheado con bcrypt, suma de pagos vs. total, medios de
  pago permitidos). El cálculo de redondeo a peso entero
  (`Math.round(totalSinDescGlobal - descGlobalMonto)`) es idéntico byte a
  byte entre backend y frontend (`pos.js` línea 1316 y 2090) — verifiqué
  ambas fórmulas una al lado de la otra.
- **POS — anulación de venta**: bloquea anular una venta que ya tiene
  factura con CAE (fuerza el camino correcto de Nota de Crédito en vez de
  dejar una factura fiscal "huérfana"); la restauración de stock + cambio
  de estado pasa por una única RPC transaccional e idempotente (ya no es
  un loop de llamadas sueltas que podía cortarse a mitad de camino).
- **POS — cierre de turno y movimientos de caja** (sangría/refuerzo/retiro):
  ambos verifican ownership del turno (o permiso de override para
  administradores) y quedan con auditoría financiera durable.
- **POS — sincronización offline** (`frontend/admin/js/pos-offline.js`):
  idempotencia real vía `offline_local_id` (dedupe server-side, no
  cliente-side); un rechazo de negocio real (stock insuficiente, turno
  cerrado, límite de crédito) ya NO se enmascara como "sincronizado" —
  el propio changelog interno del archivo documenta que esto SÍ fue un bug
  real en una versión anterior (v2) y quedó corregido en v3. Cola FIFO
  única para ventas y facturaciones diferidas, con UI de conflicto real
  para que el vendedor decida en vez de perder o duplicar silenciosamente.
- **Pedidos — confirmación del portal cliente** (`confirmarPedidoHandler`):
  precios e IVA siempre resueltos server-side (`resolver_precios_cliente`,
  nunca lo que mande el cliente), stock necesario acumulado por producto
  ANTES de comparar contra disponible (cubre el caso de un mismo producto
  pedido directo + dentro de un combo en el mismo carrito), límite de
  crédito excluido correctamente cuando `forma_pago = pago_inmediato`.
- **Pedidos — alta admin y devoluciones admin** (`crearPedidoParaCliente`,
  `handleDevolucionesAdmin`): mismas validaciones que el portal cliente
  (función compartida, no una reimplementación paralela); revisión de
  devoluciones con guard contra doble-procesamiento (fix v804) y
  reposición de stock / generación de NC solo si el admin lo tilda
  explícitamente al aprobar.

---

## Detalle por etapa (evidencia completa)

### ETAPA 0 — Inventario (completa)
- 1562 archivos totales / 23MB. Código relevante (js/sql/html/css): 989
  archivos.
- Distribución: supabase 410, frontend 302, lib 130, tests 121, scripts 15,
  docs 6, api 1 (dispatcher único).
- Arquitectura backend: 1 sola Vercel Serverless Function (`api/index.js`)
  que despacha a 40 handlers en `lib/handlers/` vía `?_mod=`, con
  lazy-import y cache en memoria por lambda "warm".
- Solo hay 1 Supabase Edge Function real (`saas-email-sender`); el resto de
  la lógica server-side vive en los handlers Vercel.
- El repo ya contiene 2 auditorías propias previas que hay que usar como
  línea base: `AUDITORIA_2026/00_CIERRE_AUDITORIA.md` (integral, sesión
  2026-07-11, 12 etapas) y `AUDITORIA_PRE_LANZAMIENTO.md` (checklist vivo,
  re-verificado 2026-08-16).

### ETAPA 1 — Base de datos (primer barrido completo)
Ver hallazgos #3 y #6 arriba. Metodología: se revisó el esquema de nombres
de las 403 migraciones buscando inconsistencias de orden de aplicación, y
se comparó tipos de columna (DB) contra validación de inputs (frontend) en
el módulo de Productos.

### ETAPA 2 — Backend/API dinero-crítico: `pagos.js`, `facturas.js`, `stock.js`
Metodología: se leyó completo el flujo de webhook + polling manual de
Mercado Pago (`manejarWebhook`, `verificarPago`), el flujo de emisión/
reintento de facturas y notas de crédito contra ARCA (`reintentarFacturaHandler`,
`handleNotasCredito`), y el mecanismo de locking en `stock.js`. Se
verificó también la vigencia de la auditoría integral previa
(`AUDITORIA_2026/`) y del checklist de pre-lanzamiento
(`AUDITORIA_PRE_LANZAMIENTO.md`) contra el código y la fecha actuales, en
vez de darlos por buenos. Resultado: ver hallazgos #1, #2, #5 y la sección
"Ya verificado OK" arriba.

### ETAPA 4 — Frontend (solo Productos/modal compacto revisado hasta ahora)
Revisado en detalle: `frontend/admin/productos.html` (markup del modal),
`frontend/admin/js/productos.js` (funciones `abrirModalProducto`,
`cerrarModalProducto`, `limpiarFormularioProducto`, `guardarProducto`,
`eliminarProducto`, manejo de foto con guards de concurrencia contra
autocompletado por escaneo). No se encontraron bugs nuevos más allá del
hallazgo #6 (bajo). El manejo de condiciones de carrera en el
autocompletado de nombre/foto por código escaneado (variables
`nombreProductoAutoCompletado` / `fotoProductoAutoCompletada`) está bien
razonado y documentado inline — no es un patrón a replicar por descuido en
otros módulos, sino un ejemplo a seguir.
Pendiente: POS, Pedidos, Stock, Cta-Cte, Cobranzas, Devoluciones, Rutas,
portal cliente, portal chofer, portal proveedor.


### ETAPA 4 (cont.) — Frontend/Backend POS (`lib/handlers/pos.js`, `frontend/admin/js/pos.js`, `pos-offline.js`, `pos-terminal.js`)
Metodología: se leyeron completas las funciones de mayor riesgo de dinero
real — `registrarVentaHandler`, `anularVentaHandler`, `cerrarTurnoHandler`,
`movimientoCajaHandler` (backend, 1915 líneas) — y el módulo completo de
sincronización offline (`pos-offline.js`, 394 líneas), incluyendo su
historial de versiones documentado inline (v1→v4). Se verificó paridad
exacta de la fórmula de redondeo entre frontend (`pos.js`) y backend.
Resultado: sin hallazgos nuevos. Ver sección "Ya verificado OK" arriba.
Pendiente dentro de POS: revisión línea por línea de `pos-terminal.js`
(pantalla de cobro QR/tarjeta) y de la UI de reporte Z
(`reporteZHandler`, línea 1198) — quedan para un siguiente pase si se
quiere exhaustividad total, pero no son la prioridad frente a lo que
sigue abierto en el documento (backup sin probar, checklist de navegador).

### ETAPA 4 (cont.) — Frontend/Backend Pedidos admin (`frontend/admin/pedidos.html`, `frontend/admin/js/pedidos.js`, cruzado contra `lib/handlers/notif.js`)
Metodología: revisión línea por línea de `pedidos.js` (1564 líneas) y su
HTML (1328 líneas). Se comparó el patrón de auth de los 4 `fetch()` del
archivo entre sí (`notif/whatsapp`, `lotes/fefo`, `facturas`,
`pedidos?...accion=eliminar`) — 3 de 4 adjuntaban `Authorization: Bearer`
de la sesión y 1 no, lo que llevó a auditar el backend correspondiente
(`whatsappHandler` en `notif.js`) en vez de asumir que la asimetría era
inocente. Ver hallazgo #2 (🔴 Crítico, RESUELTO en esta ronda) arriba —
`/api/notif/whatsapp` no tenía ningún control de acceso. Se revisaron
además los `innerHTML` del archivo (18 sitios): todos los que insertan
datos de cliente/producto/notificación usan `sanitize()`, salvo el label
de motivo en `_renderDevolucionesPedido` (fallback `d.motivo` crudo si no
está en `DEVOLUCION_MOTIVO_LABEL`) — no se marca como hallazgo porque
`motivo` es una columna con `CHECK` constraint en `devoluciones`
(enum cerrado, no texto libre), así que no es explotable; queda anotado
por si esa constraint cambia en el futuro. Confirmación con
`window.confirmar()` presente antes del DELETE físico de pedido.
Se revisó también `pedidos.html` completo (script inline "Modal nuevo
pedido admin" — confirmación previa, botón deshabilitado durante el
POST, `idempotency_key`, helper de escaping `_esc2` — y `presupuestos.js`,
cargado en la misma página): encontrado y resuelto hallazgo ⚪ Bajo #6b
(ver arriba). Con Pedidos cerrado, pendiente el resto de Etapa 4
(Clientes, Stock, Facturación, Cheques — ver plan original).

### ETAPA 4 (cont.) — Frontend/Backend Clientes (`frontend/admin/clientes.html`, `frontend/admin/js/clientes.js` + `clientes-ciclos.js`, cruzado contra `lib/handlers/score.js`)
Metodología: mismo método que dio resultado en Pedidos — chequeo
automatizado (script) de qué `fetch()` de `clientes.js` (22 llamadas)
llevan `Authorization`, y comparación de todos los `innerHTML` del
archivo (56) contra el uso de `sanitize()`/`escHtml()` en vez de leerlos
todos de corrido sin criterio. Los 22 `fetch()` están bien (Authorization
en todos). El hallazgo salió al mirar qué backend hay detrás de cada
`_svc` que llama `clientes.js`: `geocodificar`/`precios`/`direcciones`/
`acceso`/`desbloquear` caen todos en `lib/handlers/clientes.js` (ya
cerrado en Etapa 2b), pero el score del cliente (`accion=cliente`) cae en
`lib/handlers/score.js` — que **sí** fue auditado en Etapa 2b pero
"parcialmente" (`ofrecerPlanDePago` y el gate de `handler()`, según el
propio doc). Ahí apareció el hallazgo 🟠 #15 (RESUELTO) — la acción
`cliente` se había quedado afuera de la corrección "etapa 12" que ya
blindó `alertas`/`resolver-alerta`/`reglas`/`ranking`/`cobranza-priorizada`
contra exactamente este mismo patrón. En el frontend, de los 56
`innerHTML`, 55 ya usaban `sanitize()`/`escHtml()` correctamente
(confirmado con `grep` dirigido a los puntos que insertan datos de
`clientes`/`productos`); el único suelto era el panel de alertas de score
→ hallazgo 🟠 #16 (RESUELTO). `clientes-ciclos.js` (201 líneas, "Piloto
Automático" en la ficha de cliente) revisado completo: auth correcta,
`sanitize()` aplicado en nombres de producto — sin hallazgos.
Confirmación + botón deshabilitado (`btnAsyncClick`) presentes en los 4
botones de guardado del archivo (cliente, precio especial, dirección,
lista de precios). Con esto, Clientes (frontend+backend) queda cerrado
para esta ronda.

### ETAPA 2b — Backend/API: `lib/handlers/pedidos.js` (en curso) + `lib/asistente-tools.js`
Metodología: se leyó completo el flujo de confirmación de pedido del
portal cliente (`confirmarPedidoHandler`), la función compartida que
también usa el alta manual del admin (`crearPedidoParaCliente` /
`crearPedidoAdminHandler`), y el flujo completo de alta de devoluciones
(`crearDevolucionCore`, usado por chofer y admin) junto con su contraparte
en el asistente de voz (`registrar_devolucion_pedido` en
`lib/asistente-tools.js`).

Resultado: hallazgo 🔴 Crítico #0 (ver arriba) — la tool de devoluciones
del asistente reimplementa el alta a mano sin los 3 controles de v805.

Para descartar que fuera un problema sistémico del patrón "tool del
asistente reimplementa lógica en vez de reusar la función compartida", se
revisaron también `crear_pedido` (reusa `crearPedidoParaCliente` completo,
con `preview: true` para el resumen y una segunda resolución completa en
`execute` — nunca reusa nada resuelto en el resumen) y `anular_venta_pos`
(llama directo a la misma RPC `anular_venta_pos` que usa el panel, con
`p_usuario_id` fijado al usuario real de la conversación, nunca a un valor
que pueda venir del texto del modelo). Ambas están bien resueltas — el
patrón correcto (reusar la función/RPC validada) es el que predomina en el
archivo; `registrar_devolucion_pedido` es, hasta ahora, el único caso
encontrado que se desvía de ese patrón.

Pendiente dentro de `pedidos.js`: `notificarEstado`/
`notificarDespachoPorEmail`, `verPedidoSugeridoHandler`/
`confirmarPedidoSugeridoHandler`, `handlePresupuestos`, `handleRemitoNro`.
`handleDevolucionesAdmin` y `handleChofer` (la app completa del chofer:
remitos, entregar, no-entregar, clientes, productos, fotos, devolución) ya
se revisaron completos.

`handleChofer` resultó, en general, bien resuelto — buena disciplina de
CHOFER-001 (ownership del pedido vía `pedidoEsDeEsteChofer`, aplicado
consistentemente antes de cualquier fast-path de idempotencia offline en
"entregar"/"no-entregar"/"devolución"), idempotencia real vía
`offline_local_id` en los 3 flujos que pueden reintentarse desde el modo
offline, y un guard bien pensado (`marcarEntregaCompletada`/
`marcarEntregaNoRealizada` acotados a la entrega activa pendiente/en_camino,
nunca un update ciego por `pedido_id`) para no pisar entregas históricas.
Único hallazgo nuevo: 🟠 Alto #7 (`GET /api/chofer/clientes` recalculando
"hoy" en UTC en vez de reusar `hoyArgentina()`, la misma clase de bug que ya
se había corregido 400 líneas antes en la ruta `remitos` del mismo archivo).

**`lib/handlers/pedidos.js` — Etapa 2b CERRADA para este archivo (3424
líneas, el handler más grande del repo).** Se completó el resto:
`notificarEstado`/`notificarDespachoPorEmail` (hallazgo 🟡 #8: la versión
WhatsApp del aviso de despacho no chequea la respuesta ni loguea en
`notif_log`, a diferencia de la versión email — que sí fue corregida — y
de `notificarPedidoConfirmado`, que tiene el patrón correcto),
`notificarPushPedidoConfirmado`/`notificarPushAdmin` (ambas bien resueltas
— chequean resultado y loguean), `verPedidoSugeridoHandler` (bien resuelto
— link público sin filtrar campos internos, gate de MP replicado del
backend real) y `confirmarPedidoSugeridoHandler` (hallazgo 🟡 #9: la RPC
`confirmar_pedido_sugerido` tiene una condición de carrera check-then-update
que el propio archivo ya sabe resolver correctamente — ver
`bloquearPresupuestoAceptado` en `handlePresupuestos`, el caso gemelo para
presupuestos), `handlePresupuestos` (muy bien resuelto — lock optimista al
aceptar, compensación completa ante cualquier fallo a mitad de camino:
libera stock ya reservado, borra ítems/pedido, revierte el presupuesto a
'enviado'; documentado como resultado de revisiones Fase 11/12 previas) y
`handleRemitoNro` (simple, numeración atómica vía RPC, sin hallazgos).

✅ **Hallazgos 🟡 #8 y #9 resueltos en v956.** Ver
`CHANGELOG_v956_fix_notif_whatsapp_despacho_y_race_confirmar_sugerido.md`
para el detalle de ambos fixes. Con esto, `lib/handlers/pedidos.js` queda
sin hallazgos abiertos.

### ETAPA 2b (cont.) — Resto de handlers: `auth.js`, `cierre.js`, `cc_proveedores.js`, `saas.js`, `conciliacion-bancaria.js`, `score.js` (parcial)
Metodología: se priorizaron los handlers restantes de mayor riesgo real
(seguridad transversal y dinero), mismo criterio que las etapas anteriores,
en vez de recorrer los ~35 restantes en orden alfabético.

- **`auth.js`** (541 líneas, login/refresh/logout/reset/change-password):
  arquitectura sólida — rate limiting dedicado, circuit breaker sobre
  Supabase Auth, consumo atómico de refresh token (SEC-09, UPDATE con
  `WHERE revocado=false` como lock optimista, mismo patrón que
  `confirmar_pedido_sugerido` desde v956), revalidación de usuario/empresa
  vigente en cada refresh (no confía en el rol viejo del JWT), sin
  enumeración de emails/teléfonos registrados en ningún flujo de reset,
  chequeo de contraseñas filtradas (`chequearPasswordONull`) antes de
  aceptar cualquier contraseña nueva. Único hallazgo: 🟠 #10 (arriba,
  resuelto en v957).
- **`cierre.js`** (349 líneas, cola financiera + facturación automática +
  bloqueo por deuda vencida): muy bien resuelto — ya trae fixes de una
  auditoría previa (Fase 2, hallazgos #2/#3) bien documentados inline:
  scoping por `empresa_id` cuando no es el cron interno, `CRON_SECRET` real
  (no el header spoofeable `x-vercel-cron`), reintento idempotente del
  cobro de MP vía `offline_local_id`, error de `insertarEnCtaCte` ya no se
  traga en silencio. Único hallazgo: 🟡 #11 (arriba, resuelto en v957).
- **`cc_proveedores.js`** (360 líneas, cta-cte con proveedores + pagos):
  sin hallazgos nuevos. Ya trae una serie completa de fixes propios (puntos
  2 a 8 de una auditoría previa) — RPCs transaccionales para alta/edición de
  factura (`alta_factura_proveedor`/`editar_factura_proveedor`, con
  `SELECT ... FOR UPDATE` + `expected_updated_at` como lock optimista),
  montos recalculados server-side desde los ítems reales (nunca los que
  mande el body), idempotencia por `offline_local_id` en el pago, y
  auditoría financiera durable (`registrarAuditoriaFinancieraDurable`, con
  fallback a `audit_log_pendientes` si el insert directo falla).
- **`saas.js`** (333 líneas, panel superadmin de suscripciones): sin
  hallazgos nuevos. Ya trae el fix crítico de v220 bien documentado
  (gate de superadmin verifica identidad real de la empresa raíz, no solo
  `rol === 'dueno'`, que antes dejaba pasar a cualquier dueño incluida la
  demo pública); todas las mutaciones (suspender/cancelar/reactivar/precio)
  pasan por RPCs dedicadas, ninguna hace update directo de tabla desde el
  handler.
- **`conciliacion-bancaria.js`** (159 líneas): sin hallazgos nuevos. Todo
  scopeado por `empresa_id` + chequeo de permiso (`puede()`) antes de
  cualquier lectura o escritura, validación de fila por fila del extracto
  importado antes de persistir.
- **`score.js`** (revisado parcialmente — `ofrecerPlanDePago` y el gate de
  `handler()`): sin hallazgos nuevos. Mismo `CRON_SECRET` real que
  `cierre.js`, cooldown correcto para no spammear la oferta de plan de
  pago, chequea `resp.ok` del WhatsApp antes de loguear éxito.

### ETAPA 2b (cont.) — `usuarios.js`, `clientes.js`, barrido dirigido de catches silenciosos

- **`usuarios.js`** (alta/edición/baja del equipo interno): variante del
  mismo hallazgo 🟠 #10 de `auth.js` — cuando un dueño/admin resetea la
  contraseña de OTRO usuario vía PATCH, tampoco se revocaban sus refresh
  tokens. ✅ *Aplicado en v958*: nuevo `revocarSesionesRefreshTokens()` en
  `lib/repos/usuarios.js` (mismo mecanismo que `revocarSesionesUsuario()` de
  `auth.js` — única tabla `refresh_tokens` del proyecto), llamado desde el
  handler tras un reset de contraseña exitoso.
- **`clientes.js`** (398 líneas, alta/edición/portal/direcciones/precios
  especiales/geocodificación): sin hallazgos — bien scopeado por
  `empresa_id` en todos los métodos, permisos correctos (solo dueño/admin
  para accesos de portal y baja).
- Barrido dirigido de `.catch(() => {})` en los handlers restantes
  (`grep` de patrones ya conocidos, sin leer línea por línea todavía):
  revisados `auditoria.js`, `banco-codigos.js`, `chofer_invitacion.js`,
  `migracion.js`, `pos-scanner.js`, `registro.js`, `rutas-live.js`,
  `score.js`, `stock-auto.js` — todos los `.catch(() => {})` encontrados son
  o bien llamadas a `notifAuto()` (que ya loguea internamente y nunca
  rechaza, ver `_auto-push.js`) o rollbacks/limpiezas best-effort que no
  tapan el error principal (ya devuelto al cliente por otra vía). Sin
  hallazgos nuevos en estos 9 archivos. Hallazgos 🟡 #12 y #13 (arriba)
  encontrados en `notif.js` y `pedidos.js` respectivamente.
- **`notif.js` (2823 líneas) revisado línea por línea, completo** — router
  de WhatsApp (templates + bidireccional + Embedded Signup), eventos de
  entrega, push (interno/dispositivos/chofer), 5 crons (cheques, deuda,
  eventos-reprocesar, whatsapp-salientes-reprocesar, audit-log-reprocesar),
  estado de cuenta y reintento manual de emails. Es, con diferencia, el
  handler mejor blindado del repo: firma HMAC del webhook de Meta en tiempo
  constante (fail-closed sin `WA_APP_SECRET`), tenant-scoping explícito por
  `phone_number_id` para no cruzar conversaciones entre empresas con el
  mismo teléfono (`FIX SYNC-02`), reintentos con backoff uniforme para
  fallas transitorias de Meta compartidos entre los 3 puntos de envío
  (`FIX SYNC-09`), corte de costos por empresa (`envios_habilitados`,
  fail-safe en `false`), límite de crédito chequeado server-side antes de
  confirmar un pedido por WhatsApp, outbox con reintento acotado
  (`MAX_INTENTOS_SALIENTE`) para lo que ni el backoff inmediato logra
  mandar, y los 3 crons con `CRON_SECRET` real fail-closed (sin el header
  spoofeable `x-vercel-cron`). Sin hallazgos nuevos más allá de los 🟡 #12
  ya corregidos arriba (que sí salieron de esta lectura completa).

### ETAPA 2b (cont.) — `automatizacion.js` + motor de reglas, `admin.js`

- **`automatizacion.js`** (handler CRUD) + **`lib/reglas-automatizacion.js`**
  (motor: evaluación de condiciones y ejecución de acciones, 275 líneas) +
  su repo: revisados completos, sin hallazgos. Condiciones fail-closed,
  whitelist de templates de WhatsApp coincidente entre motor/repo/frontend,
  tenant-scoping explícito en el envío de WhatsApp de una regla (valida que
  el cliente dispare pertenezca a la empresa del evento), validación de
  acciones al guardar la regla (no solo al ejecutarla, evita guardar una
  regla rota que recién falla en producción).
- **`admin.js`** (1055 líneas — KPIs, resumen de arranque, ventas diarias,
  `handleAlertas`, onboarding, dashboard ejecutivo, comparativa mensual,
  salud de eventos, métricas de negocio) revisado completo.
  - `handleAlertas` (9 categorías: notificaciones, pedidos demorados,
    migraciones con error, cheques vencidos, clientes en score crítico,
    facturas con diferencias, diferencia de caja, entrega con cobro
    parcial, eventos en error prolongado): las 10 funciones del repo que
    alimentan cada categoría están scopeadas por `empresa_id` en el propio
    `.eq()` de Supabase (directo o vía `!inner` sobre la tabla padre en los
    dos casos con join). Sin hallazgos.
  - 🟠 **#14 — `handleDashboardEjecutivo` crasheaba en vez de responder
    error controlado.** Al fallar `obtenerKpisDashboardV3Rpc` o
    `obtenerDashboardEjecutivoResumenRpc`, el handler llamaba
    `errorSeguro(res, error, ...)` con una variable `error` que no existe
    en ese scope (el destructuring es `[kpisRes, resumenRes, ...]`, nunca
    se declara `error` suelto) → `ReferenceError` no capturado exactamente
    en el camino que debía loguear y responder limpio, en vez de un 500
    con `correlation_id`. Además, ambas llamadas pasaban
    `{ error: kpisRes.error.message }` como `extra` de `errorSeguro`, que
    ese helper mezcla directo en el JSON de respuesta al cliente — filtraba
    el mensaje interno de la RPC/Postgres, justo lo que `errorSeguro` existe
    para evitar (ver su comentario in `lib/error-response.js`). Mismo patrón
    de fuga (sin el crash, porque ahí `error` sí estaba en scope) encontrado
    en el fallback de `handleKPIs` (línea ~167), donde además logueaba el
    error de la RPC `_v3` en vez del error real del fallback `_v1` que
    fallaba. ✅ *Aplicado en v959*: las 3 llamadas corregidas para loguear
    el error real de cada rama y no exponer `.message` al cliente. Suite
    completa (`npx vitest run`): 997/1003 OK, los 6 fallos son
    preexistentes y sin relación (`usuarios.js`, `empresas.js` repo,
    `migracion.js` repo, `eventos-dispatcher.js`, `pos-offline.js`).
  - Resto de `admin.js` (KPIs, resumen de arranque, ventas diarias,
    onboarding, comparativa mensual, salud de eventos, métricas de
    negocio): sin hallazgos adicionales.
- **`proveedores.js`** (595 líneas — CRUD de proveedores, sub-router de
  compras/OC, comparador de precios) + **`lib/repos/proveedores.js`** +
  **`lib/repos/compras.js`** (304 líneas — OC, recepciones de mercadería,
  storage de remitos): revisados completos, sin hallazgos. Todo el CRUD y
  las 10+ funciones de compras/recepciones scopean por `empresa_id` en el
  propio `.eq()`; guard anti doble-submit (8s, mismo detalle de items)
  antes de tocar stock al recepcionar; validación real de contenido de
  archivo por magic bytes (BUG-04) en upload de remito, no solo el
  `mime_type` declarado por el cliente; bucket `remitos` privado con URL
  firmada de corta vida, nunca persistida.
- **`portal_proveedor.js`** (458 líneas — superficie pública "Vidriera
  Inversa": el proveedor entra sin login vía token de URL) + su repo
  (`lib/repos/portal-proveedor.js`): revisado completo, sin hallazgos.
  Token crudo de 32 bytes (256 bits), solo el hash sha256 vive en DB;
  validación vía RPC `SECURITY DEFINER` (`validar_token_portal_proveedor`,
  migración 099) contra tabla con RLS deny-all, siempre por
  `SERVICE_ROLE_KEY`; rate limit propio de 20 req/min por IP (más estricto
  que el resto de la API, por ser candidato a fuerza bruta de tokens);
  las 3 escrituras públicas (confirmar-entrega, subir-factura,
  generar-link) re-validan `proveedor_id`+`empresa_id` server-side contra
  el resultado del token, nunca contra un id que mande el body/query;
  mismo BUG-04 (magic bytes) aplicado a la subida de factura del
  proveedor. Tests de repo ya existentes (`tests/repos/portal-proveedor.test.js`,
  20 casos) y `tests/repos/cc-proveedores.test.js` (34 casos): 54/54 OK.
- **`auto-imagenes.js`** (464 líneas — búsqueda automática de fotos de
  producto en 3 capas: barcode vía Open Food/Products Facts, foto real por
  nombre vía Serper.dev) + repo: sin hallazgos. Scopeado por `empresa_id`,
  checksum EAN/UPC validado antes de consultar barcode, filtro de dominios
  de stock + proporción de imagen para descartar falsos "reales" de
  Serper, contador de uso atómico vía RPC. Tests: 7/7 OK.
- **`gastos-generales.js`** (CRUD de gastos fijos para Ganancia Neta):
  sin hallazgos. Sin tests propios (handler ni repo).
- **`fidelizacion.js`** (catálogo de recompensas + canje desde portal
  cliente): sin hallazgos — `cliente_id` siempre derivado del token de
  sesión, nunca del body. RPC `canjear_recompensa` con `FOR UPDATE` en
  ambos locks (recompensa y saldo) y gate `service_role`. Sin tests
  propios.
- **`reglas-precio.js`** (motor de reglas de precio por volumen/zona):
  sin hallazgos — ya trae su propio fix histórico documentado (REGLAS-001,
  fuga cross-tenant vía FK sin validar). Sin tests propios.
- **`maestros.js`** (ABM de zonas/depósitos/listas de precio/categorías):
  sin hallazgos — guard correcto contra dar de baja el único registro
  activo o el marcado como principal/default sin reemplazo. Sin tests
  propios.
- **`busqueda.js`** (búsqueda global del header admin, 6 entidades en
  paralelo): sin hallazgos — escapado de caracteres reservados de
  PostgREST ya aplicado en los `.or()`, todo scopeado por `empresa_id`.
  Tests: 7/7 OK.
- **`ciclos.js`** (Pedido Habitual por WhatsApp): sin hallazgos — RPCs
  `generar_pedido_sugerido_cliente`/`registrar_notif_sugerencia` ya
  revocadas a `anon`/`authenticated`, solo `service_role`. Tests: 7/7 OK.

Pendiente: 0 handlers de Etapa 2b. Con `auto-imagenes.js`, `gastos-generales.js`,
`fidelizacion.js`, `reglas-precio.js`, `maestros.js`, `busqueda.js` y
`ciclos.js` cerrados en esta ronda, **queda cerrada toda la Etapa 2b**
(revisión backend línea por línea).



---

## Próximos pasos sugeridos (en orden)

0. ✅ **Crítico #0 resuelto (v955)** — `registrar_devolucion_pedido` ahora
   llama a `crearDevolucionCore`. Ver `CHANGELOG_v955_...md`.
1. Cerrar el 🔴 Crítico #1 (probar restauración de backup) — es infra, no
   código, pero es lo más grave pendiente en todo el proyecto.
2. Ejecutar en navegador real el checklist "🔴 BLOQUEANTE" de
   `AUDITORIA_PRE_LANZAMIENTO.md` (hallazgo #2).
3. Renombrar las 2 migraciones sin prefijo (hallazgo #3) — 5 minutos, cero
   riesgo.
4. ✅ **Etapa 2b cerrada para `lib/handlers/pedidos.js`** (hallazgos 🟠 #7,
   🟡 #8 y 🟡 #9 resueltos en v955/v956). Sin hallazgos pendientes en este
   archivo.
5. ✅ **`auth.js`, `cierre.js`, `cc_proveedores.js`, `saas.js`,
   `conciliacion-bancaria.js`, `score.js` revisados** (hallazgos 🟠 #10 y
   🟡 #11 resueltos en v957).
6. ✅ **`usuarios.js`/`clientes.js` revisados, barrido de catches en 9
   handlers más** (hallazgos 🟡 #12 y #13 resueltos en v958).
7. ✅ **`notif.js` cerrado línea por línea** (v958, sin hallazgos nuevos).
   **`automatizacion.js` + motor de reglas cerrado** (sin hallazgos).
   **`admin.js` (1055 líneas) cerrado** — hallazgo 🟠 #14 (crash +
   fuga de detalle interno en manejo de error) resuelto en v959.
   **`proveedores.js` + `compras.js` + `portal_proveedor.js` cerrados**
   (sin hallazgos, v959).
8. ✅ **Etapa 2b (resto) cerrada** — `auto-imagenes.js`, `gastos-generales.js`,
   `fidelizacion.js`, `reglas-precio.js`, `maestros.js`, `busqueda.js` y
   `ciclos.js` revisados completos, sin hallazgos (v960). Con esto la
   Etapa 2b (backend línea por línea) queda formalmente cerrada.
8. ✅ **Etapa 4 — Pedidos frontend (parcial, v960)**: revisado
   `pedidos.js` cruzado contra `notif.js` → encontrado y resuelto el
   🔴 Crítico #14 (`/api/notif/whatsapp` sin auth — nota: el pase anterior
   de `notif.js` línea por línea, ítem 7, lo había dado "sin hallazgos
   nuevos"; apareció recién al auditar el módulo *desde el lado del
   frontend*, comparando la asimetría entre los 4 `fetch()` de
   `pedidos.js` en vez de leer el handler de forma aislada — vale la pena
   tenerlo presente como método para el resto de la Etapa 4). Revisado
   también `pedidos.html` completo (script inline "Modal nuevo pedido
   admin" + `presupuestos.js`, ambos cargados en la misma página):
   encontrado y resuelto hallazgo ⚪ Bajo #6b (escaping inconsistente en
   el `<select>` de clientes). `presupuestos.js` revisado sin hallazgos
   (los 8 `fetch()` correctos). Con esto Pedidos (frontend+backend) queda
   cerrado para esta ronda. Falta el resto de módulos de Etapa 4
   (Clientes, Stock, Facturación, Cheques).
9. ✅ **Etapa 4 — Clientes frontend (v960)**: revisado `clientes.js`
   (2173 líneas) + `clientes-ciclos.js` cruzados contra `score.js` →
   encontrados y resueltos 🟠 #15 (`accion=cliente` de `score.js` sin
   gate de rol — mismo patrón "etapa 12" que el resto del archivo ya
   corrige, pero se había quedado afuera) y 🟠 #16 (XSS almacenado en el
   panel de alertas de score, único `innerHTML` suelto de 56 en el
   archivo). Con esto, Pedidos y Clientes cerrados. Falta Stock,
   Facturación, Cheques.
10. ✅ **Etapa 4 — Stock frontend, cerrado (v962)**: auditado
    `frontend/admin/js/stock.js` (2097 líneas — usa Supabase directo vía
    `sb.rpc()`/`.from()`, no pasa por `lib/handlers/stock.js` salvo
    `/api/admin/stock/bajo` y `/api/stock-auto`). Encontrados y resueltos:
    🔴 #17 (`window.sanitize`/`escHtml` en `ui-utils.js` no era segura en
    contexto de atributo HTML — afecta a los 53 archivos que la usan, no
    solo a Stock; fix centralizado en la fuente) y 🟡 #18 (`guardarAjuste()`
    traducía cualquier excepción a un mensaje fijo de "problema de
    conexión", incluso cuando la causa real no era de red). Con esto Stock
    (frontend) queda cerrado para esta ronda.
11. ✅ **Etapa 4 — Cobranzas + Cta-Cte (v962)**: `cobranzas.js` y
    `cta-cte.js` se cargan juntos en `cobranzas.html`, revisados los dos
    completos. Encontrados y resueltos 🟡 #19 (XSS en la tabla de Facturas
    pendientes — `numero_factura`, `cliente_nombre` y etiqueta de
    prioridad sin `sanitize()`) y 🟡 #20 (XSS en Saldos por cliente —
    `nombre` sin `sanitize()`, inconsistente con la línea siguiente que sí
    lo hace). Con esto Cobranzas y Cta-Cte quedan cerrados.
12. ✅ **Etapa 4 — Facturación (v962)**: revisados `facturacion.js` (781
    líneas), `notas-credito.js` (509 líneas) y `facturacion-config.html`
    completos — sin hallazgos, ya sanitizan de forma consistente. El
    script inline `type="module"` de `facturacion.html` (pestaña
    "Comprobantes históricos") sí tenía el mismo patrón de XSS —
    resuelto como 🟡 #21. Con esto Facturación queda cerrada para esta
    ronda. Queda pendiente, fuera del alcance de Facturación pero
    relacionado: el wizard de migración (`migracion.js` /
    `lib/handlers/migracion.js`), que es la única vía de carga de
    `comprobantes_historicos` — no se auditó en esta pasada. Falta
    Cheques, Rutas y portales cliente/chofer/proveedor.

    **✅ Cerrado 2026-08-24 (sesión de Etapa 6/hallazgo suelto):** revisado
    `frontend/admin/js/migracion.js` completo con foco en la ruta de
    `comprobantes_historicos` — `renderTablaFilas()` (preview de filas del
    wizard, línea ~1959) escapa genéricamente **todos** los campos
    mapeados vía `escapeHtml()`, incluyendo `numero_original` y
    `observaciones` (los mismos campos del hallazgo #21 original). El
    historial de sesiones (`nombre_archivo_original`) y el panel
    superadmin (`empresa_nombre`, `entidad`, `estado`) también escapan
    correctamente. Sin hallazgos. El hallazgo suelto #21 queda 100%
    cerrado.
13. ✅ **Etapa 4 — Cheques (v962)**: revisados `cheques.js` (716 líneas),
    `riesgo-cheques.js` (765 líneas), `cheques.html`, `riesgo-cheques.html`
    y el listener de backend `lib/eventos-listeners/cheques_por_vencer.js`
    completos — **sin hallazgos**. Es el primer módulo de la Etapa 4 que
    cierra limpio: los dos archivos JS sanitizan de forma consistente
    incluso datos que vienen de la API externa del BCRA (entidades,
    situación crediticia, causales de rechazo), algo que ningún otro
    módulo había hecho hasta ahora. Se verificó puntualmente
    `h.motivo_cambio` (historial de score, sin `sanitize()`) y no es un
    vector real: rastreado hasta `lib/repos/scores.js`/`score.js`, el
    valor siempre es un literal fijo del propio backend
    (`'recalculo_manual'`, etc.), nunca texto de request del usuario. Con
    esto Cheques queda cerrado. Falta Rutas y portales
    cliente/chofer/proveedor.
14. ✅ **Etapa 4 — Rutas (v962)**: revisados `frontend/admin/js/rutas.js`
    (1905 líneas), `rutas-resumen.js` (513), `zonas.js` (202), `remito.js`
    (514), `lib/repos/rutas.js` (262) y `lib/handlers/rutas-live.js` (573)
    completos. Encontrados y resueltos 🟠 #22 (XSS almacenado en el popup
    del mapa de seguimiento en vivo — `receptor`/`cliente`/`dir` sin
    `esc()`, con escalamiento chofer → admin; el mismo archivo ya tenía el
    fix correcto en otros tres lugares) y ⚪ #23 (dos inconsistencias
    menores de escaping en `rutas.js` y `remito.js`). El backend
    (`lib/repos/rutas.js`, `lib/handlers/rutas-live.js`) quedó sin
    hallazgos — consultas parametrizadas, scoping por `empresa_id`
    consistente en cada acción. Con esto Rutas queda cerrada. Falta
    portales cliente/chofer/proveedor.
15. ✅ **Etapa 4 — Portales cliente/chofer/proveedor (v962), Etapa 4
    CERRADA**: revisados completos los 9 archivos del portal chofer
    (`index.html`, `login.html`, `invitacion.html`, `notificaciones.html`,
    `restablecer-password.html`, `remito.html` — 757 líneas, incluye la
    carga de `receptor` que origina el hallazgo #22 —, `chofer-offline.js`,
    `gps-tracker.js`, `pwa-init.js`, `sw-chofer.js`), los 10 del portal
    cliente (`inicio.html`, `login.html`, `carrito.html`, `checkout.html`,
    `cuenta.html`, `pedidos.html`, `notificaciones.html`, `catalogo.html`
    — 834 líneas —, `cliente-offline.js`, `pwa-init.js`, `sw-cliente.js`)
    y los 5 del portal proveedor (`portal.html`, `portal.js` — 533
    líneas, pantalla pública sin login vía token —, `proveedor-offline.js`,
    `pwa-init.js`, `sw-proveedor.js`). Encontrado y resuelto 🟡 #24 (XSS en
    `checkout.html` del portal cliente). Se verificó puntualmente
    `logo_url` (usado sin `esc()` en `src` de `<img>` vía `innerHTML` en
    `frontend/admin/login.html` y `frontend/cliente/login.html`) y
    `archivo_url` de facturas de proveedor (usado sin `esc()` en `href`,
    `portal.js`): no son vectores reales — ambos se generan 100%
    server-side (`POST /api/empresa/logo` y `subir-factura` en
    `portal_proveedor.js` firman una URL de Supabase Storage, nunca texto
    libre del usuario). Con esto, la **Etapa 4 (Frontend por módulo) queda
    formalmente cerrada** — los 9 módulos + 3 portales completos.
16. Etapas 3, 5, 6, 7, 8 según el plan original.
17. ✅ **Etapa 7 (seguridad transversal) cerrada (v965)** — ver
    `CHANGELOG_v965_etapa7_seguridad_transversal.md`: vulnerabilidad
    cross-tenant en `calcular_score_cliente` (SECURITY DEFINER otorgada a
    `authenticated` sin `assert_empresa_access()`) resuelta; `search_path`
    fijado en esa función e `importar_productos_lote`; 10 tablas
    RLS-sin-policy revisadas sin riesgo real; queda pendiente (manual, fuera
    de SQL) activar `auth_leaked_password_protection` en el dashboard de
    Supabase.
18. 🟡 **Etapa 8 (cobertura de tests vs. bugs históricos) en curso (v966)**:
    se cruzaron todos los hallazgos 🔴/🟠 ya resueltos de este documento
    contra `tests/` y se encontraron dos con CERO cobertura de regresión —
    ambos justo los de mayor severidad real del documento:
    - **Hallazgo #14** (`whatsappHandler` sin auth, v960): se exportó la
      función (antes interna) y se agregó
      `tests/handlers/whatsapp-notif-permisos.test.js` (6 casos: 401 sin
      token, 403 rol insuficiente, 200 rol autorizado, **regresión de
      suplantación de tenant** — confirma que `empresa_id` sale siempre de
      la sesión y nunca del body aunque se mande uno ajeno, fail-safe sin
      credenciales propias conectadas, 400 por validación de campos).
    - **Hallazgo #0** (`crearDevolucionCore`, incidente real v805 de
      ~$9,86M): se agregó `tests/repos/crear-devolucion-core.test.js` (8
      casos) fijando los 3 controles como contrato: tope contra lo comprado
      histórico (reproduce el caso real: 42 comprados, intento de devolver
      4.555), descuento de lo ya reservado en otras devoluciones
      pendientes, rechazo si el cliente nunca compró el producto, rechazo
      si el producto no pertenece al pedido vinculado, recálculo
      server-side del precio (con y sin pedido vinculado) ignorando lo que
      venga en el body, camino feliz, y nota de débito a proveedor con el
      monto recalculado (no el manipulable del body).
    - Los 14 tests nuevos pasan (`npx vitest run`). Se corrió además la
      suite completa (1031 tests): **5 fallos preexistentes, sin relación
      con este trabajo**, en `tests/handlers/usuarios.test.js`,
      `tests/repos/empresas.test.js` y `tests/repos/migracion.test.js` —
      tests desincronizados de la implementación actual (un export
      `revocarSesionesRefreshTokens` que el mock no expone, una columna
      `slug` nueva no reflejada en el `select()` esperado, un `.limit(20)`
      que el mock no registra). Quedan para una ronda aparte de Etapa 8,
      no se tocaron en esta pasada.
    - Falta: barrer el resto de hallazgos 🟠/🟡 del documento contra
      `tests/` (esta ronda se priorizó por severidad real, no se hizo el
      barrido completo todavía) y decidir si los 5 tests preexistentes
      rotos se arreglan actualizando el mock o reflejan un bug real en el
      código.
19. ✅ **RESUELTO (v967, esta ronda). Los 5 tests preexistentes rotos de
    v966 investigados y corregidos — confirmado bug de test (mock
    desactualizado), no bug de código real:**
    - `tests/handlers/usuarios.test.js` (2 fallos): `repoMock` no exponía
      `revocarSesionesRefreshTokens`, que sí existe y está correctamente
      implementada en `lib/repos/usuarios.js:151` (parte del fix real del
      hallazgo #10). Agregado el stub al mock.
    - `tests/repos/empresas.test.js` (1 fallo): el test esperaba el
      `select()` viejo sin `slug`. El código real agrega `slug` a
      propósito (feature vigente del link de catálogo público,
      `actualizarSlug()`). Actualizada la assertion.
    - `tests/repos/migracion.test.js` (1 fallo): `listarSesionesPorEmpresa`
      fue refactorizada de `.limit(20)` a paginación real por
      `.range(offset, offset+limit-1)` (cap de 50). Reescrita la
      assertion contra `.range()` y agregado un caso nuevo que verifica
      el cap de 50.
    - **Hallazgo adicional durante la verificación** (no estaba contado
      en los "5 preexistentes" de v966): `tests/handlers/eventos-dispatcher.test.js`
      también fallaba — su mock de `supabase-lazy.js` reflejaba una forma
      vieja de `reclamarEventos()` (`.select().in().order().limit()`,
      `.update().eq()` simple). El código real (SYNC-06) usa
      `.select('*').order().limit()[.eq('empresa_id',x)].or(filtroOr)`
      para combinar candidatos `pendiente`/`error` con la rama de lease
      vencido de `procesando`, y un claim atómico
      `.update().eq('id').eq('estado').select('*').maybeSingle()`. Mock
      reescrito para reflejar ambas formas reales (incluida la condición
      de carrera del claim: solo "gana" si el estado sigue siendo el que
      se leyó).
    - **Suite completa verificada 3 veces seguidas: 1032/1032 tests
      pasando, 52/52 archivos, cero fallos.** (`npx vitest run`,
      instalado `npm install` primero — v966 solo había hecho análisis
      estático del código de los mocks, no había corrido la suite real
      contra los 5 fallos que documentó).
    - Con esto, Etapa 8 tiene los 2 hallazgos 🔴 Crítico cubiertos con
      test de regresión y la suite en verde. Sigue faltando el barrido
      del resto de hallazgos 🟠/🟡 (ver punto anterior) — eso no se hizo
      en esta ronda.
20. ✅ **RESUELTO (v968, esta ronda). Barrido de hallazgos 🟠/🟡 backend
    contra `tests/` — 5 tests de regresión nuevos, integrados al zip real
    (v967) y suite completa reverificada en verde.**
    - **#7** (`GET /api/chofer/clientes`, fecha UTC vs ART):
      `tests/handlers/chofer-clientes-huso-horario.test.js` (2 casos —
      21:00-23:59 ART con fecha UTC ya en D+1, y caso de control mismo día
      en ambos husos).
    - **#10** (cambio de contraseña no revocaba refresh_tokens):
      `tests/handlers/auth-revocar-sesiones.test.js` (4 casos — revocación
      tras `handleChangePassword` y tras
      `handleConfirmarCodigoWhatsapp`, y el caso negativo de cada uno:
      contraseña actual incorrecta / código inválido no revocan nada).
    - **#11** (`procesarNotifVencimiento` tragaba errores de WhatsApp en
      silencio total): `tests/handlers/cierre-notif-vencimiento.test.js`
      (3 casos — éxito, falla HTTP, excepción en el fetch; las 3 ramas
      logueando en `notif_log` y con `console.error` salvo el camino
      feliz).
    - **#12** (`alertarTokenWhatsAppVencido`/`marcarEstadoTokenWhatsapp`
      sin blindaje interno, a diferencia de `notifAuto`):
      `tests/handlers/notif-token-whatsapp-vencido.test.js` (3 casos sobre
      el call-site del endpoint de templates — fallo en `listarAdminsDueno`,
      fallo en `registrarLog`, camino feliz sin console.error espurio).
    - **#13** (recálculo de score tras devolución sin loguear fallos):
      `tests/repos/crear-devolucion-score-recalculo.test.js` (2 casos —
      `calcularScoreClienteRpc` rechaza y queda logueado sin afectar la
      devolución ya creada, y camino feliz).
    - Suite completa (`npx vitest run` sobre v967 + estos 5 archivos):
      **59 archivos / 1058 tests, todo verde.** Ningún test preexistente
      se rompió al integrar.
    - **Pendiente de Etapa 8** (no cubierto en esta ronda, queda para la
      próxima): hallazgos 🟡 #8 (`notificarEstado`) y #9
      (`confirmar_pedido_sugerido`, condición de carrera) sin test de
      regresión confirmado; y el bloque de XSS almacenado (#16 clientes,
      #19 cobranzas, #20 cta-cte, #21 facturación, #22 rutas/mapa, #23
      remito, #24 checkout) — todos fixes puntuales de "insertar sin
      escapar" en `innerHTML`/`.bindPopup()`, cubiertos indirectamente por
      `tests/frontend/ui-utils-sanitize.test.js` (fija el contrato de
      `sanitize()` en sí, hallazgo #17) pero sin un test por cada punto de
      inserción que confirme que ese call-site específico sigue llamando a
      `sanitize()`. Dado que son fixes de una sola línea cada uno en HTML
      con manipulación directa del DOM, requieren tests con DOM real (jsdom)
      por archivo — mayor costo/beneficio que los de backend recién
      cerrados.
