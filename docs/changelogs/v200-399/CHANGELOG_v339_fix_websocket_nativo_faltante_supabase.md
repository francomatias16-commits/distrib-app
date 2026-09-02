# v339 — Fix: "Node.js detected but native WebSocket not found" (Supabase no conecta)

**Fecha:** 2026-07-14
**Contexto:** `/api/health` (agregado en v338) reveló la causa real de
"el dashboard no conecta con los datos": no era una env var faltante
(`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` estaban OK), sino una
excepción al ejecutar `createClient()`:

```
Excepción al conectar: Node.js detected but native WebSocket not found.
Suggested solution: Ensure you are running Node.js 22+ or provide a
WebSocket implementation via the transport option.
```

## Causa raíz

`@supabase/supabase-js` quedó en `2.110.5` (dentro del rango
`^2.45.0` del `package.json`). Desde una versión reciente de
`@supabase/realtime-js` (su dependencia interna), el constructor de
`RealtimeClient` — que se instancia SIEMPRE dentro de `createClient()`,
aunque la app nunca use canales realtime, solo REST/RPC — referencia el
global `WebSocket` apenas se llama a `createClient(...)`.

El proyecto tiene `"engines": { "node": "20.x" }` (Vercel), y Node 20
no expone `WebSocket` como global nativo (recién Node 22 lo hace). Por
eso el primer `createClient()` de cada handler tira esa excepción — no
es un bug de nuestro código de negocio, es una incompatibilidad de
runtime.

Esto explica por qué el fix de v337 (lazy-init de clientes) no alcanzaba:
evita que la excepción tumbe TODA la lambda al importar el módulo, pero
en cuanto el handler puntual hace su primer `.from()`/`.rpc()` y dispara
`createClient()` por dentro, sigue fallando igual — solo que ahora
acotado a ese endpoint, con el mensaje genérico `Error interno del
servidor` (por diseño de `api/index.js`), lo cual lo hacía invisible
hasta que `/api/health` mostró el detalle real.

## Fix

Nuevo `lib/ws-polyfill.js`: asigna `globalThis.WebSocket` usando el
paquete `ws` (agregado como dependencia directa) SOLO si no existe ya
un `WebSocket` nativo. Se importa como primera línea de
`api/index.js` (único entrypoint/dispatcher de todas las rutas y
crons, vía `vercel.json`), así queda seteado antes de que cualquier
handler llame a `createClient()`.

No se tocó `engines.node` — se prefirió el polyfill porque no depende
de que además se actualice el runtime configurado en Vercel (Project
Settings), y es inocuo si en algún momento se sube a Node 22+ (el
`if (typeof globalThis.WebSocket === 'undefined')` lo vuelve un no-op).

## Verificación

Se simuló localmente la ausencia de `WebSocket` nativo (borrando el
global antes de importar) y se confirmó: sin el polyfill,
`createClient()` lanza la excepción; con el polyfill importado
primero, no. `api/index.js` pasa `node --check` sin errores de sintaxis.

## Archivos modificados

- `lib/ws-polyfill.js` (nuevo)
- `api/index.js` (agrega `import '../lib/ws-polyfill.js';` como primera línea)
- `package.json` / `package-lock.json` (agrega dependencia directa `ws@^8.21.1`)

## Pendiente / no incluido en este fix

- Las env vars `JWT_SECRET` y `APP_URL` siguen faltando en Vercel según
  `/api/health` — no afectan la carga de datos del dashboard, pero sí
  a login/refresh de tokens (`JWT_SECRET`) y a algunos armados de URLs
  absolutas (`APP_URL`). Cargarlas en Vercel → Settings → Environment
  Variables y hacer redeploy.
