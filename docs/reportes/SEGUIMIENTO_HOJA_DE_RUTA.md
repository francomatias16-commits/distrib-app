# Seguimiento — Migración al sistema de diseño "Hoja de Ruta"

**Este documento es de estado, no de dirección.** La dirección de diseño (paleta, tipografía, criterio del sello de estado) vive en `DESIGN_SYSTEM_HOJA_DE_RUTA.md`. Acá solo se registra qué está hecho, qué falta, y los próximos pasos concretos. Se actualiza en cada ZIP nuevo.

**Última actualización:** v828 — `etiquetas.js` migrado por completo (ver §3.16).

> **Nota (v984, verificado contra código real):** el frente de "JS que genera markup con colores hardcodeados" que esta sección daba como "23/34 archivos, en curso" en realidad **cerró por completo en v860** — ver `audit_table.md`, que es ahora la fuente de verdad para ese frente (39 archivos cerrados en la sesión v860, incluyendo `reportes-stock.js` y `pos.js`, mencionados abajo como "siguiente"). Verificado línea por línea en v984: los únicos hex crudos que quedan en `pos.js` (`#487050` en dos lugares) son el valor por defecto de un `<input type="color">` — no pueden ser `var()` porque el atributo `value` de ese input exige un string hex literal, no una custom property. Es una excepción real, mismo criterio que `remito.js`, no deuda pendiente.

---

## 1. Resumen ejecutivo

| Frente | Hecho | Falta | Estado |
|---|---|---|---|
| CSS de pantalla (77 archivos, hex hardcodeado) | 77 archivos (24 Alta+Media + 53 Baja), ~1195 hex/rgba resueltos | 0 | **Cerrado** |
| Páginas sin ningún CSS con tokens | — | 0 reales (ver 3.1, hallazgo corregido) | Cerrado |
| HTML con `style=""` inline hardcodeado | 28 archivos | 0 | **Cerrado** |
| JS que genera markup con colores hardcodeados | v728-v828 (ver arriba) + v860: los 34 archivos restantes cerrados (ver `audit_table.md`) — verificado contra código real en v984 | 0 (excepciones documentadas: `remito.js`, defaults de `<input type="color">` en `pos.js`) | **Cerrado (v860, reverificado v984)** |

Fundación (tokens.css, gentelella-tokens.css, el sello de estado como alias de `.badge`) — hecha en Fase 0 (v482), no requiere retrabajo salvo cambio de dirección.

## 2. Checklist general

- [x] Fase 0 — fundación de tokens (v482)
- [x] Prioridad Alta (14 archivos) — cerrada v483–v486
- [x] Prioridad Media (10 archivos, 16–31 hex c/u) — cerrada v487
- [x] Prioridad Baja (53 archivos, <16 hex c/u) — cerrada v488
- [x] Auditoría de `style=""` inline en 28 HTML — **cerrada v489**
- [x] Swap mecánico de paleta vieja (`#B87A00`/`#1F5B4A`/`#B3261E`) en JS — cerrado v728-v729
- [x] Auditoría de fallbacks `var(--token, #hex)` desincronizados en JS (mismo bug que 3.5.2 en HTML) — cerrada v729, 144 casos en 23 archivos
- [x] `productos.js` — overlays/bordes `rgba(0,0,0,X)` → tinta ink; paleta de 12 colores por categoría dejada intencional — cerrado v730
- [x] `remito.js` — evaluado, dejado como excepción documentada (documento de impresión standalone, sin `tokens.css`) — v731
- [x] `vincular-celular.js` — migrado completo a tokens, incluye el azul #2563EB heredado de Stripe/Linear — cerrado v731
- [x] `rutas.js` — mapas de color de estado (2 instancias), bordes/sombras de markers Leaflet y 1 fallback desincronizado (`--color-text-light`) migrados; `CHOFER_PALETTE` dejada intencional — cerrado v823
- [x] `busqueda-global.js` — 6 fallbacks desincronizados corregidos (`--color-surface`, `--color-border`, `--radius-md`, `--color-text-muted`, `--color-bg`, `--color-text`) + 1 shadow crudo → tinta ink; no tenía hex crudo real ni paleta intencional — cerrado v824
- [x] Confirmar los 5 casos de 1 hit sin auditar de `audit_table.md` — 2 fixes reales (`topbar-widgets.js` fallback, `productos-scanner-remoto.js` hex crudo → token warning), 3 ya correctos (`presupuestos.js`, `notas.js`, `conciliacion-bancaria.js`) — v825
- [x] `offline-core.js` — token falso `--color-bg-elevated` (nunca definido) → `--color-surface`; 2 fallbacks desincronizados + 2 overlays/shadows → tinta ink; los 21 casos de badges de estado (danger/warning/success) ya tenían fallback correcto — cerrado v825
- [x] `pedidos.js` — 5 fallbacks desincronizados corregidos (spinner de carga, bloque de error, banner predictivo) + 1 hex crudo real (chip "Devolución rechazada" → `--color-text-muted`/`--color-border`, mismo par que `.btn--secondary`); `_PALETA_AVATAR` (7 colores) dejada intencional — cerrado v826
- [x] `cc-proveedores.js` — 1 fallback desincronizado corregido (`--color-surface-2`); `PROV_PALETTE` (idéntica a `CHOFER_PALETTE`) dejada intencional; el resto ya tenía fallback correcto — cerrado v827
- [x] `etiquetas.js` — 5 fallbacks desincronizados corregidos (mismo patrón que `busqueda-global.js`: `--color-text-muted`, `--color-border`, `--color-text`, `--color-surface`, `--color-bg`) + 1 shadow → tinta ink; `PALETA` (8 colores para etiquetas) dejada intencional — cerrado v828
- [x] Resto del frente de hex/rgba crudos reales en JS — 34 archivos, cerrado v860 (`reportes-stock.js`, `pos.js` incluidos — ver `audit_table.md`), reverificado contra código v984

