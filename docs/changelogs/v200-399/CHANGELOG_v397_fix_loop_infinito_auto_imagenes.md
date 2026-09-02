# v397 — Fix: loop infinito en /api/auto-imagenes cuando un producto no matchea

## Motivación
Prueba en fase de testing: se inyectaron 20 productos de bebidas/alimentos
con barcode real (marcas globales con buena cobertura conocida en Open Food
Facts) para validar que la Capa 1 funciona cuando el rubro tiene cobertura
(a diferencia del catálogo real de bazar/limpieza, confirmado en 0%).

Resultado real en base: 13 de 20 consiguieron foto. Pero el modal del admin
mostró "13 de 73" con título "Búsqueda detenida" — number inflado por un bug,
no por un procesamiento real de 73 productos (la empresa solo tenía 20
elegibles).

## Causa
`procesarLote()` selecciona los próximos N productos con `foto_url IS NULL`
ordenados por `created_at`. Un producto que no matchea en ninguna capa se
queda con `foto_url = null` para siempre — así que la tanda siguiente del
loop del frontend volvía a traer LOS MISMOS productos sin match, en cada
vuelta, indefinidamente. Como `restantes` (el total de la empresa sin foto)
nunca bajaba de ese resto permanente, el loop no tenía forma de terminar
solo — se cortó manualmente después de 9 tandas (9 × 8 ≈ 73 "procesados"
acumulados), aunque las filas reales seguían siendo 20.

Sin este fix, el mismo problema en una corrida con `incluirBusquedaReal`
activado gastaría créditos de Serper repetidamente en los mismos productos
sin salida, sin ningún beneficio.

## Cambios

### Backend (`lib/handlers/auto-imagenes.js`)
- `procesarLote()` recibe un nuevo parámetro `excluirIds` (array de UUIDs)
  y los excluye de la selección (`.not('id', 'in', ...)`).
- El handler principal valida `req.body.excluirIds` (filtra por formato
  UUID antes de pasarlo a la query, evita inyectar cualquier cosa que no
  sea un UUID válido en el filtro).

### Frontend (`frontend/admin/js/productos.js`)
- El loop de `buscarImagenesAutomaticas()` acumula en `excluirIds` el ID de
  **todo** producto tocado en la corrida actual (con o sin match) y lo
  manda en el body de cada `POST /api/auto-imagenes`.
- Con esto, cada tanda siempre trae productos nuevos — cuando ya se
  intentó con todos los que tenían `foto_url null`, el backend devuelve
  `procesados: 0` y el `break` que ya existía corta el loop de forma
  natural. El modal ahora debería mostrar "Búsqueda completada" en vez de
  "Búsqueda detenida" al terminar un catálogo chico o acotado.

## Qué NO se tocó
- La lógica de resolución por capas (barcode → Serper) no cambia.
- `restantes` sigue mostrando el total real de productos sin foto en la
  empresa (informativo) — no se usa para cortar el loop, eso lo hace
  `procesados === 0`.

## Deploy
```
vercel --prod
```
Sin cambios de base de datos.
