# v860 — Cierre completo de la migración de tokens JS

Continuación directa de v823–v828 (`rutas.js`, `busqueda-global.js`,
`pedidos.js`, `cc-proveedores.js`, `etiquetas.js`). Esta sesión cerró
los **39 archivos restantes** de `audit_table.md`, quedando el frente
en **0 pendientes**.

Mismo criterio en los 39: separar por archivo (1) fallback `var(--token,
#hex)` desincronizado con el valor real del token en `tokens.css`/
`gentelella-tokens.css`, (2) paleta intencional (avatares/series por
hash, no tokenizable 1:1), (3) hex crudo real sin `var()` de por medio,
y (4) excepción documentada (`document.write()` standalone, sin
`tokens.css` cargado). Verificado con `node --check` en los 39.

## Bugs sistémicos encontrados (se repiten en múltiples archivos)

| Fallback viejo | Token real | Aparece en |
|---|---|---|
| `#4B4A45` | `--color-text-muted` → `#5B6660` | reportes-stock, reportes-financieros, reportes-ventas, compras, notas-internas, fidelizacion, usuarios, proveedores |
| `#DAD3C0` | `--color-border-soft` → `#E7E9E4` (o `--ge-border` → `#DDE1DC` en contexto de gráfico/eje) | reportes-stock, reportes-financieros, reportes-ventas, migracion, push-admin, dashboard-ejecutivo, rutas-resumen |
| `#16181D` | `--color-text` → `#111A17` | notas-internas, rutas-resumen, camera-scanner |
| `#FCFAF5` | `--color-surface` → `#FFFFFF` | reportes-stock, reportes-financieros, reportes-ventas, notas-internas, push-admin, rutas-resumen |
| `#F5F2EA` | `--color-bg` → `#F6F7F5` | notas-internas, camera-scanner |
| `#EAE4D6` | `--color-surface-2` → `#ECEEEA` (`#EAE4D6` es en realidad `--pill-neutral-bg`) | compras (×4), fidelizacion |
| `#D1594A` en `tokens.red` | `--ge-red` → `#B8402E` (`#D1594A` es `--color-danger-mid`, no `--ge-red`) | reportes-stock, reportes-financieros, rentabilidad-zona, rentabilidad-producto-vendedor |
| `#6B695F` | `--color-text-light` → `#7A857E` | migracion, push-admin |
| `rgba(0,0,0,X)` en overlays/sombras | tinta ink `rgba(22,24,29,X)` | prácticamente todos — nunca negro puro |

El origen de la mayoría: `echarts-gentelella-theme.js` (v828→ahora)
tenía sus propios 11 fallbacks arrastrando la paleta *original* del
template Gentelella (`#26B99A`, `#3498DB`, etc.), nunca actualizada al
reskin. Como es la fuente de la que leen `tokens.teal/red/blue/...` en
todos los `reportes-*.js`, cualquiera que copiara un valor de ahí antes
de esta sesión heredaba el bug.

## Archivos con correcciones reales

- **reportes-stock.js** (24) — `colorRotacion`/`colorNegativo` con
  paleta vieja + menú de exportar (overlay, shadow, surface,
  border-soft, text-muted).
- **pos.js** (24) — `--color-border-soft` + token inexistente
  `--color-exito` (único uso en todo el proyecto) alineado a
  `--nav-ventas`, el que usa el resto del archivo.
- **notas-internas.js** (23) — 4 tokens de paleta vieja + `--color-surface`.
- **compras.js** (23) — `--color-surface-2` (×4) + `--color-danger`
  ajeno (`#c0392b`, ni siquiera de la paleta vieja del proyecto) +
  shadow negro puro.
- **automatizacion.js** (21) — shadow negro puro + morado ajeno
  (`rgba(168,85,247,X)`, Tailwind purple-500) alineado a
  `--ge-purple`/`--nav-facturacion` (`rgb(91,74,143)`) + `--color-border`.
- **reportes-financieros.js** (17) / **reportes-ventas.js** (14) —
  mismo bloque de exportar que reportes-stock.js + `tokens.red`.
- **echarts-gentelella-theme.js** (13) — los 11 fallbacks de origen
  (ver arriba) + shadow del tooltip en negro puro. Nunca se activan en
  producción (requiere `gentelella-tokens.css` cargado), pero eran la
  fuente de la que otros archivos copiaban valores viejos.
- **dashboard-ejecutivo.js** (13) — 2 grises de ECharts sin `var()`
  alineados a `--ge-border`/`--ge-ink-soft` (mismo rol que en el tema
  compartido); un tercer gris (`#C8D0D4`, línea "mes anterior") se dejó
  intencional por no tener precedente ni bug conocido.
- **camera-scanner.js** (12) — `--shadow-xl` desincronizado en *forma*
  (blur difuso viejo vs. sombra plana actual, no solo color) + 3
  fallbacks de paleta vieja + vignette en negro puro.
- **rutas-resumen.js** (11) — donut de progreso (surface/border/text
  viejos) + shadow de marker.
- **fidelizacion.js** (10) — `--color-surface-2` + `--color-text-muted`.
- **migracion.js** (9) — `--color-text-light` (nuevo hallazgo) +
  border-soft + text-muted.
- **push-admin.js** (8) — el toast completo (5 de 8 casos).
- **usuarios.js** (3) — text-muted + borde negro puro.
- **rentabilidad-zona.js** / **rentabilidad-producto-vendedor.js** (3
  c/u) — mismo bug de `tokens.red`, archivos casi idénticos.
- **proveedores.js** (3) — 1 de 3.
- **auth.js** / **ui-utils.js** — shadows/overlays negro puro +
  `--color-border` viejo en `ui-utils.js` (los diálogos de
  `confirmar()`/`confirmarConTexto()`, reutilizados en todo el sistema).
- **frontend/cliente/pwa-init.js** / **frontend/chofer/pwa-init.js**
  (3 c/u) — shadow negro puro. `#2563EB` confirmado intencional
  ("Electric Blue", color de marca de los portales no-admin).

## Sin cambios (ya correctos o intencionales)

`stock.js`, `migracion-badge.js`, `riesgo-cheques.js`,
`whatsapp-conversaciones.js`, `facturacion.js`, `cheques.js`: ya estaban
bien migrados. `export-utils.js`: excepción documentada
(`window.open()+document.write()`, mismo caso que `remito.js`).
`clientes.js`: `#25D366` es el verde oficial de WhatsApp, intencional.

Paletas rotativas por hash dejadas intencionales en: `reportes-stock.js`
(avatares depósito), `stock.js` (ídem), `notas-internas.js` (avatares
autor), `riesgo-cheques.js` (avatares cliente),
`whatsapp-conversaciones.js` (avatares contacto).

## Integración adicional

Durante la sesión se integró `distrib_v826_dashboard_pulido_v3.zip`
(pulido visual manual de `dashboard.html`: radios de borde, sombras con
blur real, gradientes en las cards de color, separadores en nav) sobre
la base de esta migración — verificado que no pisó ningún fix anterior
por hash.

## Estado final

`audit_table.md` queda en **0 archivos pendientes**. El frente de CSS
de pantalla (77 archivos) ya estaba cerrado desde v488; con esto el
frente de JS con markup hardcodeado también cierra por completo.
