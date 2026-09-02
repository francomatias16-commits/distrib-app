# v298 — Fix typo de rol en push de stock crítico (OBS-03, seguimiento)

**Fecha:** 2026-07-12
**Origen:** encontrado al probar en producción el fix de `INTERNAL_PUSH_SECRET`
(ver punto 2 de `AUDITORIA_2026/00_CIERRE_AUDITORIA.md`).

## Contexto

Después de corregir el valor de `INTERNAL_PUSH_SECRET` en Vercel (que hacía
fallar el 100% de las notificaciones push con 401), se probó el flujo
end-to-end forzando el trigger de stock crítico contra la empresa demo
(`Distribuidora Demo S.A.`, `es_demo = true` — no se tocó ninguna empresa
real). El trigger ya no dio 401, pero devolvió un **500** nuevo.

## Problema encontrado

`lib/handlers/notif.js`, objeto `ROLES_POR_TIPO`:

```js
stock_critico: ['dueno', 'admin', 'deposito'],  // 'deposito' no existe
```

El enum real de roles en la base (`rol_usuario`) es:
`dueno, admin, vendedor, depositero, chofer, contador, cliente`.

`'deposito'` nunca fue un valor válido — la query
`.eq('empresa_id', ...).in('rol', roles)` rompía con
`22P02: invalid input value for enum rol_usuario: "deposito"`, y
`pushInternoHandler` lo capturaba como error 500 genérico (`errorSeguro`).

**Alcance real del bug:** único a `stock_critico`. Las notificaciones de
`nuevo_pedido` (roles `dueno`, `admin`, `vendedor` — todos válidos) no están
afectadas por este typo específico, y ya deberían funcionar con el fix del
secreto aplicado.

## Fix

```js
stock_critico: ['dueno', 'admin', 'depositero'],
```

## Verificación

- Se confirmó contra la base real que la query con `'depositero'` sí
  devuelve resultados (el usuario dueño de la empresa demo, que es lo
  esperable — no hay usuario con rol `depositero` cargado en la demo, pero
  la query ya no rompe).
- Se revirtió el cambio de stock usado para la prueba (`cantidad` del
  producto de prueba, vuelto a su valor original) — no queda ningún dato de
  test persistente.
- **Pendiente:** este fix es código, no tiene efecto hasta el próximo
  deploy. Después de deployar, repetir la prueba (bajar stock de un
  producto real o de la demo por debajo del mínimo) para confirmar que ya
  no da 500 y que, si hay un usuario con rol `depositero`/`dueno`/`admin`
  con un dispositivo push registrado, la notificación efectivamente llega.
