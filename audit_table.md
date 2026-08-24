# Auditoría de color hardcodeado — estado real (actualizado v860)

**Nota:** esta tabla listaba antes el frente de CSS de pantalla (77 archivos,
~1195 hex/rgba). Ese frente está **100% cerrado desde v488** — ver
`SEGUIMIENTO_HOJA_DE_RUTA.md` §1/§2.

El frente de JS que genera markup con color hardcodeado (no HTML/CSS)
**cerró por completo en v860**. Conteo re-auditado en v824-v860 (hex
`#xxx` + `rgba(` crudos, incluyendo los que están dentro de
`var(--token, #hex)` como fallback — es un **proxy mecánico de `grep`**,
no deuda real 1:1: en la mayoría de los archivos las ocurrencias eran
fallback correcto o paleta intencional, no hex crudo suelto):

| Archivo | Hex/rgba (grep) | Estado |
|---|---|---|
| `frontend/admin/js/busqueda-global.js` | 45 | Cerrado v824 (todo fallback ya sincronizado + 1 shadow → tinta ink) |
| `frontend/admin/js/productos.js` | 41 | Cerrado v730 (paleta de 12 colores intencional + overlays ya migrados) |
| `frontend/admin/js/remito.js` | 32 | Excepción documentada (doc de impresión standalone, sin tokens.css) |
| `frontend/shared/offline-core.js` | 30 | Cerrado v825 (token falso `--color-bg-elevated` + 2 fallbacks + 2 overlays) |
| `frontend/admin/js/pedidos.js` | 29 | Cerrado v826 (5 fallbacks + 1 hex crudo real; `_PALETA_AVATAR` intencional) |
| `frontend/admin/js/cc-proveedores.js` | 29 | Cerrado v827 (1 fallback desincronizado; `PROV_PALETTE` intencional) |
| `frontend/admin/js/etiquetas.js` | 28 | Cerrado v828 (5 fallbacks + 1 shadow; `PALETA` intencional) |
| `frontend/admin/js/rutas.js` | 26 | Cerrado v823 (mapas de estado + markers Leaflet + 1 fallback corregido; paleta de choferes intencional) |
| `frontend/admin/js/reportes-stock.js` | 24 | **Cerrado v860** (2 fallbacks ECharts + 6 del menú de exportar; paleta avatares intencional) |
| `frontend/admin/js/pos.js` | 24 | **Cerrado v860** (`--color-border-soft` + token inexistente `--color-exito` alineado a `--nav-ventas`) |
| `frontend/admin/js/notas-internas.js` | 23 | **Cerrado v860** (4 tokens de paleta vieja + `--color-surface`; avatares intencional) |
| `frontend/admin/js/compras.js` | 23 | **Cerrado v860** (`--color-surface-2` ×4 + `--color-danger` ajeno + shadow negro puro) |
| `frontend/admin/js/automatizacion.js` | 21 | **Cerrado v860** (shadow negro puro + morado ajeno alineado a `--ge-purple` + `--color-border`) |
| `frontend/admin/js/reportes-financieros.js` | 17 | **Cerrado v860** (mismo bloque de exportar + `tokens.red`) |
| `frontend/admin/js/stock.js` | 16 | **Cerrado v860** — sin cambios, ya correcto (avatares + widget oscuro fijo intencionales) |
| `frontend/admin/js/reportes-ventas.js` | 14 | **Cerrado v860** (mismo bloque de exportar) |
| `frontend/shared/echarts-gentelella-theme.js` | 13 | **Cerrado v860** (11 fallbacks con la paleta *original* de Gentelella nunca actualizada + shadow) |
| `frontend/admin/js/migracion-badge.js` | 13 | **Cerrado v860** — sin cambios, ya correcto |
| `frontend/admin/js/dashboard-ejecutivo.js` | 13 | **Cerrado v860** (2 grises ECharts alineados al tema compartido; 1 gris intencional) |
| `frontend/shared/camera-scanner.js` | 12 | **Cerrado v860** (`--shadow-xl` desincronizado en forma + 3 fallbacks + vignette) |
| `frontend/admin/js/rutas-resumen.js` | 11 | **Cerrado v860** (donut de progreso + shadow de marker) |
| `frontend/admin/js/fidelizacion.js` | 10 | **Cerrado v860** (`--color-surface-2` + `--color-text-muted`) |
| `frontend/admin/js/riesgo-cheques.js` | 9 | **Cerrado v860** — sin cambios, ya correcto |
| `frontend/admin/js/migracion.js` | 9 | **Cerrado v860** (`--color-text-light`, nuevo hallazgo + border-soft + text-muted) |
| `frontend/admin/js/push-admin.js` | 8 | **Cerrado v860** (5 de 8 casos, todo el toast) |
| `frontend/admin/js/whatsapp-conversaciones.js` | 7 | **Cerrado v860** — sin cambios, paleta avatares intencional |
| `frontend/admin/js/facturacion.js` | 5 | **Cerrado v860** — sin cambios, ya correcto |
| `frontend/admin/js/auth.js` | 5 | **Cerrado v860** (1 shadow negro puro) |
| `frontend/admin/js/ui-utils.js` | 4 | **Cerrado v860** (2 overlays + `--color-border`, diálogos `confirmar()`) |
| `frontend/cliente/pwa-init.js` | 3 | **Cerrado v860** (1 shadow; `#2563EB` confirmado intencional) |
| `frontend/chofer/pwa-init.js` | 3 | **Cerrado v860** (ídem) |
| `frontend/admin/js/usuarios.js` | 3 | **Cerrado v860** (text-muted + borde negro puro) |
| `frontend/admin/js/rentabilidad-zona.js` | 3 | **Cerrado v860** (`tokens.red` + splitLine) |
| `frontend/admin/js/rentabilidad-producto-vendedor.js` | 3 | **Cerrado v860** (ídem, archivo casi idéntico) |
| `frontend/admin/js/proveedores.js` | 3 | **Cerrado v860** (1 de 3, text-muted) |
| `frontend/shared/vincular-celular.js` | 2 | Cerrado v731 (fallback ya sincronizado; ver §3.9) |
| `frontend/admin/js/export-utils.js` | 2 | **Cerrado v860** — excepción documentada (`document.write()` standalone) |
| `frontend/admin/js/clientes.js` | 2 | **Cerrado v860** — sin cambios, `#25D366` es verde oficial WhatsApp, intencional |
| `frontend/admin/js/cheques.js` | 2 | **Cerrado v860** — sin cambios, ya correcto |
| `frontend/shared/topbar-widgets.js` | 1 | Cerrado v825 (fallback corregido) |
| `frontend/admin/js/productos-scanner-remoto.js` | 1 | Cerrado v825 (hex crudo → token warning) |
| `frontend/admin/js/presupuestos.js` | 1 | Confirmado v825 — fallback ya correcto, sin deuda |
| `frontend/admin/js/notas.js` | 1 | Confirmado v825 — fallback ya correcto, sin deuda |
| `frontend/admin/js/conciliacion-bancaria.js` | 1 | Confirmado v825 — fallback ya correcto, sin deuda |

**0 pendientes.** Frente cerrado por completo en v860 — ver
`CHANGELOG_v860_cierre_migracion_js_tokens.md` para el detalle de los
bugs sistémicos encontrados (fallbacks con paleta vieja repetidos en
~10 archivos, y el origen en `echarts-gentelella-theme.js`) y el
criterio aplicado en cada uno de los 39 archivos cerrados en esta
sesión.