## 3.5 Auditoría HTML inline (v489) — resumen

Los 28 HTML tenían dos problemas mezclados, no solo hex crudo:

1. **`var(--token-falso, #hex)` — tokens que nunca existieron** (bug real, no solo cosmético: al no existir el custom property, el navegador siempre renderiza el fallback hex). Encontrados: `--color-bg-alt`, `--color-bg-alt2`, `--color-bg-card`, `--color-bg-muted`, `--color-hover`, `--color-neutral-bg`, `--color-surface2`, `--color-text-secondary`, `--texto-secundario` — todos remapeados a su token real equivalente (`--color-surface-2`, `--color-surface`, `--color-text-muted`, etc.), en 18 archivos.
2. **`var(--token-real, #hex)` con fallback inerte** — mismo patrón ya visto en `login.css`/`a11y-focus.css`: el token real ya existe y funciona, pero quedó un fallback hex (a veces de la paleta vieja, ej. `rgba(37,99,235,...)`) sin sentido. Se limpiaron todos (incluyendo dos casos de `--ge-teal-dark`/`--ge-teal-light` en `cajas.html`).
3. **Hex/rgba crudos fuera de `var()`** (~130 casos): mapeo mecánico por propiedad (`color`/`background`/`border`) a los tokens semánticos de `tokens.css` (texto, superficie, éxito/alerta/peligro/info) y a `--ge-*`/`--nav-*` donde el contexto era gentelella o un pill de sección. Overlays de modal `rgba(0,0,0,X)` → `rgba(22,24,29,X)` (mismo mapeo de tinta ya usado en `tienda-nav.css`). Se corrigió además un fallback roto con typo (`var(--color-primary,.#185FA5)` en `clientes.html`).

**Excepción intencional que queda con hex:** verde de marca WhatsApp (`#25D366`) en `clientes.html`, igual que en el CSS.

## 3. Prioridad Baja — resumen de lo cerrado en la pasada v488

Mismo patrón detectado y corregido en toda la Baja:

