# CHANGELOG v1.47.1 — Fixes de validación (auditoría de CHECK constraints)

Consecuencia directa del anexo de validación integral en
`PLAN_COMERCIALIZACION_DISTRIB.md`.

## Fix 1 (bug real en producción) — `lib/handlers/migracion.js`

`deshacerSesion()` insertaba `accion: 'ROLLBACK_MIGRACION'` en `audit_log`,
valor que viola `audit_log_accion_check` (solo admite `INSERT/UPDATE/DELETE`).
El `UPDATE` de `migracion_sesiones` a `'deshecho'` ya había commiteado antes
del insert fallido, así que el usuario recibía un 500 aunque el rollback
hubiera terminado bien.

**Fix**: se mapea `accion` a `'DELETE'` (revertir altas de migración) y se
mueve el detalle `'rollback_migracion'` a `datos_despues.evento`, sin cambiar
el esquema de la tabla.

## Fix 2 (hardening preventivo) — `lib/handlers/facturas.js`

`crear_nota_credito` (RPC) no valida `p_tipo` ni tiene manejo de excepción;
el handler pasaba `tipo || 'C'` sin whitelist. Un valor fuera de `A/B/C/M`
rompía con un 500 crudo en vez de un 400 claro.

**Fix**: se agregó whitelist `TIPOS_NC_VALIDOS = ['A','B','C','M']` en el
handler antes de llamar al RPC, mismo patrón que ya protege
`registrar_pago_proveedor`.

## No aplicado en este patch (pendiente de tu decisión)

- Falta la opción **M** en los `<select>` de tipo de comprobante
  (`cc-proveedores.html`, `facturacion.html`) — no se tocó la UI para no
  asumir que corresponde a tu operatoria real.

---

# CHANGELOG v1.47.2 — Hallazgos 3 y 4 resueltos

## Hallazgo 3 (confirmado: NO era un bug)

`ordenes_compra.estado` tiene 7 valores posibles, pero el PATCH manual en
`proveedores.js` solo permite `borrador/enviada/confirmada/cancelada` como
destino. Verificado en el código:

- `recibida` y `recibida_parcial` los setea **exclusivamente** la RPC
  `recepcionar_orden_compra` (según cantidad recibida vs. pedida) —
  forzarlos a mano rompería la trazabilidad de stock.
- `pendiente_aprobacion` lo setea **exclusivamente** `stock-auto.js` al
  generar una OC automática por reposición — nunca es un destino manual
  válido, solo un punto de partida (se sale de ahí hacia `enviada`, que sí
  está permitido).

No se tocó nada — el diseño original era correcto.

## Hallazgo 4 (confirmado: sí era un gap real, implementado)

`recepciones_mercaderia.estado = 'descartada'` existía en el `CHECK`
constraint desde la migración 054 y el frontend (`compras.js`) ya tenía el
badge visual para mostrarlo, pero ningún endpoint lo seteaba jamás. Un
remito escaneado por OCR que no correspondía a la OC quedaba huérfano en
`'borrador'` para siempre, sin forma de rechazarlo.

**Implementado**:
- `POST /api/compras?accion=descartar-recepcion` en `lib/handlers/proveedores.js`
  — marca la recepción como `descartada` (solo si está en `borrador`).
- Botón "Cancelar" del modal de recepción en `compras.html`/`compras.js`
  ahora llama a `descartarRecepcion()`: si hay un remito OCR en borrador
  asociado, pide confirmación y lo descarta en el servidor; si no hay
  ninguno, simplemente cierra el modal (comportamiento anterior intacto).

