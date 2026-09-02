# Fix — "No se pudo registrar la revisión" al aprobar/rechazar una devolución

## Síntoma

Al tocar "Aprobar" o "Rechazar" en el panel de detalle de una devolución
(`Depósito → Devoluciones`), siempre aparecía el toast genérico:

> No se pudo registrar la revisión. Probá de nuevo.

Pasaba con cualquier devolución, sin importar el motivo, el estado ni el rol
del usuario.

## Causa

`revisarDevolucion()` en `frontend/admin/js/devoluciones.js` mandaba el PATCH
a `/api/admin/devoluciones` (sin query string) y ponía `accion: 'revisar'`
adentro del body JSON:

```js
await api('/api/admin/devoluciones', {
  method: 'PATCH',
  body: JSON.stringify({ accion: 'revisar', id, estado, ... }),
});
```

Pero el backend (`handleDevolucionesAdmin` en `lib/handlers/pedidos.js`) lee
la acción desde el **query string** de la URL, no del body:

```js
const { id, accion } = req.query;
...
if (req.method === 'PATCH' && accion === 'revisar') { ... }
```

Como la URL nunca llevaba `?accion=revisar`, esa condición nunca se
cumplía, la request caía al fallback del final de la función
(`return res.status(405).json({ error: 'Método o acción no soportada' })`),
y ese 405 era lo que el frontend traducía al toast genérico. Los otros
llamados del mismo archivo (`listar`, `kpis`, detalle por `id`) sí ponían la
acción en la URL — solo el de `revisar` (el único PATCH) lo hacía distinto,
y por eso era el único que fallaba siempre.

## Fix

Se movió `accion=revisar` al query string de la URL, dejando `id`, `estado`,
`reponer_stock` y `generar_nc` en el body (que es donde el backend ya los
leía correctamente):

```js
await api('/api/admin/devoluciones?accion=revisar', {
  method: 'PATCH',
  body: JSON.stringify({ id, estado, reponer_stock, generar_nc }),
});
```

No se tocó el backend — ya estaba leyendo `req.query.accion` correctamente
en línea con el resto de los endpoints del mismo handler.

## Archivos modificados

- `frontend/admin/js/devoluciones.js`
