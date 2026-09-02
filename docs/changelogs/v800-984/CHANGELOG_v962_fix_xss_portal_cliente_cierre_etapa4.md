# v962 — Fix XSS en portal cliente + cierre de la Etapa 4 (auditoría de bugs)

Última ronda de la Etapa 4: revisados completos los tres portales sin
login por sesión de rol propio — chofer (9 archivos), cliente (10) y
proveedor (5, pantalla pública vía token). Mismo patrón que los hallazgos
#16/#19/#20/#21/#22 de rondas anteriores.

## Hallazgo 🟡 Medio #24 — `frontend/cliente/checkout.html`

Pantalla "Confirmar Pedido" (link público que recibe el cliente por
WhatsApp antes de loguearse): `item.productos?.nombre` y
`item.productos?.unidad` se insertaban crudos en un `div.innerHTML`. A
diferencia de los otros seis archivos del portal cliente (que sí definen y
usan una función `esc()` de forma consistente), este archivo no tenía
ninguna función de escape — es el único punto de todo el portal cliente
donde el dato viajaba sin pasar por ningún filtro.

```js
// Antes:
div.innerHTML = `
  <div>
    <span class="item-nombre">${item.productos?.nombre || '—'}</span>
    <span class="item-unidad">${item.productos?.unidad || ''}</span>
  </div>
  ...`;

// Ahora:
div.innerHTML = `
  <div>
    <span class="item-nombre">${esc(item.productos?.nombre || '—')}</span>
    <span class="item-unidad">${esc(item.productos?.unidad || '')}</span>
  </div>
  ...`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
```

El nombre/unidad de producto lo carga cualquier usuario con permiso de ABM
de Productos (dueño/admin/vendedor) — mismo vector de escalamiento que los
hallazgos anteriores, agravado acá porque la pantalla es pública (sin
login) y llega directo por link de WhatsApp.

## Verificado, no es un hallazgo — `logo_url` y `archivo_url`

Dos campos usados sin `esc()` en atributos HTML (`src` de `<img>` en
`frontend/admin/login.html` y `frontend/cliente/login.html`; `href` de
`<a>` en `portal.js` para facturas de proveedor) se rastrearon hasta su
origen: ambos se generan 100% server-side —
`POST /api/empresa/logo` (`lib/handlers/empresa.js`) sube a Supabase
Storage y firma la URL él mismo; `accion=subir-factura`
(`lib/handlers/portal_proveedor.js`) hace lo mismo para el archivo
adjunto de la factura. Ninguno de los dos acepta texto libre del usuario
para ese campo — no son vectores explotables, no requieren fix.

## Sin hallazgos

Portal chofer (`index.html`, `login.html`, `invitacion.html`,
`notificaciones.html`, `restablecer-password.html`, `remito.html`,
`chofer-offline.js`, `gps-tracker.js`, `pwa-init.js`, `sw-chofer.js`) y el
resto del portal cliente (`inicio.html`, `login.html`, `carrito.html`,
`cuenta.html`, `pedidos.html`, `notificaciones.html`, `catalogo.html`,
`cliente-offline.js`, `pwa-init.js`, `sw-cliente.js`) y todo el portal
proveedor (`portal.html`, `portal.js`, `proveedor-offline.js`,
`pwa-init.js`, `sw-proveedor.js`): sanitización consistente en el resto de
los renders.

## Verificación

Sintaxis del bloque `<script>` de `checkout.html` extraído y verificado
con `node --check` — OK.

## Alcance

Con esto, la **Etapa 4 (Frontend por módulo) queda formalmente cerrada**:
los 9 módulos admin (Productos, POS, Pedidos, Clientes, Stock, Cobranzas,
Cta-Cte, Facturación, Cheques) + Rutas + los 3 portales sin sesión de rol
propio (cliente/chofer/proveedor), todos completos.
Ver `AUDITORIA_BUGS_v954.md` para el detalle completo y el estado del plan.
Sigue: Etapas 3, 5, 6, 7, 8 según el plan original.
