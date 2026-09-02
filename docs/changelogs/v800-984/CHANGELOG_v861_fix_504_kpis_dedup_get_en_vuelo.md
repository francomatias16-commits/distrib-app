# v861 — Fix 504 en /api/admin/kpis: deduplicación de GETs en vuelo

## Síntoma reportado

Dashboard con el widget "Hoy en tu negocio" trabado en "Cargando…" (screenshot
`distrib-app-nine.vercel.app/admin/dashboard`, 18/08 ~08:03 ART). El resto de
los widgets (POS, WhatsApp, Comprobantes ARCA, Score Cheques, Reportes
críticos) cargaban con datos reales sin problema — el cuelgue era puntual de
un widget, no un cuelgue global de `authReady` como se sospechó al principio.

## Diagnóstico (con acceso al Supabase real del proyecto)

Consola confirmó **HTTP 504 (Gateway Timeout)** en `/api/admin/kpis?periodo=1d`,
disparado dos veces en el mismo instante — una desde `cargarKPIs()`
(`dashboard:2015`) y otra desde `cargarARCA()` (`dashboard:2650`).

Se descartó lentitud de base de datos: `EXPLAIN ANALYZE` corrido en vivo
contra el Supabase de distrib sobre las 4 funciones que arma la respuesta
(`obtener_kpis_dashboard_v3`, `obtener_ventas_por_canal`,
`obtener_resumen_compras_proveedor`, `obtener_resumen_gastos_generales`) dio
entre 5ms y 157ms cada una — nada cerca de un timeout. Tampoco es el ruido de
"Thread killed by timeout manager" en `postgrest_logs`: aparece constante
las 24hs, no solo alrededor del incidente — es limpieza normal de
conexiones idle de Warp, no falla de request.

**Causa real:** `dashboard.html` dispara `cargarKPIs()` y `cargarARCA()` en
paralelo — mismo `Promise.allSettled` de arranque (línea ~1899), y de nuevo
juntas en cada cambio de pestaña Hoy/Semana/Mes (`setPeriodo()`, línea
~1917) — y **las dos le pegan al mismo `/api/admin/kpis?periodo=X`**, mismo
dato, mismo período, mismo instante. Es la ruta más pesada del panel (1 RPC
principal + 3 en paralelo: canal, compras, gastos) corriendo en el plan
Hobby de Vercel, que cappea a 10s el timeout de función **sin importar** lo
que diga `maxDuration` en `vercel.json` (está en 60, pero ese valor solo
aplica en plan Pro+). Duplicar exactamente esa llamada dobla la chance de
pasarse del límite en un cold start.

El catch de `cargarKPIs()` (dashboard.html:2123) sí actualiza el badge a
"error al cargar" cuando el fetch falla — no es un cuelgue eterno de UI, el
screenshot probablemente capturó el estado justo antes de que el 504
resolviera (~10s de espera real de Vercel antes de responder).

## Fix

`frontend/admin/js/api-client.js` — deduplicación de GETs en vuelo:
cualquier `window.api.get(url)` que llegue mientras ya hay un fetch idéntico
sin resolver reutiliza esa misma promesa en vez de abrir un fetch nuevo.
Como GET es idempotente, no cambia el dato entregado — solo evita pegarle
2 veces a la misma ruta en el mismo instante. Corrige este caso puntual
(`cargarKPIs`/`cargarARCA`) y cualquier otro duplicado que aparezca a futuro
en el resto del panel, sin tocar cada handler uno por uno.

## Hallazgo aparte (sin tocar, a decidir)

En `postgres_logs` del proyecto real apareció, sin relación con este bug:

```
null value in column "destinatario" of relation "saas_email_log"
violates not-null constraint
```

Ocurre durante el cron `saas_cron_trial_check` (corre a las 11:00 UTC). No lo
toqué porque es un frente aparte — avisá si querés que lo audite en la
próxima sesión.

## Pendiente de tu lado

No pude confirmar el cold start de Vercel en sí (no tengo acceso a los logs
de Vercel, solo a Supabase) — si querés cerrar el diagnóstico al 100%, en el
dashboard de Vercel → tu proyecto → pestaña **Logs**, filtrá por
`/api/index` alrededor de 08:03 ART / 11:03 UTC del 18/08 y fijate la
duración real de esa invocación puntual.
