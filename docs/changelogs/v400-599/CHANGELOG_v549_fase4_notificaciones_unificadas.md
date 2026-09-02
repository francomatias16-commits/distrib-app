# v549 — Fase 4 del plan de sincronización ERP: notificaciones unificadas

Continúa `PLAN_ERP_SINCRONIZACION_2026.md`. Esta entrega cubre la Fase 4
(notificaciones unificadas) — depende de la Fase 3 (despachador de
eventos, v548).

## Hallazgo previo a tocar código: el bug de push no era (solo) VAPID

El plan describe el objetivo de la Fase 4 citando el hallazgo de
AUDITORIA_2026: *"las push notifications nunca llegaron a ningún
dispositivo (faltaban las VAPID keys en Vercel)"*. Antes de tocar nada se
verificó ese punto contra el código real y contra la base real
(`jgiquzjwoedmzwqgzubr`):

- `dispositivos_push` tenía **0 filas** (ni tokens FCM ni suscripciones
  VAPID) antes de esta entrega — confirmado por SQL directo. `notif_log`
  confirma que todo intento de push venía fallando con
  `sin_dispositivos`/`sin_tokens_push`.
- El sistema en realidad tiene **dos mecanismos de push distintos y
  ambos legítimos** (no es un bug, está documentado en la migración 053):
  Firebase Cloud Messaging (`enviarPush`, `_push.js`, columna
  `token_push`) para las notificaciones normales del producto, y Web
  Push nativo con VAPID (`notifAuto`, `_auto-push.js`, columnas
  `endpoint`/`p256dh`/`auth`) específico del panel de automatización.
- **La causa real de "0 dispositivos" no es (solo) la config de VAPID**:
  es que **el portal admin nunca tuvo ningún botón que pidiera el
  permiso de notificaciones**. `push-init.js` se carga como `<script
  type="module">` en `dashboard.html`, pero el módulo solo expone
  `initPushNotifications`/`solicitarPermisoNotificaciones` en `window`
  — nada las llama. Cliente (`cuenta.html`) y chofer (`index.html`) sí
  tienen un botón "Activar notificaciones" (arreglado en auditorías
  anteriores, ver comentarios "Hallazgo 1" en esos archivos); admin,
  hasta esta entrega, no. Como la mayoría de las alertas de negocio
  (stock crítico, cliente en mora, cheques por vencer, WhatsApp
  derivado, token vencido) apuntan a `dueno`/`admin`, este agujero solo
  alcanza para explicar por sí solo el 0% de entrega reportado en el
  plan — sin este fix, cablear más eventos al despachador no habría
  cambiado nada del lado del admin.
- Aparte, se encontró que `lib/eventos-dispatcher.js` (Fase 1/3) ya
  declaraba `pedido_facturado` y `factura_anulada` en el registro de
  listeners, pero **ningún lugar del repo emite esos eventos todavía**
  (`lib/facturas.js` no llama a `emitirEvento` en ningún punto, pese a
  que el changelog de la Fase 1 decía que sí se habían instrumentado).
  Se documenta acá y se deja fuera de esta entrega — inventar la emisión
  ahora, sin haber definido con nadie el listener que la consume,
  hubiera sido alcance no pedido.

## Qué cambia

### 1. Fix: admin puede activar notificaciones push (bug bloqueante)

- **`frontend/admin/notif-log.html`** (el centro de notificaciones del
  admin, ya existía): se agrega una tarjeta "Activá las notificaciones
  push" al tope de la página, oculta salvo que
  `Notification.permission === 'default'` — mismo criterio que
  `cliente/cuenta.html`. Carga `push-init.js` (no estaba cargado acá) y
  el botón llama a `window.solicitarPermisoNotificaciones()`, el mismo
  flujo FCM que ya usan cliente y chofer. No se tocó `_push.js` ni el
  registro de dispositivos — la infraestructura de backend ya
  funcionaba, solo faltaba quién la disparara.
- Se eligió `notif-log.html` (no `dashboard.html`, que también carga el
  script) porque es el lugar que el propio plan nombra como "centro de
  notificaciones" y porque un admin que visita esa página ya está
  pensando en notificaciones — mejor contexto que un botón perdido en
  el dashboard general.

### 2. Nuevo evento de negocio: `cliente_en_mora`

- **`lib/handlers/notif.js`**: se extrae `enviarAvisoDeudaVencida({
  clienteId, empresaId, telefono, razonSocial, saldoVencido })` del
  bloque que antes vivía inline en el loop de `handleDeudaCron` (envío
  de WhatsApp + `notif_log` + push vía `notificarDeudaVencida`) — mismo
  comportamiento, ahora reusable. `export`, igual criterio que
  `emitirFactura`/`notificarPedidoConfirmado` en la Fase 3.
