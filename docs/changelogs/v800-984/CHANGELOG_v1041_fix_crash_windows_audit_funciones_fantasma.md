# v1041 — Fix crash Windows en audit:funciones-fantasma (process.exit vs exitCode) (2026-08-31)

## Por qué

`npm run audit:funciones-fantasma` reportaba bien sus 7 funciones
fantasma (**confirmado real, no falso positivo**: ninguna de las 7 tiene
`CREATE FUNCTION` en `supabase/migrations/` — verificado con grep en todo
el repo, incluyendo `resolver_deposito_pedido`, que solo aparece
*nombrada en un comentario* de la migración 550, nunca definida) pero
después crasheaba:

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

Esto corta la cadena de `predeploy` (que encadena varios checks con
`&&`), aunque el audit haya terminado bien y el reporte se haya
imprimido completo.

## Causa

El script llamaba `process.exit(n)` inmediatamente después de recibir
la respuesta de `supabase.rpc('audit_funciones_vivas')`. El cliente de
`@supabase/supabase-js` usa `fetch` (undici) por debajo, que en Windows
todavía tiene sockets/handles de red en proceso de cierre en ese
momento. Forzar `process.exit()` en esa ventana hace que Node intente
cerrar un handle que libuv ya está cerrando — el crash nativo
`UV_HANDLE_CLOSING` (no es un error de JS, es un `Assertion failed` a
nivel C++, por eso no aparece como excepción manejable).

## Fix

`scripts/audit-funciones-fantasma.js` — se reemplazaron los 3
`process.exit(n)` (en `die()` y los dos finales de `main()`) por
`process.exitCode = n` + `return`. Con esto Node termina el proceso
solo, de forma prolija, una vez que el event loop queda vacío (los
handles de red ya cerrados en ese punto) en vez de forzar una salida
abrupta a mitad de un cierre en curso. El código de salida (0/1) se
preserva igual para que `predeploy`/CI sigan detectando el fallo
correctamente.

## Pendiente

No pude re-correr el script en el sandbox (sin `.env` de Supabase, y el
crash es específico de Windows — no reproducible en Linux). Confirmame
que `npm run audit:funciones-fantasma` ya no corta con el assertion
después de imprimir el reporte.

Las 7 funciones fantasma en sí siguen pendientes de trackear (no es
parte de este fix): `fn_asegurar_piso_reciente_demo`,
`fn_extraer_medida`, `fn_generar_alertas_stock_autonomo`,
`fn_relink_portal_clientes_demo`, `resolver_deposito_pedido`,
`trigger_saas_avisar_nuevo_tenant`, `trigger_sync_saldo_puntos` — el
script mismo sugiere el camino: `pg_get_functiondef` desde el SQL
editor de Supabase, volcado a una migración nueva.
