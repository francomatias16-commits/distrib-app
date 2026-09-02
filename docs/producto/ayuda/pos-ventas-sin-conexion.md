---
slug: pos-ventas-sin-conexion
categoria: pos
roles: [admin, cliente, proveedor]
---

# Vender sin conexión a internet

El POS puede seguir funcionando aunque se corte la conexión a internet.

## Cómo funciona

- Mientras no hay conexión, cada venta se guarda localmente en el dispositivo (en el navegador).
- Apenas la conexión vuelve, esas ventas se sincronizan automáticamente contra el servidor.
- Cada venta hecha sin conexión queda marcada internamente como venta offline, y el sistema usa un identificador local único para evitar que la misma venta se cargue duplicada al sincronizar.

## Qué podés esperar

- Podés seguir cobrando y emitiendo comprobantes internos con normalidad durante el corte.
- El stock y las cuentas corrientes se actualizan recién cuando la venta se sincroniza, no en el momento exacto de la venta offline.
- Si el dispositivo se cierra o se borra el navegador antes de sincronizar, esas ventas pendientes se pueden perder — por eso conviene sincronizar apenas vuelva la conexión y no dejarlo para el día siguiente.

## Preguntas frecuentes

**¿Cómo sé si una venta se sincronizó?**
Una vez sincronizada, la venta deja de figurar como pendiente y aparece con normalidad en el listado de ventas del turno, con su numeración definitiva.

**¿Puedo facturar una venta que todavía está offline, sin sincronizar?**
No. La factura electrónica requiere que la venta ya esté sincronizada con el servidor.