- `handleDeudaCron` ahora, por cada cliente con deuda vencida real (ya
  pasado el chequeo de cooldown): emite `cliente_en_mora` con payload
  `{ cliente_id, saldo_vencido }` (siempre, para trazabilidad — mismo
  criterio que `pedido_creado` en la Fase 1/3) y bifurca por el flag
  `fase3_despachador_eventos` de la empresa: si está activo, despacha
  vía el bus de eventos (`despacharPendientes({ empresaId })`); si no,
  camino directo de siempre vía `enviarAvisoDeudaVencida`.
  Expand-contract, nunca las dos rutas activas para la misma empresa —
  mismo patrón que `crearPedidoParaCliente` en la Fase 3.
  - Diferencia con el patrón de pedidos.js: como acá no hay un HTTP
    request esperando respuesta rápida (es un cron batch), se puede
    `await` el resultado del despacho en vez de dispararlo
    fire-and-forget, y usarlo para las estadísticas reales del cron
    (`enviados`/`errores`/`detalle`) en vez de asumir éxito.
- **`lib/eventos-listeners/cliente_en_mora.js`** (nuevo): resuelve el
  cliente completo a partir del `cliente_id` del payload (liviano a
  propósito, mismo criterio que Fase 1) y llama a
  `enviarAvisoDeudaVencida`. Si el cliente no tiene teléfono o el envío
  falla, el listener tira — el despachador lo captura y deja el evento
  en `error` en vez de fallar en silencio (antes, sin este evento, un
  fallo de WhatsApp en el cron solo se veía en `resultados.detalle` de
  esa corrida puntual; ahora además queda una fila consultable en
  `eventos_negocio` que el barrido de abajo puede reintentar).
- **`lib/eventos-dispatcher.js`**: se registra
  `cliente_en_mora: listenersClienteEnMora` en `REGISTRO_LISTENERS`.
  `pedido_facturado`/`factura_anulada` siguen en `[]` (ver hallazgo
  arriba).

### 3. Cron de barrido/reprocesamiento de `eventos_negocio`

