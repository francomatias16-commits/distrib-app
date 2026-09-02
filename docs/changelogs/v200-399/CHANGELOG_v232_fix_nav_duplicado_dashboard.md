# v232 — Fix: menú lateral duplicado y botón flotante redundante en el Panel principal

## Problema reportado

En `/admin/dashboard.html` se veían **dos** elementos de navegación
apilados uno junto al otro (el riel angosto de íconos + un panel ancho
con "MENU" y la lista completa Panel principal / Ventas / Depósito /
Cobros y Pagos / etc.), y **dos** botones flotantes superpuestos abajo a
la derecha (WhatsApp de soporte + chat asistente).

## Causa

1. **Menú duplicado**: en la v229 (`CHANGELOG_v229_...`), `nav.js`
   agregó un "menú plano" (`buildMenuPlano`) que se mostraba en el panel
   secundario cuando el workspace activo no tenía sub-secciones propias
   (el caso del dashboard). Ese menú listaba con ícono + etiqueta **los
   mismos workspaces que ya están representados como íconos en el
   riel** de al lado — quedaban dos barras de navegación mostrando lo
   mismo. Además, `dashboard-fireart.css` forzaba ese panel a quedar
   siempre expandido (`!important`) ignorando el colapso normal.

2. **Botón flotante duplicado**: `nav.js` inyecta en todas las pantallas
   admin dos widgets flotantes independientes — el asistente de chat y
   el botón de soporte por WhatsApp — que se renderizaban ambos en la
   esquina inferior derecha.

## Cambios

- **`frontend/admin/js/nav.js`**
  - Se quitó `buildMenuPlano()` y su uso en `buildPanel()`. Cuando el
    workspace activo no tiene sub-secciones (dashboard), el panel ahora
    se colapsa igual que en cualquier otra pantalla — sin repetir el
    riel. El resto de las pantallas (Ventas, Depósito, etc.) no cambia:
    conservan su panel con sub-secciones normalmente.
  - Se comentó (no se borró) la inyección del widget de WhatsApp de
    soporte, dejando activo solo el asistente de chat, según lo pedido.

- **`frontend/admin/css/dashboard-fireart.css`**
  - Se eliminó el override que forzaba el panel duplicado a permanecer
    expandido (`.nav-panel.collapsed { width: ... !important }`) y los
    estilos del "menú plano" que ya no se usan.

## Resultado

El Panel principal ahora muestra una sola barra lateral (el riel de
íconos) y un solo botón flotante (el chat asistente).
