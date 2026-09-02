# v272 — Reglas de precio: acceso duplicado en Ventas + link desde alta de pedido

Auditoría UX, tabla 1 (matriz paso→pantalla), fila "2. Validaciones del pedido":
las reglas de precio están alojadas en Facturación cuando conceptualmente
pertenecen a Ventas. Recomendación: duplicar el acceso o linkearlo desde la
alta de pedido. Se hicieron ambas cosas.

## 1. Duplicar el acceso (nav-data.js)

- Nueva entrada "Descuentos automáticos" dentro del workspace Ventas, mismo
  href/seccion que la ya existente en Facturación (/admin/reglas-precio,
  seccion: 'reglas-precio') — no se duplicó la pantalla, sólo el punto de
  entrada del menú.
- Roles: dueno, admin, vendedor (los mismos del workspace Ventas). La entrada
  original en Facturación se mantiene intacta para dueno/admin/contador.
- Como nav.js resuelve el workspace/sección activa por el primer match y
  Ventas aparece antes que Facturación en el array, al entrar por
  /admin/reglas-precio ahora resalta el ícono de Ventas — coherente con que
  conceptualmente es una validación de Ventas.

## 2. Link desde la alta de pedido (pedidos.html)

- En el modal "Nuevo pedido", junto al "Total estimado", se agregó el link
  "Ver descuentos automáticos vigentes →" que abre /admin/reglas-precio en
  una pestaña nueva (no se pierde el pedido en curso).

## Sin cambios de lógica

- No se tocó reglas-precio.js, reglas-precio.html, ni ningún handler/repo de
  `/api/reglas-precio`. Es puramente navegación — patrón aditivo, cero riesgo
  sobre el motor de reglas ya en producción.

## Con esto queda cerrada la sección 7 de la auditoría (resumen de cambios
sugeridos) en su totalidad: nav-data.js (diario:true + Órdenes de compra),
.page-intro, pulso Alta, brecha de cobro en la entrega, y ahora reglas de
precio. Quedan pendientes como decisión de producto (no de UX): qué hacer con
dashboard-v2 y setup-wizard.
