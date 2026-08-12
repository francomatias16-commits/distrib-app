# CHANGELOG v277 — Barrido global de emojis (Fase 2)

Continuación de v276. Esta fase cubrió los íconos decorativos custom por
módulo y los status dots de semáforo que habían quedado pendientes.

## Completado en esta fase

### 1. Status dots de semáforo (bueno/normal/riesgo/premium/bloqueado)
`clientes.js` y `riesgo-cheques.js`: campo `emoji` renombrado a `icono` en
`SCORE_CATEGORIAS`, con SVG de círculo (8px, `currentColor`) para
bueno/normal/riesgo, estrella para premium y prohibido (⊘) para bloqueado.
Actualizadas todas las referencias `.emoji` → `.icono` (badges, pills).

`fidelizacion.html`: mismos íconos aplicados a las labels de segmentación
(radios/checkboxes de premium/bueno/normal/riesgo/bloqueado, ~20 sitios).

### 2. anomalias.js — pills de resumen y catálogo de tipos
Pills de resumen (lupa "patrón detectado", dot rojo "crítico", dot amarillo
"a revisar") y badge de severidad por SVG. Además se diseñaron íconos
temáticos a medida para los 15 tipos de anomalía del catálogo
(`TIPO_LABELS`): dólar, apretón de manos, caja, prohibido, etiqueta, recibo,
bandera, bolsa de dinero, regalo, moto, luna, tendencia, reloj, engranaje.
El ⚠ de `movimiento_stock_alterado` se dejó intacto, según lo acordado.

### 3. dashboard-optimizado.js
- Mapa `colorTipo` (alertas del panel) e `iconoAlerta()`: reemplazados
  pedido_nuevo/pago_pendiente/pago_recibido/error/migracion_pendiente/
  cheque_vencido por SVG; `stock_bajo` (⚠) e `ℹ` (default) se dejaron
  intactos.
- Título de "Alertas de Nivel de Confianza de Clientes": `textContent` →
  `innerHTML` para poder insertar el ícono de barras en vez de 📊.
- Tarea "alertas sin revisar": 🔔 → SVG de campana.

### 4. automatizacion.html / automatizacion.js
Íconos únicos por motor (piloto, cierre, rutas, stock, score, "qué pasó en
mi negocio"): robot, cadena, mapa, caja, medalla, lupa, reloj, engranaje,
antena/GPS, rayo. Tabs de preferencias con sus propios íconos (candado,
sirena, rompecabezas, descarga).

### 5. fidelizacion.html / fidelizacion.js
Tabs (configuración, recompensas, canjes, clientes, historial) con
engranaje/regalo/marcador/usuarios/pergamino. 🎁 en historial de canjes.

### 6. Iconos sueltos de banco/tarjeta
🏦 → ícono de banco (columnas): `riesgo-cheques.html` (x2), `cheques.html`.
💳 → ícono de tarjeta: `cc-proveedores.js`, `cc-proveedores.html`,
`saas-billing.html`, `mi-suscripcion.html`, `pos-terminal.js`.
🚫 en alerta de cuenta suspendida (`mi-suscripcion.html`) → ícono prohibido.

### 7. Canales e íconos varios
`notif-log.js` (labels whatsapp/email/push), `pedidos.js` (dirección/zona/
condición IVA), `rutas.js` (ubicación estimada/mapa, + íconos de estado
vacío), `pos.js` (aviso de venta offline sin internet).

### 8. Centralización de `mostrarEstadoVacio()`
`ui-utils.js`: ícono default (buzón) pasado a SVG. Reemplazados todos los
`icono: 'emoji'` usados en llamadas a `mostrarEstadoVacio()` en
`rutas.js`, `clientes.js` y `facturacion.js` (personas, portapapeles, caja,
calendario, camión, recibo).

### Verificación
- `node --check` sobre todos los `.js` del proyecto: 0 errores de sintaxis.
- Balance de tags `<svg>`/`</svg>` verificado en los 7 HTML modificados.

## Pendiente (Fase 3 — no incluido en este ZIP)
- El ⚠ (triángulo de advertencia) sigue sin tocarse en todo el proyecto,
  a la espera de confirmación (aparece también en varios `lib/handlers/*`
  y `lib/email.js`, fuera de la interfaz admin).
- Checkmarks/✅/❌/✓ sueltos que quedaron fuera del barrido de v276 en
  archivos no cubiertos entonces: `dashboard-optimizado.js`, `compras.js`,
  `cc-proveedores.js`, `clientes.js`, varios `.html` de configuración
  (mercadopago-config, facturacion-config), y varios `lib/handlers/*.js`
  (estos últimos son de servidor/consola, no interfaz visual directa —
  a confirmar si entran en la regla).
- Emojis decorativos sueltos de una sola aparición en pantallas de
  cliente/chofer (`cliente/pedidos.html`, `chofer/remito.html`,
  `cliente/cuenta.html`, `cliente/carrito.html`, `cliente/inicio.html`,
  `cliente/catalogo.html`) y algunas pantallas admin menores
  (`vencimientos.html`, `superadmin.html`, `reportes-*.html`,
  `setup-wizard.html`, `registro.html`, `suspendida.html`).
