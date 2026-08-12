# v274 — Bug real: pedidos nuevos quedaban trabados en "Pendiente"

## Reporte original
En la columna Acciones de /admin/pedidos, pedidos en ciertos estados no
mostraban botón.

## Diagnóstico (con consulta directa a Supabase, proyecto jgiquzjwoedmzwqgzubr)

```sql
select estado, count(*) from pedidos group by estado;
-- entregado 1129, confirmado 385, cancelado 379,
-- preparando 376, pendiente 375, despachado 375
-- (¡'borrador' no aparece: 0 filas!)
```

El frontend (`pedidos.js`) sólo conocía `borrador` como estado inicial
(`TRANSICIONES`, `capEstado`, chip CSS, pill de filtro "Borrador"). Pero
`rpc_crear_pedido` (migración 029) crea **todos** los pedidos nuevos con
`estado = 'pendiente'`, y `confirmar_pedido_sugerido` (piloto WhatsApp)
también deja los pedidos aceptados en `'pendiente'`. `'borrador'` quedó
como un estado teórico sin uso real.

Como `pendiente` no existía en `TRANSICIONES`, esos 375 pedidos no tenían
ningún botón de acción — coincide exactamente con lo reportado.

## El bug no era solo cosmético
Al revisar la función `confirmar_pedido()` (la RPC que llama el botón
"Confirmar pedido") se encontró que **validaba `estado = 'borrador'`
únicamente**:

```sql
IF v_pedido.estado <> 'borrador' THEN
  RETURN json_build_object('ok', false, 'error', 'El pedido no está en borrador...');
END IF;
```

Esto significa que aunque hubiéramos arreglado sólo el frontend para que
aparezca el botón, al hacer clic en "Confirmar pedido" sobre cualquiera de
esos 375 pedidos la RPC iba a devolver `ok:false` — el pedido nunca podía
confirmarse. Es decir, ya existía un cuello de botella real en producción,
probablemente invisible hasta ahora porque el toast de error puede haber
pasado desapercibido o los pedidos se estaban confirmando por otra vía.

## Fix aplicado

### Backend (Supabase, en vivo + migración versionada 254)
`confirmar_pedido()`: ahora acepta `estado IN ('borrador', 'pendiente')`
para confirmar. `borrador` se mantiene por compatibilidad aunque hoy no
tenga filas reales.

### Frontend (`pedidos.js`)
- `TRANSICIONES.pendiente = ['confirmado', 'cancelado']`
- `capEstado()`: agregado `pendiente: 'Pendiente'`
- `estadoLabel` (export a Excel): agregado `pendiente: 'Pendiente'`
- `puedeFacturar`: ahora también excluye `estado === 'pendiente'` (no se
  puede facturar un pedido todavía no confirmado)

### CSS (`pedidos.css`)
- `.chip-pendiente` — mismo tratamiento visual que `.chip-borrador`
  (gris neutro), ya que antes no tenía estilo y se veía sin color.

### HTML (`pedidos.html`)
- El pill de filtro "Borrador" (`data-estado="borrador"`, 0 pedidos reales)
  se renombra a "Pendiente" (`data-estado="pendiente"`), que es el que
  realmente tiene datos.

## Sin tocar
- `cancelar_pedido()` ya funcionaba bien para pedidos en `pendiente` (usa
  lista de bloqueo `IN ('entregado','cancelado')`, no lista de permitidos).
- Los pills de "Borrador" en Presupuestos (`pres_selEstado('borrador', ...)`)
  son una entidad distinta (`presupuestos`, no `pedidos`) que sí usa
  `'borrador'` como estado real — no se tocaron.
- `estado = 'sugerido'` (pedidos generados por IA/piloto automático) no
  tiene filas reales actualmente; no se agregó al state machine del panel
  porque esos pedidos pasan a `'pendiente'` antes de llegar a esta pantalla
  (vía `confirmar_pedido_sugerido`).

## Impacto
Con este fix, los 375 pedidos que estaban en "Pendiente" ya se pueden
confirmar (o cancelar) desde /admin/pedidos, y todo pedido nuevo que entre
de acá en adelante también.
