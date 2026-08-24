# v804 — Fix idempotencia en revisar devolución (evita duplicar stock y NC)

## Bug

Consecuencia directa del v803. El `.catch()` roto tiraba 500 **después** de
que el handler ya había reposeado stock y generado la nota de crédito, solo
fallaba al final (recálculo de score). El admin, al ver el error, reintentaba
"Aprobar" — y como `actualizarEstadoDevolucion` hacía un `UPDATE` sin
condicionar por el estado actual, cada reintento volvía a correr TODO el
flujo desde cero.

### Impacto real detectado en producción (2026-08-17, ventana 04:30–04:41 UTC)

Durante la ventana en que el deploy todavía tenía el bug del v803, 3
devoluciones de prueba quedaron duplicadas:

| Devolución | Reintentos | Stock repuesto de más | NC pendiente de más |
|---|---|---|---|
| `debe56ab` | 2 | +1 u. (02ae7fd0) | $1.009,14 |
| `c5011d02` | 2 | +4 u. (a3516de9) | $5.871,07 |
| `d6b8c6ba` | 3 | +4 u. (a3516de9) | 2× $2.796,77 |

Total: **+8 u. de stock de más** en "Arroz Largo Fino 1kg" (a3516de9),
**+1 u. de más** en "*LECHE NIVEA VISAGE..." (02ae7fd0), y **~$12.473,75**
en notas de crédito pendientes que no correspondían.

**Corregido manualmente en Supabase** el mismo día (movimientos de stock y
notas de crédito duplicados borrados, cantidades de stock ajustadas). Las NC
duplicadas estaban todas en estado `pendiente` — ninguna había sido emitida
en ARCA, así que no hubo impacto fiscal.

## Fix

Guard de idempotencia a nivel de base de datos, en vez de solo chequear en
el código (cubre también condiciones de carrera / doble-click):

**`lib/repos/pedidos.js`** — `actualizarEstadoDevolucion` ahora condiciona el
`UPDATE` a `estado = 'pendiente'`:

```js
.eq('id', id).eq('empresa_id', empresa_id).eq('estado', 'pendiente')
.select()
.maybeSingle();
```

Si la devolución ya fue revisada, el `UPDATE` no matchea ninguna fila y
devuelve `data: null` (con `.maybeSingle()`, sin tirar error).

**`lib/handlers/pedidos.js`** — el handler corta ahí si `data` viene null,
devolviendo 409 con el estado actual, en vez de seguir de largo reponiendo
stock y generando NC:

```js
if (!devolucion) {
  const { data: actual } = await obtenerDevolucionDetalle(empresa_id, devId);
  return res.status(409).json({
    error: actual
      ? `Esta devolución ya fue revisada (estado actual: ${actual.estado}). No se volvió a procesar.`
      : 'Devolución no encontrada.',
    devolucion: actual || null,
  });
}
```

## Archivos modificados
- `lib/repos/pedidos.js` (`actualizarEstadoDevolucion`)
- `lib/handlers/pedidos.js` (bloque `PATCH ?accion=revisar`)

## Nota
Este guard es genérico — protege contra cualquier reintento futuro (error de
red, doble click, timeout del cliente, lo que sea), no solo el bug puntual
del v803.