- La Fase 3 documentó explícitamente que no hacía falta un cron todavía
  ("con un solo tipo de evento y despacho inmediato, un cron no aporta
  — sumar uno sin necesidad es la clase de cosa que el plan pide
  evitar"). Con `cliente_en_mora` sumado acá ya hay motivo real:
  reprocesar eventos que quedaron `pendiente` (ej. el flag de una
  empresa se activó después de que el evento ya se había emitido) o en
  `error` (ej. un corte de red puntual en el envío de WhatsApp).
- **`GET/POST /api/notif/eventos-reprocesar`** (nuevo, en
  `lib/handlers/notif.js`): mismo esquema de auth que
  `deuda-vencida`/`cheques-por-vencer` (`CRON_SECRET`, fail-closed).
  Llama a `despacharPendientes({ limite: 200, incluirErrores: true })`
  sin filtrar por empresa (ya reprocesa todas).
- `vercel.json`: rewrite `/api/notif/eventos-reprocesar` →
  `_mod=notif&_svc=eventos-reprocesar-cron`, y cron nuevo cada hora
  (`0 * * * *`).

### 4. `lib/handlers/notif.js` como punto único de salida

No hizo falta ningún cambio estructural acá — el propio archivo ya
documenta en su cabecera que consolidó 8 endpoints viejos en un solo
router (`api/notif/index.js`), y con esta entrega el aviso de deuda
vencida también pasa a poder salir por el despachador de eventos en vez
de por una llamada directa. Se deja constancia en este changelog porque
es uno de los tres entregables que pedía el plan para esta fase, y ya
estaba resuelto de antes.

## Qué NO cambia (a propósito)

- No se tocó `_push.js` ni `_auto-push.js` — la infraestructura de envío
  ya funcionaba (confirmado: el único problema real de FCM era que nadie
  llamaba a la función de registro en el admin; VAPID/`notifAuto` es un
  circuito aparte, específico del panel de automatización, que ya tiene
  su propio botón "Activar alertas" en `automatizacion.html`).
- No se emitieron `pedido_facturado` ni `factura_anulada` — ver hallazgo.
  Es una decisión de producto (qué debería pasar cuando se factura o se
  anula algo) que no corresponde inventar en esta entrega.
- No se generalizó el centro de notificaciones a cliente/chofer/proveedor
  (el plan lo menciona como parte de la Fase 4). Cliente y chofer ya
  tienen su propio botón de activar push en sus páginas de cuenta —
  scope real que falta es un historial tipo `notif-log.html` para esos
  portales, que es una pieza de UI nueva considerable. Queda para la
  próxima entrega (ver "Próximo paso").
- No se tocó `handleChequesCron` (alertas de cheques por vencer) — sigue
  con la llamada directa de siempre. Es una candidata natural para el
  mismo tratamiento que `cliente_en_mora`, pero una fase a la vez.

## Verificación

- Contra la base real (`jgiquzjwoedmzwqgzubr`):
  - `dispositivos_push`: 0 filas antes de esta entrega (FCM y VAPID),
    confirmando el hallazgo de arriba con datos reales, no solo lectura
    de código.
  - `notif_log` (canal `push`): todos los intentos históricos con
    `motivo` en `sin_dispositivos`/`sin_tokens_push` — consistente.
  - `eventos_negocio.tipo_evento` no tiene CHECK constraint (es texto
    libre) — `cliente_en_mora` no necesita migración para poder
    emitirse.
  - Columnas usadas por el listener nuevo (`clientes.telefono`,
    `razon_social`, `empresa_id`) confirmadas contra
    `information_schema.columns`.
- `node --check` sobre todos los `.js` nuevos/tocados.
- **Suite completa: 53/53 OK (7 archivos)** — los 47 de la Fase 3 más:
  `cliente-en-mora-listener.test.js` (5, nuevo — resuelve cliente
  correcto, usa `evento.empresa_id` como fuente de verdad, tira si no
  hay teléfono, tira si `enviarAvisoDeudaVencida` falla, tira si el
  cliente no existe) y una prueba nueva agregada a
  `eventos-dispatcher.test.js` (que `cliente_en_mora` está registrado y
  se despacha, a diferencia de `pedido_facturado`/`factura_anulada`).
- No se probó `handleDeudaCron` de punta a punta con mocks de red (WA
  endpoint real) — mismo criterio que la Fase 3 con
  `crearPedidoParaCliente`: el listener nuevo se prueba aislado
  (mockeando `notif.js`), y el camino directo reutiliza código ya
  probado indirectamente por el uso en producción de antes.

## Cómo activar el piloto para una empresa

Mismo mecanismo que la Fase 3 (es el mismo flag, ya que ambos flujos
pasan por el mismo despachador):

```sql
update empresas set config = coalesce(config, '{}'::jsonb)
  || '{"fase3_despachador_eventos": true}'::jsonb
where id = '<empresa_id_piloto>';
```

## Addendum — al retomar esta entrega

Al continuar este trabajo se encontraron dos archivos que el changelog
describía pero que no habían quedado guardados en el paquete: se
recrearon siguiendo exactamente el patrón ya establecido (mismo criterio
que `pedido_creado.js`/su test en la Fase 3), y la suite completa
(53/53) pasa igual que antes:

- **`lib/eventos-listeners/cliente_en_mora.js`** — el módulo que
  `lib/eventos-dispatcher.js` ya importaba (`REGISTRO_LISTENERS.cliente_en_mora`)
  pero que no existía en el paquete subido.
- **`tests/handlers/cliente-en-mora-listener.test.js`** — los 5 tests que
  este mismo changelog decía que existían (resuelve cliente correcto
  usando `evento.empresa_id` como fuente de verdad, tira sin teléfono,
  tira si falla el envío, tira si el cliente no existe, expone
  `listenerNombre`).

Además, se corrigió una carrera real en `handleDeudaCron` (
`lib/handlers/notif.js`): el `emitirEvento(...)` de `cliente_en_mora`
había quedado fire-and-forget (`.catch()` sin `await`), pero la línea
siguiente ya awaitea `usaDespachadorEventos` y, si el flag está activo,
awaitea también `despacharPendientes({ empresaId })` de inmediato. Sin
esperar el INSERT del evento, el despacho podía correr antes de que el
evento recién emitido llegara a estar en `pendiente` — el aviso de esa
vuelta del loop quedaba pendiente hasta la corrida siguiente del cron,
mientras `resultados.enviados` lo contaba como si ya hubiera salido.
Se corrigió awaiteando `emitirEvento` (mismo criterio que el resto del
bloque: es un cron batch, awaitear no tiene costo real). No cambia
comportamiento para empresas sin el flag de Fase 3 activo (siguen por
el camino directo, no tocado).

Se verificó de nuevo, en esta sesión y de forma independiente (sin
asumir lo ya reportado antes), contra `jgiquzjwoedmzwqgzubr`:
`eventos_negocio` sigue sin CHECK en `tipo_evento`, las columnas de
`clientes` usadas por el listener existen con los tipos esperados, y
`dispositivos_push` sigue en 0 filas (esperable — el fix del botón en
admin es de esta entrega, todavía no desplegada).

## Próximo paso (resto de la Fase 4 / Fase 5 del plan)

- Generalizar un centro de notificaciones (historial tipo
  `notif-log.html`) a los portales cliente, chofer y proveedor.
- Decidir y emitir `pedido_facturado`/`factura_anulada` desde
  `lib/facturas.js`, con su listener correspondiente.
- Evaluar migrar `handleChequesCron` al mismo patrón de evento +
  listener que `cliente_en_mora`.
- Fase 5 del plan (auditoría de negocio centralizada): con
  `cliente_en_mora` sumado, ya hay más de un tipo de evento útil para
  extender la vista de auditoría existente.
