# v300 — Fix urgente: rate limiter cuelga /api/admin/* (60s timeout)

**Fecha:** 2026-07-12
**Severidad:** Alta — dashboard admin completo sin cargar en producción.
**Origen:** reportado por Cristian ("ya deployé y ahora no carga ningún
dato") justo después de deployar v299.

## Síntoma

Después del deploy, `/admin/dashboard` quedó con los skeleton loaders
girando indefinidamente. Todos los endpoints bajo `/api/admin/*` (`kpis`,
`pedidos`, `stock/bajo`, `ventas-diarias`, `alertas`, `onboarding`,
`dashboard-ejecutivo`, `comparativa-mensual`, `resumen-arranque`)
devolvían `504 Vercel Runtime Timeout Error: Task timed out after 60
seconds`, de forma determinista y reproducible en cada reintento.

## Diagnóstico

Se descartó, con evidencia directa contra la base real:
- **No es un problema de queries lentas.** Se corrieron con
  `EXPLAIN ANALYZE` las mismas consultas que usan esos endpoints
  (`obtener_kpis_dashboard_v3`, `obtener_dashboard_ejecutivo_resumen`,
  cheques, notificaciones_push) contra la empresa real afectada — todas
  terminan en milisegundos.
- **No hay locks.** `pg_locks` sobre `api_rate_limits` (y el resto de la
  base) no mostró ningún lock activo durante ni después del incidente.
- **No es Supabase Auth.** Los logs de `auth` muestran `/user` respondiendo
  en 2-10ms consistentemente.
- **La request nunca llega a Supabase.** Revisando los logs de la API de
  Supabase en la ventana exacta de cada timeout, no aparece ningún
  request correspondiente a esos endpoints — ni el RPC del dashboard, ni
  la query de cheques. Se cuelga *adentro* de la función de Vercel, antes
  de tocar la red hacia Supabase.

Lo único nuevo y común a **todos** los endpoints afectados es el rate
limiter (`lib/rate-limit.js`), migrado ayer (2026-07-11, "RL-01") de un
`Map` en memoria a un contador atómico en Supabase vía
`await db.rpc('fn_rate_limit_check', ...)`, que corre antes que cualquier
otra lógica de cada handler. El código documentaba "fail-open ante
cualquier error de red/DB", pero ese fail-open solo cubría una
**excepción lanzada** (try/catch). No cubría un `await` que nunca
resuelve — un socket colgado o una conexión reusada en mal estado entre
invocaciones del lambda, algo conocido en runtimes serverless con
`fetch`/`undici` reutilizando conexiones keep-alive. En ese caso el
`await` se queda esperando para siempre y el fail-open nunca se ejecuta,
consumiendo los 60s completos del límite de Vercel.

## Fix

`lib/rate-limit.js`, función `chequearContadorSupabase()`: se agrega un
timeout duro de 3 segundos con `Promise.race()`. Si `fn_rate_limit_check`
no contesta en ese margen, se aplica el mismo criterio de fail-open que ya
existía para errores lanzados (se permite la request, se loguea la
advertencia). No cambia el comportamiento normal — en el camino feliz el
RPC contesta en milisegundos, muy por debajo de los 3s.

## Verificación

- `node --check lib/rate-limit.js` OK.
- No se modificó la firma de `rateLimit()`, `rateLimitApi`,
  `rateLimitAuth` ni `rateLimitPorClave()` — cero cambio de comportamiento
  para quien los llama.

## Acción pendiente de tu lado

1. **Deployar esto ya** — es lo que probablemente destraba el dashboard.
2. Si después de deployar el problema persiste (poco probable, pero por
   las dudas): probá un redeploy limpio ("Redeploy" en Vercel, no solo un
   nuevo commit) para forzar contenedores lambda nuevos, por si alguna
   instancia quedó con una conexión en mal estado. Avisame y sigo
   investigando con logs frescos.
3. A mediano plazo: si esto se repite, vale la pena instrumentar
   `chequearContadorSupabase` con una métrica de cuántas veces cae en la
   rama de timeout — si es frecuente, el problema de fondo (conexión
   reusada en mal estado) sigue ahí aunque el síntoma (dashboard colgado)
   ya no se note.
