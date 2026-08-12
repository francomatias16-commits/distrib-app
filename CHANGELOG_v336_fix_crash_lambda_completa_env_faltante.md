# v336 — Fix: env var faltante tumba TODA la lambda de /api/* (no solo el módulo afectado)

**Fecha:** 2026-07-14
**Severidad:** Alta — dashboard admin y el resto del panel sin cargar datos en producción.
**Origen:** reportado por Maribel ("el dashboard no conecta con los datos y otras secciones tampoco") tras un deploy reciente.

## Síntoma

Después del deploy, el dashboard mostraba "No se pudieron cargar los
KPIs" y otras secciones del panel también fallaban al cargar datos,
de forma generalizada — no un endpoint puntual.

## Diagnóstico

Se descartó, con evidencia directa contra la base real (proyecto
`jgiquzjwoedmzwqgzubr`):
- **No es un problema de RLS ni del RPC.** Se ejecutó
  `obtener_kpis_dashboard_v3` directo contra la base con datos reales
  de "Distribuidora del Litoral S.A." y devolvió resultados correctos.
- **No es un cambio de dependencias.** El handler de admin usa el
  service role key, que bypassea RLS sin importar `security_invoker`.

`api/index.js` consolida ~30 handlers en una única Serverless Function
(límite de Vercel Hobby) y los importa TODOS a nivel de módulo, de
forma eager, apenas arranca la lambda. Se reprodujo el arranque real
(`npm install` + `import('./api/index.js')`) y se encontraron **dos
inicializaciones a nivel de módulo que tiran `throw`/`SyntaxError` si
falta una env var**:

1. `lib/auth-helpers.js` — `throw new Error(...)` si falta
   `JWT_REFRESH_SECRET`.
2. `lib/handlers/_push.js` — `JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)`
   (Firebase Admin init), que tira `SyntaxError: "undefined" is not
   valid JSON` si falta `FIREBASE_SERVICE_ACCOUNT_KEY`.

Como **todos** los handlers se importan juntos en el mismo archivo,
cualquiera de esos dos throws en el import tumba el arranque de toda
la lambda — `/api/admin/kpis`, `/api/admin/pedidos`, y cualquier otra
ruta `/api/*`, aunque no tengan nada que ver con JWT o con Firebase.

## Fix

- `lib/auth-helpers.js`: el chequeo de `JWT_REFRESH_SECRET` se movió de
  nivel de módulo a `requireRefreshSecret()`, llamada recién dentro de
  `emitirRefreshToken()` (punto de uso real). Si falta la env var, solo
  falla el login/refresh — el resto del panel sigue funcionando.
- `lib/handlers/_push.js`: la inicialización de Firebase Admin se
  volvió perezosa (`asegurarFirebase()`, con try/catch), llamada al
  principio de `enviarPush()`. Si falta o está mal formado
  `FIREBASE_SERVICE_ACCOUNT_KEY`, solo falla el envío de push — el
  resto del panel sigue funcionando.
- Se verificó con `node --check` sobre todos los handlers y con un
  import real de `api/index.js` (simulando el arranque de Vercel) que
  la lambda ahora arranca OK aunque falten esas dos variables.

## Pendiente de tu lado (Vercel)

Confirmar en `vercel env ls production` que estén seteadas para el
environment **Production** (no solo Preview/Development):

- `JWT_REFRESH_SECRET`
- `FIREBASE_SERVICE_ACCOUNT_KEY`
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
- `JWT_SECRET`, `APP_URL`, `CRON_SECRET`

Si falta alguna, agregarla con `vercel env add NOMBRE_VAR production`
(o desde el dashboard → Settings → Environment Variables, tildando
"Production") y volver a deployar.

## Nota

Este es el mismo patrón de fondo que v300 (rate limiter colgando toda
la lambda): al ser una única Serverless Function para todo el proyecto,
cualquier falla no aislada en un módulo importado a nivel superior
afecta a todos los demás. Vale la pena, a futuro, auditar el resto de
`lib/handlers/*.js` por patrones similares (inicializaciones a nivel de
módulo que dependan de env vars) antes de cada deploy grande.
