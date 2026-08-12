# Integración v455 — versión completa y actualizada

Base: `fluxo-v718-auditoria-redesign-completo.zip` (snapshot completo del proyecto, hasta v718).

Sobre esa base se aplicaron, en orden, los 4 parches posteriores de la serie
"Auditoría real (usuario_id)" — cada uno reemplaza el archivo correspondiente
de la base por su versión más nueva:

| Orden | Parche | Archivo(s) reemplazado(s) / agregado(s)                       |
|-------|--------|-----------------------------------------------------------------|
| 1     | v720   | `lib/handlers/pedidos.js`                                       |
| 2     | v721   | `lib/handlers/pos.js`                                           |
| 3     | v722   | `lib/handlers/pagos.js`                                         |
| 4     | v724   | `lib/handlers/chofer_invitacion.js`, `lib/asistente-tools.js`   |
| 5     | v454   | `supabase/migrations/454_auditoria_registrar_cobro_completo.sql` (nueva — auditoría del cobro manual, que no pasa por ningún handler de Node) |
| 6     | v455   | `lib/handlers/cc_proveedores.js` (pagos a proveedores), `lib/handlers/pos.js` (ABMs de configuración: favoritos, movimientos de caja, cajas, umbral cajero, hardware, PIN supervisor, promociones, transferencias de stock) |

Los archivos `.js` tocados se validaron con `node --check` (sintaxis OK)
después de la integración. No hubo conflictos entre parches: cada uno tocó
handlers distintos, salvo v724 que actualizó `chofer_invitacion.js` y
`lib/asistente-tools.js` en conjunto (la tool `revocar_invitacion_chofer`
depende del nuevo parámetro `revocado_por` agregado en `chofer_invitacion.js`),
por lo que ambos se tomaron juntos de la misma versión. v455 reutiliza el
`lib/handlers/pos.js` ya actualizado por v721 (agrega auditoría a los write
points que esa etapa había dejado fuera de alcance a propósito).

Los changelogs individuales de cada etapa quedan en esta misma carpeta para
referencia:
- `CHANGELOG_v720_auditoria_pedidos.md`
- `CHANGELOG_v721_auditoria_pos.md`
- `CHANGELOG_v722_auditoria_pagos.md`
- `CHANGELOG_v724_auditoria_chofer_invitacion.md`
- `CHANGELOG_v454_auditoria_registrar_cobro_completo.md` — cierra la deuda
  técnica que quedaba abierta desde v722 (cobro manual/Cobranzas). A
  diferencia de los otros 4, este fix vive en una migración SQL nueva
  (`registrar_cobro_completo` corre 100% del lado de la base, sin handler
  de Node en el medio) en vez de un archivo `.js` reemplazado.
- `CHANGELOG_v455_auditoria_cc_proveedores_y_pos_abms.md` — cierra las dos
  últimas piezas de deuda técnica documentadas en la serie: pagos a
  proveedores (`cc_proveedores.js`) y los 8 ABMs de configuración de POS
  que v721 había dejado fuera de alcance a propósito (favoritos,
  movimientos de caja, cajas, umbral de descuento, hardware, PIN de
  supervisor, promociones, transferencias de stock). Con esto no queda
  ningún punto pendiente marcado explícitamente en los changelogs
  originales de la serie.

Todo lo demás (frontend, migraciones SQL, docs, tests, etc.) proviene sin
cambios de la base v718.