- **Reemplazo mecánico `#fff`/`#FFF`/`#ffffff` → `var(--ge-panel)`** en los 39 archivos `*-gentelella.css` del lote.
- **Casos especiales no-boilerplate** resueltos archivo por archivo: `stock-gentelella.css` (`--ge-text, #333` → `--ge-ink-soft`), `compras-gentelella.css` (badge morado → `--ge-purple` con `color-mix`), `cobranzas-gentelella.css` y `devoluciones-gentelella.css` (rojo oscuro → `color-mix(var(--ge-red), black)`), `soporte-gentelella.css` (azul hover → `color-mix(var(--ge-blue), white)`; verde WhatsApp hover queda intencional), `auditoria-gentelella.css` (fallback `--ge-teal, #2563EB` → `--ge-teal` limpio).
- **`rgba()` de paleta vieja en decimal** (invisibles al grep de hex): `rgba(38,185,154,X)` (turquesa viejo) y `rgba(37,99,235,X)` (azul viejo) → `rgba(184,122,0,X)`, encontrados y corregidos en 10 archivos, incluyendo dos que la tabla marcaba con "0 hex" (`gentelella-fkpi.css` y el chequeo confirmó `notif-log-gentelella.css`/`empresa-config-gentelella.css` limpios).
- **Archivos "otros" (tokens `--color-*`)**: `tema-claro-shipp.css` (reskin local de Pedidos — tokens propios en `:root` quedan intencionales; solo se corrigió el verde viejo suelto y una duplicación de navy), `tienda-nav.css`, `pagination.css`, `skeletons.css`, `whatsapp-widget.css` (verde WhatsApp de marca queda intencional), `a11y-focus.css` (`--ring` pisaba el token real, mismo patrón que `login.css`), `base-layout.css` (shared y admin, gradientes radiales con verde viejo), `portal.css`, `rutas-resumen.css`, `pedido-modal-fullscreen.css` (overlay `rgba(15,23,42,X)` → `rgba(22,24,29,X)`, mismo mapeo usado en `tienda-nav.css`).

**Excepciones documentadas que quedan con hex a propósito** (no son deuda pendiente):
- `stock-gentelella.css` líneas 157/161: mini-badges de contraste sobre card oscura lateral (`#fdb072`/`#6fe3b4`).
- `soporte-gentelella.css` / `whatsapp-widget.css`: verde de marca WhatsApp (`#25D366`/`#1ebe57`).
- `tema-claro-shipp.css`: paleta propia del reskin de Pedidos en su `:root`.

## 3.6 Auditoría JS (v728-v729) — resumen

**v728:** migración de 4 constantes de color de la paleta vieja "Hoja de Ruta" (`#B87A00`/`#1F5B4A`/`#B3261E`) usadas directamente en JS/SVG (sparkline de ventas, `coloresMedio`, `ARCA_COLORES`, `SCORE_COLORES_CAT`) — swap 1:1 a los tokens actuales, preservando que cada categoría siga siendo distinguible en las leyendas. También corregido un error propio de la pasada anterior (`--danger-rgb` apuntaba a `--color-danger` en vez de `--color-danger-mid`).

**v729 — dos hallazgos más sobre los mismos 43 archivos con color en JS:**

1. **Residuo de la migración v728**: 12 archivos más (`offline-core.js`, `automatizacion.js`, `productos.js`, `rentabilidad-producto-vendedor.js`, `reportes-ventas.js`, `stock.js`, `reportes-financieros.js`, `pos.js`, `compras.js`, `rentabilidad-zona.js`, `pedidos.js`, `reportes-stock.js`) todavía tenían `#1F5B4A`/`#B3261E` de la paleta vieja — la mayoría como fallback de `var(--token, #hex)`, algunos como hex crudo (config de ECharts en `stock.js`, valor por defecto de un `<input type="color">` en `pos.js`). Swap mecánico a `#487050`/`#D1594A` — 33 ocurrencias.

2. **Bug sistémico de fallbacks desincronizados** (mismo patrón que la sección 3.5, punto 2, encontrado en el audit de HTML): en `var(--nombre-token, #hex)`, el nombre del token es correcto pero el hex de respaldo quedó de una paleta anterior y no coincide con el valor real que tiene ese token hoy en `tokens.css`. Como los navegadores modernos siempre soportan custom properties, el fallback nunca se ve — pero es una inconsistencia real que confunde a quien lee el código y es un riesgo latente. Encontrados **144 casos en 23 archivos** (`cc-proveedores.js` con 23, `offline-core.js` y `pos.js` con 14 cada uno, `busqueda-global.js` con 13, etc.) — típicamente `--color-danger`, `--color-success`, `--color-warning` y sus variantes `-bg`/`-mid`. Corregidos todos con el mismo criterio que HTML: fallback = valor real actual del token, nombre de variable sin tocar. Verificado con `node --check` en los archivos con más cambios — sin errores de sintaxis.

**Nota importante:** ninguno de los dos hallazgos de v729 cambia nada visualmente (los navegadores objetivo soportan `var()`, así que el fallback nunca se renderiza) — es limpieza de deuda/consistencia, no un fix de bug visible. Distinto del hallazgo del verde WhatsApp en `dashboard.html` (v729 pre-existente a esta sesión), que sí era visible.

