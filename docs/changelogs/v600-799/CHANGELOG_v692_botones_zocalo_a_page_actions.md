# v692 — Sacar botones de acción del zócalo (`.topbar`) a `.page-actions`

**Contexto:** consulta de arquitectura de navegación — si los botones de funciones propias de cada
página debían vivir en el zócalo superior (`.topbar`, chrome global compartido por las 45 pantallas
del admin) o dentro de la hoja de trabajo. Se evaluó y se definió como regla general del proyecto:
el zócalo queda como navegación pura e invariable; las acciones de cada página van junto a su
descripción, siguiendo el patrón usado en paneles de gestión de referencia (Linear, Stripe Dashboard,
Notion).

## Hallazgo

- Ya existía en `frontend/shared/adminlte-components.css` el patrón de destino completo y documentado
  (`.page-intro-row` + `.page-actions`), pero solo estaba aplicado en `facturacion.html`.
- Relevamiento: 19 páginas del panel admin tenían botones de acción propios metidos en `.topbar-right`
  (de 1 a 3 botones cada una). `dashboard.html` quedó fuera a propósito: su topbar es 100% custom, con
  status pills de estado/navegación rápida, no acciones de página.

## Cambios

- **16 páginas** (ya tenían `.page-intro`): `cajas`, `cc-proveedores`, `cheques`, `clientes`,
  `cobranzas`, `compras`, `notas`, `notif-log`, `proveedores`, `riesgo-cheques`, `stock`, `usuarios`,
  `vencimientos`, `reglas-precio`, `rentabilidad-producto-vendedor`, `rentabilidad-zona` — se envolvió
  su `.page-intro` existente en `.page-intro-row` y se sumó `.page-actions` con los botones migrados
  desde `.topbar-right`.
- **`pedidos.html`** — ya tenía `.page-intro-row` (con los dos `.page-intro` de Pedidos/Presupuestos);
  se le agregó `.page-actions` con los 3 botones (Nuevo pedido, Nuevo presupuesto, Punto de venta).
- **`productos.html`** y **`pos.html`** — sin `.page-intro` propio; se creó una fila
  `.page-intro-row` nueva alineada a la derecha (`justify-content:flex-end`) solo con `.page-actions`.
  En `pos.html` se conservó `#pos-turno-chip` en el zócalo por ser indicador de estado (turno de caja
  abierto), no una acción — solo se movió el link "Pedidos y presupuestos".
- En todos los casos se preservó intacto `<span class="topbar-usuario">` en `.topbar-right`.
- Portales fuera de `/admin` (`/cliente`, `/chofer`, `/proveedor`, `/scan-pos`) quedaron fuera de
  alcance: usan otro layout, sin este patrón de zócalo.

## Resultado

- `.topbar-right` queda limpio en las 45 pantallas (solo chip de usuario, y en POS el chip de turno).
- 20 páginas usan ahora `.page-actions` (las 19 migradas + `facturacion.html`, que ya lo tenía).
