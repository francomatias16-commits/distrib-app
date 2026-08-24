# v862 — Fix: `ReferenceError: motivo is not defined` al anular factura

## Síntoma reportado
Ruben no podía anular una factura. El panel mostraba el toast rojo genérico
"Error interno del servidor" (ese toast en sí ya funcionaba bien desde la
sesión anterior — el problema era la causa detrás del 500).

## Causa raíz (confirmada con logs de Vercel, no adivinada)
```
ReferenceError: motivo is not defined
  at continuarEmisionNC (lib/arca/wsfev1.js:1238:17)
  at emitirNotaCreditoARCA (lib/arca/wsfev1.js:1126:12)
  at anularFactura (lib/facturas.js:233:21)
```

`emitirNotaCreditoARCA(facturaOriginalId, motivo = '')` recibe `motivo`
correctamente como parámetro, pero al invocar el helper interno
`continuarEmisionNC(...)` (refactor que separó la reserva de número de NC
bajo lock del resto del flujo), `motivo` no se incluía en el objeto de
argumentos ni en la firma de desestructuración de `continuarEmisionNC`.
Se perdía en el paso intermedio y explotaba al armar `p_motivo` para la
RPC `persistir_nc_y_anular_factura`.

Esto afectaba a **toda** anulación de factura A/B/C, no era un caso borde:
cualquier llamada real a `continuarEmisionNC` (fuera del camino demo, que
no pasa por ahí) rompía ahí mismo, después de ya haber obtenido el CAE de
ARCA — por eso además quedaba una cola de conciliación pendiente
(`cola_financiera` / `nc_cae_reconciliacion`) en cada intento fallido.

## Fix
`lib/arca/wsfev1.js`:
- Se agrega `motivo` al objeto pasado desde `emitirNotaCreditoARCA` hacia
  `continuarEmisionNC` (línea ~1126-1129).
- Se agrega `motivo` a la firma de desestructuración de `continuarEmisionNC`
  (línea ~1137-1140).

Cambio mínimo, sin tocar lógica de negocio ni de reconciliación.

## Nota aparte (no bloqueante, para revisar después)
La RPC `persistir_nc_y_anular_factura` acepta `p_motivo text DEFAULT NULL`
pero no lo persiste en ninguna columna — es un parámetro muerto dentro de
la función SQL (ver `supabase/migrations/20260817_nc_atomic_persist.sql`).
No es un problema funcional hoy: el motivo de la anulación ya queda
registrado igual por otra vía, vía el evento `factura_anulada` y
`registrarAuditoriaSilenciosa` en `lib/facturas.js:anularFactura()`. Se
deja anotado por si en algún momento se quiere que la NC en sí misma
guarde el motivo en una columna propia.

## Pendiente de verificación en vivo
- Reintentar la anulación de la factura que disparó el error original y
  confirmar que ahora se persiste la NC y la factura queda `anulada`.
- Revisar si quedó alguna fila huérfana en `cola_financiera` con
  `tipo = 'nc_cae_reconciliacion'` de los intentos previos fallidos (CAE
  obtenido de ARCA sin persistir) — si existe, hay que reconciliarla a
  mano en vez de reintentar la emisión (para no duplicar comprobantes
  fiscales).

## Verificación
- `node --check lib/arca/wsfev1.js` → OK.
