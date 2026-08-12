# v299 — Fix logging silencioso en alertas críticas (auditoría 2026-07-12)

**Fecha:** 2026-07-12
**Origen:** simulación exhaustiva de alertas críticas contra la empresa demo
(`Distribuidora Demo S.A.`), pedida para verificar "todos los casos
hipotéticos" de notificaciones críticas.

## Problema encontrado

Se identificaron dos canales de push interno que, en ciertos casos, no
dejaban ningún registro en `notif_log`:

1. **`enviarPush()` (`lib/handlers/_push.js`)** — usado por `stock_critico`,
   `nuevo_pedido` y otros vía `pushInternoHandler`. Solo insertaba en
   `notif_log` cuando `enviadas > 0`. Si el usuario destino no tenía ningún
   dispositivo push activo (o todos los tokens fallaban), la función
   retornaba `{ enviadas: 0 }` sin loguear nada.

   **Confirmado en producción real:** se forzó `trg_push_stock_critico`
   contra la empresa demo (bajando stock de "Gaseosa Cola 2.25L" por debajo
   del mínimo, revertido después de la prueba). El trigger respondió
   `200 {"ok":true,"destinatarios":1}` — resolvió al usuario `dueno`
   correctamente — pero como no tenía dispositivo push real,
   `notif_log` quedó **sin ninguna fila nueva**.

2. **`notifAuto()` (`lib/handlers/_auto-push.js`)** — usado por `cierre.js`,
   `migracion.js`, `piloto.js`, `score.js` y `stock-auto.js` (tipos:
   `cierre_cliente_bloqueado`, `migracion_sesion_error`,
   `piloto_automatico`, `score_recalculado`, `stock_quiebre`,
   `stock_sin_proveedor`, `orden_auto_generada`). Este canal **nunca**
   insertaba en `notif_log`, ni siquiera en el camino de éxito.

**Impacto real:** revisando `notif_log` de los últimos 30 días en toda la
base (todas las empresas reales), no había **ningún** registro de
`stock_critico`, `nuevo_pedido`, `cheques_por_vencer`, `deuda_vencida`,
`cierre_cliente_bloqueado`, `stock_quiebre`, `stock_sin_proveedor` ni
`auditoria_anomalia`. Antes de este fix era imposible distinguir, mirando
la tabla, entre "no hubo nada crítico que avisar" y "se intentó avisar y
no llegó a nadie" — sin auditoría posible.

## Fix

- Migración `279_notif_log_entregada_y_motivo.sql`: agrega columnas
  `entregada boolean NOT NULL DEFAULT true` y `motivo text` a `notif_log`.
  El default `true` preserva el significado de las filas históricas (antes
  de este fix, solo se logueaban envíos exitosos).
- `_push.js`: `enviarPush()` ahora llama a `_logPush()` en **todos** los
  caminos de salida cuando viene `logMeta` (sin dispositivos, error de
  consulta, todos los tokens fallaron, éxito), marcando `entregada` y
  `motivo` en cada caso.
- `_auto-push.js`: se agregó `_logAuto()`, invocado en cada `return` de
  `notifAuto()` (VAPID no configurado, rate limit, tipo deshabilitado, sin
  usuarios admin, sin tokens, todos los tokens fallaron, éxito, error
  interno).

## Motivos posibles ahora visibles en `notif_log.motivo`

`sin_dispositivos`, `error_consultando_dispositivos`,
`todos_los_tokens_fallaron`, `vapid_no_configurado`, `rate_limit_interno`,
`tipo_deshabilitado`, `sin_usuarios_admin`, `sin_tokens_push`,
`error_interno: <detalle>`.

## Verificación

- `node --check` OK en ambos archivos editados.
- Migración aplicada y registrada en `schema_migrations_registry` (#279).
- No se modificó la firma pública de `enviarPush()` ni `notifAuto()` —
  cero cambios de comportamiento para quien los llama, solo se agregó
  logging.
- **Pendiente:** código, no tiene efecto hasta el próximo deploy. Repetir
  la prueba de `stock_critico` contra la demo después de deployar y
  confirmar que esta vez SÍ aparece una fila en `notif_log` con
  `entregada=false, motivo='sin_dispositivos'`.

## Sigue pendiente (fuera de alcance de este fix puntual)

Continúa la matriz de simulación exhaustiva del resto de los tipos
críticos (`nuevo_pedido`, `cheques_por_vencer`, `deuda_vencida`,
`cierre_cliente_bloqueado`, `stock_quiebre`, `stock_sin_proveedor`,
`auditoria_anomalia`, `score_caida_critica`) contra la demo, ahora que el
logging va a quedar confiable para auditar los resultados.