**Lo que queda de este frente (real, no fallback):** ~261 hex/rgba crudos fuera de `var()` en 34 archivos — la parte que la sección 4 del roadmap ya anticipaba como "más lenta": series de ECharts (`echarts-gentelella-theme.js`, `reportes-stock.js`, `dashboard-ejecutivo.js`), gradientes de sparkline, colores Material ad-hoc en pills puntuales, y algunos casos aislados en `remito.js`, `vincular-celular.js`, `rutas.js` no revisados todavía. Requiere ir archivo por archivo (no swap mecánico) porque acá sí hace falta criterio: no todo color de gráfico debe tokenizarse 1:1.

## 3.7 `productos.js` (v730) — primer archivo del frente de hex crudo real

De los 32 hex/rgba crudos que tenía el archivo, dos grupos con tratamiento distinto:

1. **7 `rgba(0,0,0,X)`** (overlays de modal, borde de opción seleccionable, pista del
   spinner, fondo sutil de aviso) → migrados a `rgba(22,24,29,X)`, mismo mapeo de
   tinta (ink en vez de negro puro) ya usado en `tienda-nav.css` y
   `pedido-modal-fullscreen.css`. Mismo alpha, solo cambia el tinte de base.
2. **`PALETA` (12 colores, líneas 66-79)** — set de pares fondo/texto Tailwind
   (amarillo, ámbar, verde, naranja, azul, piedra, rosa, pizarra, gris, rojo,
   violeta, teal) que rota por categoría de producto vía `getPaleta(cat)`. **Se
   dejó sin tocar, a propósito**: el sistema de tokens solo tiene ~5 colores
   semánticos (éxito/alerta/peligro/info/primario) y esta paleta necesita 12 tonos
   simultáneamente distinguibles para que categorías distintas no compartan color
   — forzar un mapeo 1:1 a tokens colapsaría varias categorías al mismo color y
   rompería la función del componente. Es el caso que la sección 4 del roadmap ya
   anticipaba ("no necesariamente debería tokenizarse 1:1"). Queda como excepción
   documentada, igual que el verde de marca de WhatsApp.

Se verificó con `node --check` que el archivo sigue siendo válido después del
cambio.

## 3.8 `remito.js` (v731) — excepción documentada, no migrado

29 hex/rgba en un bloque `<style>` embebido en un template de HTML completo
(`<!DOCTYPE html>` propio) que la función abre en `window.open('', '_blank')`
y escribe con `document.write()` — confirmado en el propio comentario del
archivo: *"No tiene dependencias externas: abre una ventana con HTML/CSS
listo para imprimir"*. Esa ventana nueva **no carga `tokens.css`**, así que
`var(--color-text)` etc. no resolverían a nada — no es el mismo caso que
`vincular-celular.js` (que inyecta estilos en el `<head>` de la página ya
cargada, donde los tokens sí están disponibles).

Es estructuralmente el mismo tipo de excepción que `tema-claro-shipp.css`
(§3, "Archivos otros"): un documento autocontenido con paleta propia, no
deuda por drift. Además es un remito para imprimir — grises puros (`#1a1a1a`,
`#555`, `#ccc`, etc.) son una elección de diseño razonable para impresión
en blanco y negro, independiente de la paleta de pantalla. Se deja sin
tocar y documentado acá para que no se vuelva a evaluar de cero en otra
sesión.

## 3.9 `vincular-celular.js` (v731) — migrado completo

Modal de "vincular celular" (QR para usar el teléfono como lector remoto de
código de barras), estilos inyectados en `document.head` de la página viva
— sí tiene acceso a los tokens. A diferencia de `productos.js`, acá los 21
colores no eran casos aislados sino la paleta completa de un modal armado
con la estética SaaS genérica que el propio `DESIGN_SYSTEM_HOJA_DE_RUTA.md`
identifica como lo que había que dejar atrás — incluye literalmente
`#2563EB`, el mismo "Electric Blue heredado de Stripe/Linear" que el
documento de dirección nombra explícitamente. Mapeo completo:

