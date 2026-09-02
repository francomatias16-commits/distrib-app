# CHANGELOG v276 — Barrido global de emojis (Fase 1)

Continuación de la regla dura "ningún emoji en la interfaz" (memoria permanente).
Esta fase cubrió las áreas mecánicas/replicables. Quedan pendientes las de diseño
custom (íconos decorativos únicos por módulo).

## Completado en esta fase

### 1. Sistema centralizado de íconos en toast()
- `ui-utils.js` y `adminlte-utils.js`: toast() ahora renderiza un ícono SVG según
  el tipo (éxito/error/warning/info) automáticamente vía innerHTML + sanitize().
- Se quitaron los ~150 emojis de prefijo/sufijo en llamadas a `toast()`,
  `window.toast()` y su alias `mostrarToast()` en todos los módulos admin,
  ya que el ícono ahora lo pone la función central.

### 2. Canales de solo texto (WhatsApp / email / push) — lib/handlers, lib/email.js
Se quitaron emojis decorativos de asuntos de email, títulos de push y plantillas
de WhatsApp (no soportan SVG): piloto.js, clientes.js, ciclos.js, notif.js,
_push.js, cierre.js, pedidos.js, score.js, stock.js, stock-auto.js, registro.js,
rutas-live.js, auditoria.js, email.js.

### 3. Scripts de terminal — scripts/*.js
Reemplazo de ✓/✗/🔧 por texto ASCII plano (OK/FAIL/[FIX]) ya que la consola no
renderiza SVG: check-schema, check-migraciones-registro, audit-funciones-fantasma,
audit-security-grants, smoke-test-frontend, test-integration.

### 4. Símbolos de cierre (×) en modales
Unificados todos los botones de cerrar modal que usaban `<span>×</span>` o `×`
suelto al mismo SVG de línea (stroke-width 2) que ya usaba cajas.html, en:
anomalias.html, auditoria.html, notas.html, notif-log.html, pos.html,
stock.html, proveedores.html, riesgo-cheques.html, facturacion.html,
vencimientos.html, cc-proveedores.html, compras.html, pedidos.html,
cliente/pedidos.html — y botones "quitar ítem" equivalentes en
notas-credito.js, cc-proveedores.js, compras.js, presupuestos.js, pedidos.js.

### 5. Checkmarks/x de estado (✓ ✗ ✕) en badges y textos
Reemplazados por SVG inline (check o x, 13px, stroke-width 2, currentColor) en
~35 sitios: badges de estado, botones Aprobar/Rechazar, Confirmar/Descartar,
mensajes "sin alertas", etc. Incluye conversión seguridad-consciente de
`.textContent =` a `.innerHTML =` (con `sanitize()` donde había datos de
usuario interpolados) en 10 archivos, para poder insertar el ícono.

### Verificación
- `node --check` sobre los ~130 archivos .js del proyecto: 0 errores de sintaxis.
- Balance de tags `<svg>`/`</svg>` verificado en los HTML modificados.

## Pendiente (Fase 2 — no incluido en este ZIP)
- El emoji ⚠ (triángulo de advertencia) aparece en ~50 lugares más (frontend y
  backend) y no estaba en la lista original auditada — falta confirmar si entra
  en la regla "todo, sin excepción" antes de tocarlo.
- Emojis decorativos únicos por pantalla que requieren diseño de ícono a medida
  (no hay un patrón mecánico reutilizable): automatizacion.html/js (🏅📦🔒🔔🗺🚨🤖🧩⛓),
  fidelizacion.html/js (⭐🎁📜🚫), status dots 🔴🟡🟢 (pos-offline.js, clientes.js,
  riesgo-cheques.js, anomalias.js — candidatos a CSS dot en vez de SVG),
  y sueltos en cheques.html, cobranzas.html, dashboard.html, facturacion-config.html,
  mercadopago-config.html, setup-wizard.html, superadmin.html, suspendida.html,
  y las pantallas de cliente/chofer/proveedor.
