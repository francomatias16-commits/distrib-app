# v693 — Encabezados de tabla agrupados en pantallas del admin

## Qué cambia

Se agrega un componente compartido, `frontend/shared/tabla-agrupada.css`, que
suma una fila opcional arriba del `<thead>` de cada tabla para agrupar
columnas por categoría (ej. "Identificación / Contacto / Financiero /
Estado"). Es 100% aditivo: no redefine ninguna regla existente de
`fila-cliente`, `badge-estado`, avatares, colores de deuda, hover, etc. — solo
agrega una fila de cabecera nueva y una clase `.thead-sep` opcional para
separadores verticales entre grupos.

Aplicado en las 12 pantallas cuya tabla principal tiene 7+ columnas (donde el
encabezado plano ya era difícil de escanear rápido). Se dejó sin tocar las
tablas de 4-6 columnas (auditoria, automatización, cajas, cobranzas,
devoluciones, export-contable, fidelización, puntos) porque ahí una fila de
agrupación de más solo suma ruido sin aportar nada.

## Archivos

- **Nuevo:** `frontend/shared/tabla-agrupada.css`
- **Modificados** (se agregó `<link>` al nuevo CSS + fila `.thead-grupo` en el
  `<thead>` de la tabla principal):
  - `frontend/admin/clientes.html` — Identificación / Contacto / Financiero / Estado
  - `frontend/admin/cc-proveedores.html` — Comprobante / Fechas / Financiero / Estado
  - `frontend/admin/cheques.html` — Comprobante / Banco / Vencimiento
  - `frontend/admin/comparador-precios.html` — 2 tablas (ranking + detalle por proveedor)
  - `frontend/admin/compras.html` — Orden / Fechas / Estado
  - `frontend/admin/conciliacion-bancaria.html` — Movimiento / Conciliación
  - `frontend/admin/facturacion.html` — 2 tablas (facturas + notas de crédito)
  - `frontend/admin/notas.html` — Comprobante / Cliente-Monto / Estado
  - `frontend/admin/notif-log.html` — Notificación / Contexto / Estado
  - `frontend/admin/pedidos.html` — 2 tablas (pedidos + presupuestos)
  - `frontend/admin/proveedores.html` — 2 tablas (listado + links de portal)
  - `frontend/admin/reglas-precio.html` — Regla / Condición / Vigencia / Estado

## Verificación hecha

Se corrió un chequeo automático confirmando que en las 16 tablas tocadas la
suma de `colspan` de la fila de grupo coincide exactamente con la cantidad de
columnas reales de la fila de datos (evita headers desalineados). Falta
verificación visual en navegador — recomendado antes de mergear.

## Pendiente / a decidir

- No se tocó `cajas.html`, `auditoria.html`, `automatizacion.html`,
  `cobranzas.html`, `devoluciones.html`, `export-contable.html`,
  `fidelizacion.html`, `puntos.html` — todas sus tablas tienen 6 columnas o
  menos. Avisar si alguna igual se quiere agrupar.
- El nombre de cada grupo (ej. "Identificación", "Financiero") es una
  propuesta editorial mía basada en lo que agrupa cada columna — vale la pena
  una pasada rápida para confirmar que el copy encaja con cómo hablás vos del
  sistema.
