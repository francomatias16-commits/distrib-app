# v338 — Nuevo: /api/health, diagnóstico de env vars y conexión Supabase

**Fecha:** 2026-07-14
**Contexto:** continuación de v336/v337 ("dashboard no conecta con los
datos"). El fix de v337 (lazy-init de los clientes Supabase en
`lib/repos/_db.js` y `lib/supabase-lazy.js`) ya evita que falte una env
var tumbe TODA la lambda — pero si esa env var directamente no está
seteada en Vercel, cada endpoint individual sigue devolviendo 500,
todos con el mismo mensaje genérico `Error interno del servidor`
(por diseño, para no filtrar detalles internos — ver dispatcher
`api/index.js`). Eso hacía difícil distinguir "sigue roto el código"
de "falta configurar Vercel".

## Qué se agregó

`GET /api/health` (público, sin auth, rate-limited a 10 req/min por IP,
mismo patrón que `/api/setup/status`):

- Chequea presencia (no valores) de: `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
  `APP_URL`, `FIREBASE_SERVICE_ACCOUNT_KEY`, `CRON_SECRET`.
- Si `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` están presentes,
  hace una consulta real de prueba (`count` sobre `empresas`) para
  confirmar que la conexión a Supabase efectivamente funciona (no solo
  que las env vars existen).
- Devuelve siempre 200 con un JSON de diagnóstico (`ok`, `env_vars`,
  `env_vars_faltantes`, `supabase.ok`, `supabase.detalle`).

## Nota de seguridad

Este endpoint es público a propósito (mismo criterio que
`/api/setup/status`, necesario para poder diagnosticar antes de tener
sesión) y **no expone valores** de ninguna env var, solo booleans. El
campo `supabase.detalle` sí puede incluir el mensaje de error crudo de
Supabase cuando la conexión falla — pensado como herramienta temporal
de diagnóstico. Evaluar si conviene protegerlo con `CRON_SECRET` o
sacarlo una vez resuelto el incidente actual.

## Pendiente de tu lado (Vercel)

Pegar `https://distrib-app-nine.vercel.app/api/health` en el navegador
(o `curl`) y mirar `env_vars_faltantes` y `supabase.detalle`. Con eso
se sabe en el momento si:

- Faltan env vars en **Production** (no alcanza con tenerlas en
  Preview/Development), o
- Las env vars están pero la `SUPABASE_SERVICE_ROLE_KEY` es inválida/
  rotada, o el proyecto de Supabase está pausado.

Después de corregir env vars en Vercel, hace falta un **redeploy**
(no se aplican solas a un build ya corrido).