| Antes | Ahora | Uso |
|---|---|---|
| `#fff` (fondo modal/QR) | `var(--color-surface)` | Coincide exacto (#FFFFFF) |
| `#edf0f4` (bordes) | `var(--color-border-soft)` | Borde sutil |
| `#e5e7eb` (borde spinner, hover botón) | `var(--color-border)` | Borde estándar |
| `#1a2233` (títulos) | `var(--color-text)` | Texto fuerte |
| `#6b7280` / `#4b5563` (texto secundario) | `var(--color-text-muted)` | Texto secundario |
| `#8a93a3` (nota, texto terciario) | `var(--color-text-light)` | Texto terciario |
| `#f3f4f6` (hover) | `var(--color-surface-2)` | Superficie hover |
| `#2563eb` (spinner, links, código) | `var(--color-primary)` | Acento — antes azul cliché, ahora verde del sistema |
| `#f59e0b` (punto parpadeante "esperando") | `var(--color-warning-mid)` | Estado pendiente |
| `#ecfdf3` / `#16a34a` (ícono de éxito) | `var(--color-success-bg)` / `var(--color-success)` | Estado éxito |
| `#dc2626` / `#fef2f2` (error / botón peligro) | `var(--color-danger)` / `var(--color-danger-bg)` | Estado error |
| `#fee2e2` (hover botón peligro) | `color-mix(in srgb, var(--color-danger-bg) 92%, black)` | Mismo patrón de oscurecido que `cobranzas-gentelella.css` |
| `rgba(15,23,42,.55)` (overlay) / `rgba(0,0,0,.25)` (shadow) | `rgba(22,24,29,X)` | Tinta ink, mismo mapeo que overlays de modal en otros archivos |

Verificado: `node --check` sin errores; 0 hex/rgba crudos restantes en el
archivo (confirmado con el mismo script comparativo de v729).

## 3.10 `rutas.js` (v823) — migrado completo

Genera markup con `L.divIcon` de Leaflet en dos lugares (mapa principal de
despacho y mapa del reporte de ruta cerrada), ambos inyectados en el
documento vivo (con acceso a `tokens.css`) — no es el caso `remito.js`.

- **Mapa `colores` de estado de entrega** (2 instancias — mapa principal
  línea ~721 y mapa de reporte línea ~1531): `entregado/no_entregado/
  pendiente/en_camino` → `var(--color-box-success/danger/warning/info,
  #hex)`. Los 4 hex ya coincidían exactamente con `--color-box-*` de
  `tokens.css` (pensados para este uso: fondo sólido de un ícono, no
  texto/badge).
- **Bordes y texto blanco de los markers** (mapa principal, mapa de
  reporte y marcador de chofer — 3 lugares, 6 ocurrencias) →
  `var(--color-surface, #fff)`.
- **Sombras `rgba(0,0,0,X)`** de los tres markers (`.3`, `.35`, `.4`) →
  tinta `rgba(22,24,29,X)`, mismo mapeo de "ink en vez de negro puro" ya
  usado en `productos.js`/`tienda-nav.css`.
- **1 fallback desincronizado**: `var(--color-text-light,#6B695F)` — el
  hex de respaldo no coincidía con el valor real del token
  (`--color-text-light: #7A857E`). Corregido, mismo criterio que la
  auditoría de fallbacks de v729.
- **`CHOFER_PALETTE`** (5 colores para hashear nombre→color de avatar,
  línea 18) — dejada intencional, mismo criterio que `PALETA` en
  `productos.js`: colores que necesitan ser mutuamente distinguibles
  entre sí, no un estado semántico de marca.
- 2 usos de `var(--color-success,#487050)` (modal de detalle de entrega)
  y 1 de `var(--color-info-mid,#33507A)` (marcador de chofer) ya tenían
  el fallback correcto — no requirieron cambio.

Verificado con `node --check` — sin errores. Sin cambios visuales
esperados (los 4 colores de estado y los 3 fallbacks ya correctos eran
idénticos a sus tokens; los únicos cambios reales de valor son el
fallback inerte de `--color-text-light` y el tinte de los overlays negros,
ninguno de los cuales el navegador renderiza distinto en la práctica —
`rgba(22,24,29,X)` vs `rgba(0,0,0,X)` es visualmente casi idéntico).

## 3.11 `busqueda-global.js` (v824) — migrado completo, sin hex crudo real

Inyecta un `<style>` en `document.head` de la página viva (línea 196) —
acceso a `tokens.css`, no es un caso `remito.js`. A diferencia de todos
los archivos anteriores del frente, acá **el 100% de los 45 hits del grep
ya estaban dentro de `var(--token, #hex)`** — el archivo no tenía hex
crudo real, era puramente el bug de fallback desincronizado (mismo patrón
de §3.5 punto 2 / §3.6 punto 2), más un `box-shadow` con negro puro fuera
de `var()`.

**6 fallbacks corregidos** (nombre de token sin tocar, solo el hex de
respaldo al valor real actual de `tokens.css`):

| Token | Fallback viejo | Fallback correcto |
|---|---|---|
| `--color-surface` | `#FCFAF5` | `#FFFFFF` |
| `--color-border` | `#C7BFA9` | `#DDE1DC` |
| `--radius-md` | `6px` | `4px` |
| `--color-text-muted` | `#4B4A45` | `#5B6660` |
| `--color-bg` | `#F5F2EA` | `#F6F7F5` |
| `--color-text` | `#16181D` | `#111A17` |

**1 shadow crudo**: `box-shadow: 0 8px 32px rgba(0,0,0,.14)` del dropdown
→ `rgba(22,24,29,.14)`, mismo mapeo de tinta usado en el resto del
frente.

Todos los demás tokens del archivo (`--color-primary`, `--color-info*`,
`--color-success*`, `--color-warning*`, `--color-danger*`, `--pill-*`)
ya tenían el fallback sincronizado — no requirieron cambio. Verificado con
`node --check` y con un script comparativo que confirma 0 hex/rgba fuera
de `var()` en el archivo (fuera del shadow ya corregido). Sin cambios
visuales esperados (el fallback nunca se renderiza en navegadores con
soporte de custom properties; el shadow es visualmente casi idéntico).

## 3.12 Los 5 casos de 1 hit sin auditar (v825)

`audit_table.md` v824 dejó marcados 5 archivos nunca vistos en auditorías
anteriores (1 hit de grep c/u). Confirmados:

- **`topbar-widgets.js`**: `var(--color-border,#d1d5db)` — fallback
  desincronizado, corregido a `#DDE1DC` (valor real del token).
- **`productos-scanner-remoto.js`**: `color:#d97706` — hex crudo real
  (no estaba en `var()`), texto del link "reportar imagen incorrecta".
  Migrado a `var(--color-warning, #8A5F13)`, mismo token que usan
  `.badge--warning`/`.toast--warning` para texto de advertencia.
- **`presupuestos.js`**, **`notas.js`**, **`conciliacion-bancaria.js`**:
  ya tenían el fallback correcto y sincronizado — sin cambios.

## 3.13 `offline-core.js` (v825) — migrado completo

Los 21 casos de color de los badges de estado (conflicto/cuarentena/sync/
offline/pendientes/online — `--color-danger*`/`--color-warning*`/
`--color-success*`) ya tenían el fallback correcto, sin cambios. El resto:

- **Token falso `--color-bg-elevated`** en el fondo del modal de
  conflictos — nunca se definió en ningún `.css` del proyecto (mismo bug
  real de §3.5 punto 1, no cosmético: el navegador siempre renderizó el
  fallback `#fff` porque el custom property no existe). Remapeado a
  `var(--color-surface, #FFFFFF)`, equivalente exacto.
- **2 fallbacks desincronizados**: `--color-text-muted,#666` → `#5B6660`;
  `--color-border` en dos lugares (`#ddd` y `#ccc`) → `#DDE1DC`.
- **2 overlays/shadows crudos** (`rgba(0,0,0,0.5)` del overlay del modal,
  `rgba(0,0,0,0.3)` de su sombra) → tinta `rgba(22,24,29,X)`.

Verificado con `node --check`. Sin cambios visuales esperados salvo el
fondo del modal, que antes de este fix ya se veía blanco por el fallback
inerte — visualmente idéntico.

## 3.14 `pedidos.js` (v826) — migrado completo

Genera markup para la tabla principal, el spinner de carga, el bloque de
error y un banner de autocompletado — todo en el documento vivo.

- **5 fallbacks desincronizados**: `--color-border-soft,#DAD3C0` →
  `#E7E9E4`; `--color-text,#16181D` (×3, spinner/error/banner) →
  `#111A17`; `--color-text-light,#6B695F` → `#7A857E`;
  `--color-text-muted,#4B4A45` → `#5B6660`.
- **1 texto blanco crudo** del botón "Reintentar" (`color:#fff`) →
  `var(--color-surface, #fff)`.
- **1 hex crudo real**: el chip "Devolución rechazada" usaba `#7a7a7a`/
  `#c7c7c7` sueltos (estado neutro, sin token asignado) → migrado a
  `var(--color-text-muted, #5B6660)` / `var(--color-border, #DDE1DC)`,
  el mismo par que usa `.btn--secondary` en `tokens.css` para su estilo
  neutro/outline.
- **`_PALETA_AVATAR`** (7 colores para hashear nombre de cliente→color)
  — dejada intencional, mismo criterio que `CHOFER_PALETTE`/`PALETA`.
- El resto (chip de factura con error, mensaje de error de facturación
  en el modal, banner predictivo `--color-info*`) ya tenía el fallback
  correcto.

Verificado con `node --check`. Sin cambios visuales esperados salvo el
chip "Devolución rechazada", que pasa de un gris fijo a los tokens de
texto/borde muteados — visualmente casi idéntico.

## 3.15 `cc-proveedores.js` (v827) — migrado completo, mínima deuda real

Archivo liviano en comparación a lo anterior: de los 29 hits del grep,
solo **1 era fallback desincronizado real**:

- `var(--color-surface-2,#EAE4D6)` (encabezado de la tabla de pagos) —
  el hex de respaldo correspondía a `--pill-neutral-bg`, no al valor real
  de `--color-surface-2` (`#ECEEEA`). Corregido.

Todo lo demás (danger/warning/success en badges, montos y estados de
factura) ya tenía el fallback sincronizado. `PROV_PALETTE` (línea 27,
idéntica a `CHOFER_PALETTE` de `rutas.js`) dejada intencional — mismo
componente de avatar por hash reutilizado en varios módulos.

Verificado con `node --check`. Sin cambios visuales esperados.

## 3.16 `etiquetas.js` (v828) — migrado completo

Mismo patrón que `busqueda-global.js`: inyecta `<style>` en
`document.head` (línea 496) y ya usaba `var(--token, #hex)` en todo,
pero con los fallbacks de una paleta anterior desincronizados.

**5 fallbacks corregidos** (mismos valores viejos/nuevos que
`busqueda-global.js` — parece haber sido la misma pasada de generación
de estos dos archivos en algún momento):

| Token | Fallback viejo | Fallback correcto |
|---|---|---|
| `--color-text-muted` | `#4B4A45` | `#5B6660` |
| `--color-border` | `#C7BFA9` | `#DDE1DC` |
| `--color-text` | `#16181D` | `#111A17` |
| `--color-surface` | `#FCFAF5` | `#FFFFFF` |
| `--color-bg` | `#F5F2EA` | `#F6F7F5` |

**1 shadow crudo**: `box-shadow: 0 8px 24px rgba(0,0,0,.12)` del popover
de gestión → `rgba(22,24,29,.12)`.

`--color-primary` y `--color-danger` ya tenían el fallback correcto.
**`PALETA`** (línea 46, 8 colores para etiquetas por hash) — dejada
intencional, mismo criterio que `PALETA` en `productos.js`.

Verificado con `node --check`. Sin cambios visuales esperados.

## 4. Próximos pasos sugeridos (en orden)

1. **Los hex/rgba crudos reales que quedan en 23 archivos JS** (fuera de `var()`, ver §3.6-3.16 y `audit_table.md`) — siguiente: `reportes-stock.js` (24), `pos.js` (24), `notas-internas.js` (23), `compras.js` (23). Criterio acumulado: overlays/bordes en negro puro → `rgba(22,24,29,X)` (tinta ink); paletas rotativas de N colores por categoría (N > tokens semánticos disponibles) → dejar intencional; fallback de `var(--token, #hex)` → siempre chequear contra el valor real en `tokens.css`, no asumir que coincide; **antes de migrar cualquier archivo, confirmar que sus estilos se inyectan en el documento vivo** (con acceso a `tokens.css`) y no en una ventana/documento standalone tipo `window.open()` + `document.write()` — en ese caso es excepción, no deuda.

## 5. Para retomar en otra sesión

1. Leer este documento completo (estado) y `DESIGN_SYSTEM_HOJA_DE_RUTA.md` (dirección/criterio).
2. Seguir con la sección 4 de acá, en orden — empezando por `reportes-stock.js`.
3. Al terminar cada archivo/frente: recontar y actualizar este documento antes de subir el ZIP nuevo. **Importante (lección de v728-v729):** actualizar este documento en la misma pasada en que se hace el cambio, no dejarlo para después — quedó 6 versiones desactualizado (v489 → v729) y eso generó descoordinación entre lo hecho realmente en `dashboard.html`/JS y lo que este archivo decía.
