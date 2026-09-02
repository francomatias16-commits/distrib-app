# v811 — Fix: "Error al cargar el pedido" al imprimir remito

## Síntoma reportado
Con el fix v810 ya desplegado (así que `pedidoActivo` llegaba bien),
al clickear "Imprimir remito" apareció el toast "Error al cargar el
pedido".

## Causa
`remito.js` carga el pedido con un embed bare a `usuarios`:

```js
.select(`
  ...
  clientes(...),
  usuarios(nombre)
`)
```

La tabla `pedidos` tiene **tres** foreign keys hacia `usuarios`
(`vendedor_id`, `chofer_id`, `usuario_id` — las dos últimas agregadas
en migraciones posteriores al schema base, que solo tenía
`vendedor_id`). PostgREST no puede resolver un embed sin desambiguar
cuando hay más de una FK entre las mismas dos tablas, así que la query
devuelve error ("more than one relationship was found") en vez de
datos. `remito.js` capturaba ese error y mostraba el toast genérico
"Error al cargar el pedido", sin más detalle.

El resto del código ya tenía este problema resuelto en todos lados
donde se toca `pedidos` — por ejemplo `lib/repos/pedidos.js` usa
`usuarios!vendedor_id(nombre)` — pero `remito.js` había quedado con la
forma bare original, probablemente porque cuando se escribió `pedidos`
todavía tenía una sola FK a `usuarios` (antes de que se agregaran
`chofer_id` y `usuario_id`).

## Fix
Se desambigua el embed a `usuarios!vendedor_id(nombre)`, igual que en
el resto del código — el campo se usa como "Vendedor:" en el remito
impreso, así que corresponde a `vendedor_id`.

## Auditoría de otros embeds ambiguos
Se relevaron todas las tablas con más de una FK hacia `usuarios`:
`pedidos` (3: vendedor_id, chofer_id, usuario_id), `chofer_invitaciones`
(2) y `turnos_caja` (2). `turnos_caja` ya estaba desambiguado en todo
el código (`usuarios!usuario_id(nombre)`, con comentario explicando por
qué). `chofer_invitaciones` no tiene ningún embed bare a `usuarios` en
el código actual. El único caso roto era el de `remito.js`.

## Archivos modificados
- `frontend/admin/js/remito.js` — `usuarios(nombre)` →
  `usuarios!vendedor_id(nombre)`
- `frontend/admin/pedidos.html` y `frontend/admin/rutas.html` — bump
  cache-buster de `remito.js`
