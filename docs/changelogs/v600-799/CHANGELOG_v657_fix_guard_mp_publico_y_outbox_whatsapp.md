# v657 — Fix del guard de MP público (Etapa 5) + outbox de salientes de WhatsApp (Etapa 5, punto 3, cierre)

Continuación directa de v655/v656. Esta sesión trabajó sobre el zip completo
del proyecto (v653 + el subset ya corregido de v656 aplicado encima).

## 1. Fix real: el guard de `crearPreferenciaPublicaHandler` no compilaba contra la DB

El zip de v655 introdujo `pedido.origen === 'piloto_automatico'` como guard
del link de pago público — verificado contra Supabase real
(`jgiquzjwoedmzwqgzubr`), esa columna **no existe**. La señal real, también
verificada contra la DB:

- `generar_pedido_sugerido_cliente()` (RPC) inserta pedidos con
  `estado='sugerido', generado_automatico=true` y **no** setea `canal`
  explícitamente.
- `canal` tiene `DEFAULT 'web'` en la tabla — nunca `NULL`. Un pedido recién
  generado por el bot sale con `canal='web'`, igual que uno cargado a mano;
  `canal` no discrimina nada antes de la confirmación.
- `confirmar_pedido_sugerido()` recién ahí pasa `canal` a `'whatsapp'`.

Conclusión (probada con inserts/deletes de prueba contra el tenant demo,
sin tocar datos reales): la única señal suficiente y correcta es
`generado_automatico = true`. Se agregó `PagosRepo.esPedidoPilotoWhatsApp()`
(`lib/repos/pagos.js`) como guard único, reusado por:
- `crearPreferenciaPublicaHandler` (`lib/handlers/pagos.js`) — autoriza el pago.
- `verPedidoSugeridoHandler` (`lib/handlers/pedidos.js`) — decide si mostrar
  el botón (`mp_disponible`).

`obtenerPedidoSugeridoDetalle`/`obtenerPedidoParaPagoPublico`
(`lib/repos/pedidos.js`) ahora traen `generado_automatico` en vez de
`origen`.

## 2. WhatsApp — outbox de mensajes salientes del bot (cierra Etapa 5)

Tercer punto pendiente de `PLAN_OFFLINE_COMPLETO.md`. Sin tabla ni columna
nueva: se reusa `whatsapp_mensajes.metadata` (jsonb, ya existía desde la
246).

- **Migración 447** (`whatsapp_outbox_salientes.sql`, ya aplicada contra
  Supabase real): índice parcial sobre `metadata->>'estado_envio'` para el
  barrido del cron.
- **`lib/repos/whatsapp-bot.js`**: `registrarMensajeWhatsapp` acepta
  `metadata`; nuevas `obtenerSalientesPendientes`, `marcarSalienteEnviado`,
  `marcarSalienteFallido` (tope `MAX_INTENTOS_SALIENTE=10`, después pasa a
  `'agotado'` en vez de reintentar para siempre).
- **`lib/handlers/notif.js`**:
  - `enviarTextoWhatsApp` suma reintento genérico (2 intentos, backoff
    corto) para 429/5xx transitorios de Meta, además del ya existente para
    el bug del "9" argentino (131030).
  - `responderYRegistrar` (único choke point de salientes del bot) ya no
    pierde el mensaje si el envío falla: lo graba con
    `metadata.estado_envio='pendiente'` en vez de asumir éxito.
  - `procesarMensajeNoSoportado` — FIX de un hallazgo propio: llamaba a
    `enviarTextoWhatsApp` directo, sin pasar por `responderYRegistrar`; ni
    quedaba en el historial ni entraba al outbox si fallaba. Ahora usa
    `responderYRegistrar` como el resto.
  - Nuevo `_svc=whatsapp-salientes-reprocesar-cron`
    (`handleWhatsappSalientesReprocesarCron`): mismo esquema de auth
    (`CRON_SECRET`) que `eventos-reprocesar-cron`.
- **`vercel.json`**: rewrite `/api/notif/whatsapp-salientes-reprocesar` →
  `_svc=whatsapp-salientes-reprocesar-cron`, cron diario a las 03:20 (mismo
  motivo que el resto de los crons diarios: plan Hobby de Vercel no permite
  más frecuencia).

## Verificación

`node --check` sobre los 8 archivos `.js` tocados — sin errores. `vercel.json`
válido como JSON. Migración 447 aplicada contra Supabase real. Simulado
contra la DB real (insert/update/delete de prueba, sin tocar datos reales):
el filtro de `obtenerSalientesPendientes` levanta correctamente un
pendiente, `marcarSalienteFallido` mantiene `pendiente` por debajo del tope,
`marcarSalienteEnviado` lo saca del filtro. No se pudo probar el POST real a
la API de Meta (sin acceso de red a `graph.facebook.com` en este entorno) —
falta un smoke test real end-to-end contra el número de prueba antes de
confiar en el reintento transitorio en producción.

## Pendiente real

- Punto 2 original de Etapa 5 (Mercado Pago) queda "resuelto" en el sentido
  de que la UI avisa de entrada en vez de fallar — sigue sin poder
  encolarse un cobro con MP sin red, por diseño (la pasarela es sincrónica).
- Etapa 6 completa (testing/piloto/rollout) sigue sin arrancar.
