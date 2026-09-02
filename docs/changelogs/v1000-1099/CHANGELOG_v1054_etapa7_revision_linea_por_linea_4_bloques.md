# v1054 — Etapa 7: revisión línea por línea de los 4 bloques

## Alcance de esta pasada

Lectura de código completa (más allá de la reconciliación de migraciones
ya cerrada en v1050-v1053) de los archivos centrales de cada bloque:

- **Bloque 1**: `lib/handlers/pedidos/devoluciones.js` completo
  (`crearDevolucionCore` ya se había revisado a fondo en v1047-v1049;
  esta pasada cubrió `handleDevolucionesAdmin` — alta manual, revisar/
  aprobar/rechazar, reposición de stock, generación de NC).
- **Bloque 2**: `lib/handlers/pagos.js`, los 9 handlers de dinero real
  (`mpOauthIniciarHandler`, `mpOauthCallbackHandler`,
  `obtenerAccessTokenMPValido`/`refrescarTokenOAuthMP`,
  `posQrSetupHandler`, `posQrCobrarHandler`, `posQrVerificarHandler`,
  `verificarPago`, `verificarFirmaMP`, `manejarWebhook`).
- **Bloque 3**: `frontend/admin/js/rutas.js` completo (1909 líneas):
  `cargarPedidosDespachables`, `confirmarRuta`, `cancelarRuta`,
  seguimiento y mapa.
- **Bloque 4**: `lib/whatsapp-pedido-tools.js` completo +
  `lib/handlers/notif.js` (`procesarMensajeTexto`, `procesarConAsistente`,
  `confirmarPedidoWhatsapp`) — el flujo de function calling del asistente
  de pedidos.

## Bloque 1 — sin hallazgos nuevos

`handleDevolucionesAdmin` está sólido: el UPDATE de `revisar`
(`actualizarEstadoDevolucion`) ya hace CAS contra `estado='pendiente'`
(fix v804, devuelve `null` y 409 si ya fue revisada — no hay doble
procesamiento), la reposición de stock y la generación de NC son
best-effort independientes con sus propios `stock_errores` sin abortar
el resto, y `calcularScoreClienteRpc` ya usa `await` + `try/catch` normal
(no el bug de v803 sobre el thenable). No encontré nada nuevo.

## Bloque 2 — sin hallazgos nuevos

El código de MP está fuertemente endurecido por ciclos previos: CAS
(`soloSiNoCompletada`) en `verificarPago` y `manejarWebhook` para que
webhook + polling concurrentes no se pisen ni dupliquen el cobro,
idempotencia adicional a nivel DB vía `offline_local_id` único, HMAC
fail-closed en `verificarFirmaMP` (SEC-013), circuit breaker alrededor de
las llamadas a MP, y refresco de token OAuth con margen de 5 min antes de
vencer. Reconciliación de identidad de empresa por `mp_user_id` (no por
`referencia_externa`, el bug de v772) está aplicada consistentemente en
los tres entry points (`posQrSetupHandler`, `manejarWebhook` payment,
`manejarWebhook` order). No encontré nada nuevo.

## Bloque 3 — 1 hallazgo real

**`confirmarRuta()` no es atómico y no maneja fallo parcial** — a
diferencia de `cancelarRuta()` (que sí revisa el `error` de cada paso y
reporta el estado parcial real, fix BUG-07 documentado en el propio
archivo), `confirmarRuta()` hace 3 escrituras secuenciales desde el
browser sin ninguna reversión ni reporte de estado parcial:

1. `INSERT` en `rutas`
2. `INSERT` en `entregas` (una fila por pedido)
3. `UPDATE pedidos SET estado='preparando'`

Si el paso 2 o 3 falla (red, timeout de `conTimeoutRed`, error de
Supabase), el `catch` solo muestra "Error al crear la ruta" y no revierte
lo ya escrito. Casos concretos:
- Falla el paso 2 → queda una fila en `rutas` sin ninguna entrega
  (ruta fantasma en el listado, `armar ruta` la muestra vacía).
- Falla el paso 3 → quedan `ruta` + `entregas` creadas pero los pedidos
  siguen en `confirmado` (no `preparando`) — el chofer ve una ruta con
  pedidos, pero esos pedidos siguen apareciendo en "Pedidos para
  despachar" como si no estuvieran en ninguna ruta todavía, invitando a
  asignarlos dos veces (mismo eje de riesgo que el Hallazgo 2 de la
  auditoría etapa 6 que este mismo archivo ya arregló para el caso
  inverso).

No encontré evidencia de que esto haya ocurrido en producción — es un
hallazgo de código, no un reporte de bug real como v894 — pero es el
mismo patrón de "múltiples escrituras sin transacción" que ya causó
condiciones de carrera reales en Bloque 1 (v1047).

## Bloque 4 — 1 hallazgo real, coincide con el caso borde que pedía el plan

El propio plan de la etapa pedía probar explícitamente "doble mensaje del
mismo cliente en paralelo (race condition con el batch de v1010)". Lo
encontré:

`obtenerBorrador`/`guardarBorrador` (`lib/whatsapp-pedido-tools.js`) hacen
un read-modify-write plano sobre `whatsapp_conversaciones.pedido_borrador`
— sin `SELECT ... FOR UPDATE` ni CAS. Dentro de un mismo turno del
asistente, las tools de escritura ya se ejecutan en orden (no
`Promise.all`, según el propio comentario en `asistente-providers.js`),
así que un batch de ítems en un solo mensaje está a salvo. Pero **dos
mensajes de WhatsApp separados del mismo cliente, lo bastante seguidos
como para que Meta los entregue en dos invocaciones del webhook
solapadas**, corren dos ejecuciones independientes de
`procesarMensajeTexto` en paralelo — cada una lee el borrador, lo arma
con el modelo, y lo guarda, sin ninguna sincronización entre sí. El
`registrarMensaje`/`duplicado` que ya existe solo deduplica el *mismo*
`waMessageId` reintentado por Meta, no dos mensajes distintos procesados
en simultáneo. Resultado posible: el segundo mensaje en terminar pisa el
borrador del primero (ítem agregado por el mensaje A desaparece si el
mensaje B guardó su versión del borrador después, basada en el estado
anterior a que A escribiera).

No pude confirmar esto contra un caso real en producción (haría
falta reproducirlo con dos mensajes casi simultáneos), pero el código no
tiene ninguna defensa contra el escenario, y es exactamente el caso borde
que el plan pedía verificar.

## Pendiente — decisión de fix

Los dos hallazgos son reales pero de baja probabilidad de ocurrencia
(ambos requieren timing específico: falla de red a mitad de una
escritura múltiple, o dos mensajes de WhatsApp casi simultáneos). No
apliqué ningún fix todavía — quedan documentados para decidir:

1. **Bloque 3**: mover `confirmarRuta()` a una RPC transaccional (mismo
   patrón que `rpc_crear_devolucion_validada`, migración 570) que haga
   los 3 pasos en una sola transacción de Postgres, o al menos agregar
   manejo de fallo parcial como ya tiene `cancelarRuta()`.
2. **Bloque 4**: agregar `pg_advisory_xact_lock` por `conversacionId` (u
   otra forma de serializar) alrededor del ciclo lectura-modelo-escritura
   del borrador, mismo patrón que v1047 usó para devoluciones.

Falta el pase manual en navegador de los 4 bloques (transversal, ya
documentado como pendiente en v1050-v1053).
