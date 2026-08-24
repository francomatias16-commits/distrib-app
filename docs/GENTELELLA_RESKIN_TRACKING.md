# Reskin Gentelella v4 — Tracking de avance y deuda técnica

Este doc se actualiza cada vez que se cierra una pantalla del reskin.
Ver también: `frontend/shared/gentelella-tokens.css` (fuente única de
tokens) y `frontend/admin/dashboard-gentelella.css` (pantalla de
referencia del método).

## Pantallas terminadas

| # | Pantalla | Archivo CSS                              | Estado | Notas |
|---|----------|-------------------------------------------|--------|-------|
| 1 | dashboard | frontend/admin/dashboard-gentelella.css   | ✅ OK  | Limpiado el `:root` duplicado, ahora consume tokens compartidos |
| 2 | pedidos   | frontend/admin/css/pedidos-gentelella.css | ✅ OK  | Deuda de tokens resuelta el 2026-07-14 (ver historial abajo). También cubre la pestaña presupuestos (ver ítem 8) |
| 8 | presupuestos | — (no tiene HTML/CSS propio) | ✅ OK, sin trabajo | `presupuestos.html` es solo un stub de redirect a `/admin/pedidos?tab=presupuestos` (sin body visual). Ya queda resuelto por `pedidos-gentelella.css`, que cubre `.page-tabs`, `.page-tab`, `.btn-nuevo-pres`, etc. Confirmado el 2026-07-14, no se saltó nada. |
| 3 | pos       | frontend/admin/css/pos-gentelella.css     | ✅ OK  | Igual — deuda resuelta antes de incorporar. Buena nota: documentó bien por qué el panel de totales se mantiene oscuro (decisión de UX de mostrador, no un olvido) |
| 4 | clientes  | frontend/admin/css/clientes-gentelella.css | ✅ OK  | Ver "Regresión detectada" abajo — se corrigió antes de incorporar |
| 5 | productos | frontend/admin/css/productos-gentelella.css | ✅ OK  | La más limpia hasta ahora, sin regresiones. Confirmó el patrón `--ge-info-text` (ver abajo) |
| 6 | stock     | frontend/admin/css/stock-gentelella.css   | ✅ OK  | Regresión de #7d4000 otra vez (5 usos), corregida. Ver nota abajo sobre por qué se repite |
| 7 | devoluciones | frontend/admin/css/devoluciones-gentelella.css | ✅ OK | Sin regresión — primera pantalla limpia desde el aviso. Path de tokens normalizado (ver nota) |
| 9 | notas     | frontend/admin/css/notas-gentelella.css   | ✅ OK  | La más limpia de todas hasta ahora. Path de tokens normalizado igual que devoluciones |
| 10 | rutas    | frontend/admin/css/rutas-gentelella.css   | ✅ OK  | Sin regresión de hex — grep de los 6 valores en vigilancia (`#7d4000`, `#a06800`, `#7a5000`, `#f0f3f4`, `#1a5f8b`, `#25D366`) dio cero coincidencias. Único hardcode es `#fff` (3 usos, texto sobre botón/avatar sólido — igual que el resto de pantallas). Path de tokens venía corto (`/shared/...`) otra vez, normalizado al largo `/frontend/shared/gentelella-tokens.css` al integrar |
| 11 | reglas-precio | frontend/admin/css/reglas-precio-gentelella.css | ✅ OK | Sin regresión de hex, sin `:root` duplicado. CSS base de esta pantalla es `reportes.css` (compartido con reportes) + un `<style>` inline — el reskin sobreescribe todo bajo el scope sin tocar el inline. Path de tokens venía corto, normalizado al largo. **Nota (no bloqueante):** el CSS incluye reglas para `.modal-overlay`, `.modal-box`, `.modal-inner`, `.modal-regla-header` que no existen en el HTML actual de esta pantalla — quedan inertes (no aplican a nada) salvo que en el futuro se agregue ese modal. No se tocó HTML para agregarlas ni quitarlas |
| 12 | comparador-precios | frontend/admin/css/comparador-precios-gentelella.css | ✅ OK | Mismo caso que reglas-precio: CSS base es `reportes.css` + `<style>` inline, path normalizado. **Nota (no bloqueante):** incluye reglas para `.btn-volver` que no existe en el HTML de esta pantalla (sí existe en otras, como `sin-permiso.html`) — inerte por ahora |
| 13 | fidelizacion | frontend/admin/css/fidelizacion-gentelella.css | ✅ OK | Sin regresión de hex, sin `:root` duplicado, único hardcode `#fff` (x3, texto sobre elemento sólido). CSS base es `reportes.css` + `<style>` inline, path normalizado. **Nota (no bloqueante):** incluye regla para `.topbar-contador`, clase de topbar usada en otras pantallas (devoluciones, stock, puntos, etc.) pero no presente en `fidelizacion.html` — inerte por ahora |
| 14 | puntos | frontend/admin/css/puntos-gentelella.css | ✅ OK | Sin regresión de hex, sin `:root` duplicado, único hardcode `#fff` (x1). CSS base es `finanzas.css` + `<style>` inline, path normalizado. **Nota (no bloqueante):** incluye regla para `.tipo-compra`, clase usada en otras pantallas (clientes, cheques, cobranzas, etc.) pero no presente en `puntos.html`/`puntos.js` — inerte por ahora. `.btn-pag` / `.paginacion-container` sí están cubiertas (componente de paginación compartido) |
| 15 | facturacion | frontend/admin/css/facturacion-gentelella.css | ✅ OK | Sin regresión de hex, sin `:root` duplicado, único hardcode `#fff` (x3). Primera pantalla de esta tanda con CSS base propio dedicado (`facturacion.css`, no compartido) en vez de un `<style>` inline. Los `badge-anulada/emitida/error/pendiente` que parecían huérfanos en la búsqueda automática en realidad sí están cubiertos: se generan con template literal `badge-${f.estado}` en `facturacion.js`. **Nota (no bloqueante):** `.md-label`, `.modal-field-label`, `.modal-footer` sí quedan inertes — no existen en `facturacion.html` |
| 16 | cobranzas | frontend/admin/css/cobranzas-gentelella.css | ✅ OK, con 1 fix aplicado | Pantalla fusiona 2 vistas (`cobranzas.js` + `cta-cte.js`). **Bug real encontrado y corregido antes de integrar:** el CSS traía `.semaforo-verde/.semaforo-amarillo/.semaforo-rojo/.semaforo-gris` como clases compuestas, pero `estadoSaldo()` en `cta-cte.js` genera `class="semaforo ${estado.cls}"` con `estado.cls` SIN el prefijo `semaforo-` (solo `'rojo'`/`'amarillo'`/`'verde'`) — el selector nunca hubiera matcheado y el semáforo de saldos habría quedado sin colorear en producción. Corregido a selectores compuestos `.semaforo.verde`, `.semaforo.amarillo`, `.semaforo.rojo`, `.semaforo.gris` (este último queda inerte igual, no existe estado "gris" en el mapeo — solo rojo/amarillo/verde). Por contraste, `.chip-rojo/.chip-verde/.chip-amarillo/.chip-gris` y `.monto-rojo/.monto-verde` sí estaban bien desde el origen (esos sí usan la clase compuesta como token único en el JS). **Token en vigilancia confirmado 2da vez:** `#c0392b` reapareció (`.btn.btn--danger:hover`, con fallback `var(--ge-red-dark, #c0392b)`) — igual que en `devoluciones`. Se decidió NO tokenizar todavía (a diferencia del patrón previo de 2-apariciones=tokenizar), queda como hardcode/fallback en ambas pantallas por decisión explícita del usuario. Resto de hex sin regresión, único otro hardcode es `#fff` (x4) |
| 17 | cheques | frontend/admin/css/cheques-gentelella.css | ✅ OK | Sin regresión de hex (incluido `#c0392b`, no reapareció), sin `:root` duplicado, único hardcode `#fff` (x2). Verificado específicamente el patrón de bug encontrado en cobranzas: acá `.chip-azul/.chip-amarillo/.chip-verde/.chip-rojo/.chip-gris` SÍ están bien — `cheques.js` genera `cls` ya con el prefijo `chip-` incluido (`{cls:'chip-azul', ...}`), sin el problema de espacio-vs-prefijo de `semaforo`. **Nota (no bloqueante):** `.modal-backdrop` inerte — no existe en `cheques.html` (sí en otras pantallas como stock, puntos, facturación) |
| 18 | lotes | — (no tiene HTML/CSS propio) | ✅ OK, sin trabajo | `lotes.html` es solo un stub de redirect a `/admin/vencimientos` (sin body visual, `<body></body>` vacío). Confirmado el 2026-07-14: no hay nada que reskinear acá — queda cubierto cuando le toque el turno a `vencimientos` más adelante en la cola. Mismo patrón que `presupuestos` (ítem 8) |
| 19 | cta-cte | — (no tiene HTML/CSS propio) | ✅ OK, sin trabajo | `cta-cte.html` es un stub de redirect a `/admin/cobranzas?vista=saldos` (confirmado en el comentario del propio archivo: fusión de "Cuenta corriente" y "Cobranzas" en una sola puerta de entrada, fase 0 de auditoría IA/UX). Ya queda resuelto por `cobranzas-gentelella.css` (ítem 16), que `cobranzas.html` ya carga junto con `gentelella-tokens.css`. Confirmado el 2026-07-14, tal como se sospechaba en el prompt original |
| 20 | liquidacion | — (no tiene HTML/CSS propio) | ✅ OK, sin trabajo | `liquidacion.html` es un stub de redirect a `/admin/vencimientos?vista=liquidacion` (`<body></body>` vacío, igual patrón que `lotes`). Confirmado el 2026-07-14: se resuelve cuando le toque el turno a `vencimientos` |
| 21 | reportes-financieros | frontend/admin/css/reportes-financieros-gentelella.css | ✅ OK | Primera pantalla real de la tanda "reportes-*" — CSS base es `reportes.css` (compartido, layout genérico de `.kpis-grid`/`.kpi-card`/`.chart-section`/`.ranking-section`/`.status-badge`, usado por reportes-ventas y reportes-stock a continuación en la cola). Sin regresión de hex (grep de los 6 valores en vigilancia dio cero coincidencias), único hardcode `#fff`. Botones usan el componente compartido `.btn.btn--primary`/`.btn.btn--ghost` (mismo patrón que `clientes`), no el `.btn-primary`/`.btn-secondary` que define `reportes.css` — esos quedan inertes en esta pantalla (no se tocó HTML para migrarlos). Verificado el `status-badge` generado por JS (`class="status-badge ${estadoClass}"`, con `estadoClass` ∈ `red/yellow/green`): matchea selectores compuestos `.status-badge.red/.yellow/.green`, sin el bug de espacio-vs-prefijo visto antes en `cobranzas`/semáforo. Path de tokens ya venía correcto (largo) al agregarlo. |
| 22 | reportes-ventas | frontend/admin/css/reportes-ventas-gentelella.css | ✅ OK | Misma base `reportes.css` que reportes-financieros, mismo set exacto de clases (`.kpis-grid`/`.kpi-card`/`.chart-section`/`.ranking-section`) salvo que esta pantalla no usa `.status-badge` (confirmado en `reportes-ventas.js`: los rankings de vendedores/clientes/productos/zonas solo generan `<td>` planos, sin chips de estado) — se omitió ese bloque en el CSS en vez de dejarlo de relleno. Sin regresión de hex, único hardcode `#fff`. Botones `.btn.btn--primary`/`.btn.btn--ghost` igual que reportes-financieros. |
| 23 | reportes-stock | frontend/admin/css/reportes-stock-gentelella.css | ✅ OK | Misma base `reportes.css`. Dos particularidades propias de esta pantalla: (1) `.status-badge` sí usa la variante `orange` (estado "Exceso" de stock, `s.cantidad > 100`), además de `red/yellow/green` — es la primera pantalla de reportes que usa las 4; (2) el bloque de paginación de la tabla de stock (`#stockPaginacionInfo`, `#selectStockPorPagina`, label) trae estilos inline hardcodeados en el HTML (`color:#6b7280`, `border:1px solid #e2e8f0`, etc.) — se sobreescribieron por id con `!important` (que sí gana sobre inline sin `!important`) en vez de tocar el HTML. Sin regresión de los 6 hex en vigilancia, único hardcode `#fff`. |
| 24 | rentabilidad-producto-vendedor | frontend/admin/css/rentabilidad-producto-vendedor-gentelella.css | ✅ OK | CSS base es `reportes.css` + `<style>` inline propio (mismo patrón que reglas-precio/comparador-precios). Usa el patrón `.small-box` para las KPI cards (generadas por JS), igual que `reglas-precio`, pero acá aparecen por primera vez las variantes `bg-warning`/`bg-danger` (mapeadas a `--ge-orange`/`--ge-red`) además de `bg-primary/success/secondary/info`. Pantalla nueva con `.view-toggle` (tabs "Por producto"/"Por vendedor"), `.paginacion`/`.paginacion-btn`/`.paginacion-ellipsis` (paginador numerado, distinto del paginador simple con inline styles de `reportes-stock`), `.fila-mejor`/`.fila-peor` (resaltado de la mejor/peor fila por margen), `.monto-rojo`/`.monto-verde`/`.monto-gris` y `.chip-origen-pedido`/`.chip-origen-pos`. Todos reusan tokens existentes (`--ge-teal`, `--ge-red`, `--ge-blue`, `--ge-purple`, `--ge-muted`) sin necesidad de agregar ninguno nuevo. Sin regresión de los 6 hex en vigilancia, único hardcode `#fff`. |
| 25 | rentabilidad-zona | frontend/admin/css/rentabilidad-zona-gentelella.css | ✅ OK | Hermana directa de `rentabilidad-producto-vendedor` — mismo `<style>` inline base, mismo `.small-box` (bg-primary/success/secondary/info/warning/danger), mismo `.view-toggle` ("Por zona"/"Por ruta") y `.monto-rojo/verde/gris`. Particularidades propias: `.costo-km-card` (bloque de configuración del costo logístico por km, con `#input-costo-km` y `.texto-chico` para el estado del guardado), `.badge-aviso` ("Sin configurar" cuando falta el costo/km — reusa `--ge-chip-bg`/`--ge-warning-text`, mismo patrón que otros avisos ámbar de la cola), y `.zona-mejor`/`.zona-peor` (equivalente a fila-mejor/fila-peor). No tiene paginación ni chips de origen (no aplica). Sin regresión de los 6 hex en vigilancia, único hardcode `#fff`. |
| 26 | auditoria | frontend/admin/css/auditoria-gentelella.css | ✅ OK | Primera pantalla de esta tanda con base `finanzas.css` (compartida con `cobranzas`/`cheques`, ya reskinadas antes) — se reusaron los patrones ya establecidos de `.tabla-wrap`/`.col-sticky-end`/`.btn--secondary`/modal de `cobranzas-gentelella.css` en vez de reinventarlos. Particularidades propias: `.tabla-footer` (botón "Cargar más" centrado) y el modal de detalle de cambio con `.diff-grid`/`.diff-col`/`.diff-field-changed` (comparación antes/después en dos columnas con `<pre>`, resaltado ámbar del campo modificado). Sin ningún hardcode de color en el CSS nuevo (ni siquiera `#fff` — todo vía tokens/rgba sobre tokens). |
| 27 | anomalias | frontend/admin/css/anomalias-gentelella.css | ✅ OK | Base `finanzas.css` + `<style>` inline propio con toda su UI (toolbar, pills de resumen, cards de anomalía, badges de severidad, modal de detalle JSON) — ninguna clase compartida con otras pantallas de la cola. Cubre `.pill-alta/media/ok/total`, `.anomalia-card`/`.badge-alta/media`, `.anomalia-meta-item`, `.anomalia-detalle-*` (toggle/json/fila/evento), `.btn-revisar`/`.ya-revisada`, estado vacío y skeleton de carga. `.pill-ok` está definido en el CSS aunque `anomalias.js` no lo genera actualmente (ningún camino de código arma ese pill) — se dejó igual tokenizado por si se usa a futuro, sin agregar tokens nuevos. Sin regresión de los 6 hex en vigilancia, único hardcode `#fff`. |
| 28 | usuarios | frontend/admin/css/usuarios-gentelella.css | ✅ OK | Base `compras.css` (compartida con Proveedores/Cta.Cte.Proveedores/Órdenes de compra, ya reskinadas) — se reusaron los patrones ya establecidos de `.tabla-wrap`/`.tabla-main`/`.col-sticky-end`/`.modal-box*`/`.form-*`/`.btn-cancelar`/`.search-wrap` de `compras-gentelella.css`/`proveedores-gentelella.css`. Hallazgo: `.badge-estado`/`.badge-ok` (Activo/Inactivo) y `.btn-fila-accion` (Editar/Desactivar/Reactivar), generados por `usuarios.js`, no tienen ninguna definición base en `compras.css` ni en ningún CSS cargado por esta pantalla — sin reskin renderizaban como texto plano sin pastilla/botón. Se les dio forma de pastilla/botón mínima (mismo patrón `.badge-estado`/`.badge-dot` de `clientes-gentelella.css`) para que se vean intencionales, sin inventar un componente nuevo de cero. Sin regresión de los 6 hex en vigilancia, único hardcode `#fff`. |

## Cola cerrada (2026-07-26) — las 12 pantallas restantes

Las 11 pantallas con CSS propio ya venían con su archivo
`*-gentelella.css` creado y enlazado (fecha de disco 2026-07-25, sesión
previa no reflejada todavía en este doc). Se auditaron las 11 contra el
proceso estándar (regresión de los hex en vigilancia, `:root` duplicado,
path de tokens) y se encontraron y corrigieron 2 regresiones nuevas:

| # | Pantalla | Archivo CSS | Estado | Notas |
|---|----------|-------------|--------|-------|
| 29 | empresa-config | `frontend/admin/css/empresa-config-gentelella.css` | ✅ OK | Sin regresión de ningún hex en vigilancia, sin `:root` duplicado, sin `#fff` hardcodeado (único caso de la tanda). Path de tokens correcto (largo) desde el origen. |
| 30 | facturacion-config | `frontend/admin/css/facturacion-config-gentelella.css` | ✅ OK | Sin regresión, único hardcode `#fff` (x2). |
| 31 | mercadopago-config | `frontend/admin/css/mercadopago-config-gentelella.css` | ✅ OK | Sin regresión, único hardcode `#fff` (x1). |
| 32 | automatizacion | `frontend/admin/css/automatizacion-gentelella.css` | ✅ OK | Sin regresión, único hardcode `#fff` (x2). |
| 33 | migracion | `frontend/admin/css/migracion-gentelella.css` | ✅ OK, con 1 fix aplicado | Traía **5 usos** de un fondo de advertencia hardcodeado (4x `#fff7e6`, 1x `#fff7ed`, esta última una variante casi idéntica) siempre acompañado de `border-color: var(--ge-orange)` y `color: var(--ge-warning-text)` — mismo patrón de "componente de advertencia" ya tokenizado para el texto, pero nunca para el fondo. Ver token nuevo `--ge-warning-bg` más abajo. |
| 34 | vencimientos | `frontend/admin/css/vencimientos-gentelella.css` | ✅ OK, con 1 fix aplicado | 2 usos de `#fff7e6` → `var(--ge-warning-bg)`. Único hardcode `#fff` (x2). |
| 35 | notif-log | `frontend/admin/css/notif-log-gentelella.css` | ✅ OK | Sin regresión, sin `#fff` hardcodeado. |
| 36 | saas-billing | `frontend/admin/css/saas-billing-gentelella.css` | ✅ OK, con 1 fix aplicado | 1 uso de `#fff7e6` → `var(--ge-warning-bg)`. |
| 37 | soporte | `frontend/admin/css/soporte-gentelella.css` | ✅ OK, con 2 fixes aplicados | (1) `#25D366` (verde WhatsApp) hardcodeado en `.canal-wa`/`.btn-canal` pese a que `--ge-whatsapp` ya existe desde `clientes` — corregido a `var(--ge-whatsapp)`. (2) 1 uso de `#fff7e6` → `var(--ge-warning-bg)`. **No** se tokenizaron `#1ebe57`/`#2b7fc4` (hover oscurecido de los botones de canal WhatsApp/mail) — son variantes de un solo uso cada una, no un patrón repetido, consistente con el criterio de "2+ apariciones = tokenizar" del resto del doc. |
| 38 | whatsapp-conversaciones | `frontend/admin/css/whatsapp-conversaciones-gentelella.css` | ✅ OK, con 1 fix aplicado | Esta sí traía `--ge-whatsapp` bien usado desde el origen (sin regresión de verde). 2 usos de `#fff7e6` → `var(--ge-warning-bg)`. |
| 39 | whatsapp-onboarding | `frontend/admin/css/whatsapp-onboarding-gentelella.css` | ✅ OK, con 2 fixes aplicados | Mismos 2 fixes que `soporte`: `#25D366` → `var(--ge-whatsapp)` (ícono `.wa-icono`) y 1 uso de `#fff7e6` → `var(--ge-warning-bg)`. |
| — | superadmin | *(sin CSS propio — stub de retiro)* | ✅ OK, con 1 fix aplicado | Distinto de los demás stubs (`lotes`/`cta-cte`/`presupuestos`/`liquidacion`, que son redirects sin body visual): `superadmin.html` ahora es un panel **retirado** (fecha de disco 2026-07-26, posterior al resto de la tanda) con una card real de "este panel fue retirado → ir a facturación SaaS". Bug encontrado: la card usa `var(--color-bg)`, `var(--radius-xxl)`, `var(--radius-lg)` pero el archivo no cargaba `/shared/tokens.css` en ningún lado — esas variables quedaban indefinidas, así que la card y el botón renderizaban con esquinas cuadradas (radius 0) en vez de los redondeos de 16px/10px que tiene el resto de la app. Se agregó el `<link>` faltante. |

### Token nuevo: `--ge-warning-bg`

Mismo patrón que la consolidación de `--ge-warning-text` (pedidos/pos,
2026-07-14): un fondo de advertencia apareció hardcodeado **12 veces en
6 pantallas** de esta tanda (migracion, vencimientos, saas-billing,
soporte, whatsapp-conversaciones, whatsapp-onboarding), siempre en el
mismo trío `background + border-color: var(--ge-orange) + color:
var(--ge-warning-text)`. 11 usos en `#fff7e6`, 1 uso (migracion) en la
variante casi idéntica `#fff7ed`. Se agregó a `gentelella-tokens.css`:

```css
--ge-warning-bg: #fff7e6;
```

Y se reemplazaron las 12 ocurrencias por `var(--ge-warning-bg)` en los
6 archivos. Verificado con grep que no quedó ningún hex viejo suelto
(fuera de 2 comentarios que documentan el fix, en `soporte` y
`whatsapp-onboarding`, que mencionan el hex anterior en prosa a propósito).

### Regresión de `--ge-whatsapp` (2da y 3ra vez)

`#25D366` hardcodeado reapareció en `soporte-gentelella.css` y
`whatsapp-onboarding-gentelella.css`, pese a que el token ya existía desde
`clientes` (2026-07-14) y `whatsapp-conversaciones` lo usaba bien. Mismo
patrón de fondo ya visto con `--ge-warning-text`: cada archivo nuevo se
generó sin visibilidad de que el token ya existía. Corregido en ambos.

## Estado general: 55/55 pantallas de admin cubiertas

Con esta tanda se cierran las 55 pantallas de `frontend/admin/`:
- 39 con reskin Gentelella propio (tabla completa arriba).
- 8 stubs de redirect sin body visual, confirmados "sin trabajo propio"
  (`lotes`, `cta-cte`, `presupuestos`, `liquidacion`, y sus equivalentes).
- 5 excluidas por diseño (`login`, `setup`, `setup-wizard`, `sin-permiso`,
  `suspendida` — pantallas de auth/estado del sistema, fuera del alcance
  del reskin visual).
- 1 caso especial (`superadmin`): panel retirado con bug de tokens
  corregido en esta tanda (no es parte del conteo de reskin ni de stub,
  es un caso propio).

**Importante — esto NO cierra la auditoría de madurez visual completa
del proyecto.** El admin es 1 de 4 portales. `chofer` (4 pantallas) y las
4 páginas públicas (`index`, `registro`, `privacidad`, `terminos`) siguen
sin ningún sistema de reskin — ni Gentelella ni el overlay
Corporativo/shadcn que sí tienen `cliente` y `proveedor`. Ver mensaje de
auditoría del 2026-07-26 para el detalle de esa brecha.

## Historial de deuda de tokens (resuelta)

**Detectada:** en `pedidos-gentelella.css` (2026-07-14) — 2 valores
repetidos sin tokenizar (`#f0f3f4` para fondo de chips neutros,
`#a06800`/`#7a5000` para texto de advertencia sobre naranja). Se decidió
avanzar con `pos` igual y resolver todo junto una vez que se viera si
el patrón se repetía.

**Confirmada y ampliada:** al llegar `pos-gentelella.css`, apareció una
**3ra variante** del mismo "texto de advertencia" (`#7d4000`), además de
reutilizar `#a06800`. Con eso se decidió frenar la cola y resolver antes
de sumar una 4ta pantalla.

**Resuelto (2026-07-14):** se agregaron 2 tokens nuevos a
`gentelella-tokens.css`:
```css
--ge-chip-bg:       #f0f3f4;
--ge-warning-text:  #a06800;  /* consolidación de #a06800 / #7a5000 / #7d4000 */
```
Y se reemplazaron todas las ocurrencias hardcodeadas por `var(--ge-chip-bg)`
y `var(--ge-warning-text)` en `pedidos-gentelella.css` y
`pos-gentelella.css`. Se verificó con grep que no quedó ningún hex viejo
suelto (fuera de los comentarios que documentan el cambio).

**Nota de consecuencia visual:** los 2 puntos que antes usaban `#7a5000`
o `#7d4000` (uno en `pedidos`, dos en `pos`) ahora se ven con el tono
`#a06800` — una diferencia mínima de matiz en texto de advertencia, no
perceptible salvo comparación directa lado a lado. Si al revisar visualmente
alguno de esos puntos específicos se ve mal, avisar para ajustar el valor
canónico del token (hoy es el más repetido, no necesariamente el más lindo).

`#fff` hardcodeado (texto blanco sobre botones/pills de color sólido) se
dejó como está en ambas pantallas — es un valor universal, no amerita
token propio.

## Regresión detectada en clientes (2026-07-14) — IMPORTANTE, leer antes de seguir

Al llegar `clientes-gentelella.css`, `#7d4000` volvió a aparecer 3 veces
(`.e-pill-amarillo.activa`, `.badge-bajo`, `.score-premium`) pese a que
`--ge-warning-text` ya existía desde la resolución de `pedidos`/`pos`.

**Causa probable:** se le dio a Replit una copia del proyecto anterior a
la consolidación de tokens, en vez del zip actualizado. **De acá en
adelante, subir siempre el zip más reciente entregado antes de pedir la
próxima pantalla** — si no, el agente no tiene forma de saber que el
token ya existe y reinventa el valor.

**Corregido:** los 3 usos de `#7d4000` en `clientes-gentelella.css` se
reemplazaron por `var(--ge-warning-text)`.

**De paso, se tokenizó también** el verde de marca de WhatsApp
(`--ge-whatsapp: #25D366`), detectado 2 veces en `.btn-wa-pedido` de esta
misma pantalla — no es parte de la paleta Gentelella (es color de marca),
pero se anticipa que reaparezca en `whatsapp-conversaciones` y
`whatsapp-onboarding`, más adelante en la cola.

## En vigilancia → confirmado y resuelto

`#1a5f8b` — texto oscuro sobre azul. Apareció en `clientes` (`.score-normal`)
y se repitió idéntico en `productos` (`.prod-badge.borrador`). Con 2
apariciones se consideró patrón confirmado y se tokenizó de una:

```css
--ge-info-text: #1a5f8b;
```

Reemplazado en ambos archivos (`clientes-gentelella.css` retroactivamente
y `productos-gentelella.css`).

## Segunda regresión: stock (2026-07-14)

Volvió a pasar lo de `clientes`: `#7d4000` reapareció en `stock-gentelella.css`,
esta vez 5 veces (KPI de advertencia, badges de stock crítico/bajo, pill
amarilla). Corregido a `var(--ge-warning-text)`.

**Van 2 de 6 pantallas con esta regresión (clientes y stock).** Si vuelve
a pasar en la próxima, vale la pena revisar el proceso de cómo se le pasa
el proyecto a Replit entre pantallas — 2 recurrencias ya no es casualidad.

**Caso distinto, no es regresión:** `#fdb072` / `#6fe3b4` en los
mini-badges de la card oscura lateral (`.stock-ov-target`) — son tintes
claros que YA existían en `stock-overview.css` original, pensados para
contraste sobre fondo oscuro. No se tokenizan como `--ge-warning-text` /
`--ge-teal` normales porque esos se verían invisibles ahí. Si en el
futuro aparece otro caso de "badge sobre card oscura" en otra pantalla,
ahí sí conviene evaluar tokens tipo `--ge-warning-text-ondark`.

## Devoluciones (2026-07-14) — sin regresión, un detalle de ruta

Primera pantalla desde el aviso de la 2da regresión que sale limpia:
ninguno de los 4 tokens consolidados fue reinventado.

Detalle menor: el `<link>` a `gentelella-tokens.css` usaba
`/shared/gentelella-tokens.css` en vez de
`/frontend/shared/gentelella-tokens.css` como el resto de pantallas.
Funciona igual (hay un rewrite en `vercel.json`: `/shared/*.css` →
`/frontend/shared/*.css`), pero se normalizó al path largo por
consistencia con las demás.

**Nuevo valor en vigilancia (1ra aparición, no tokenizar todavía):**
`#c0392b` — hover oscurecido de `.btn-danger` (mismo patrón que
`--ge-teal-dark` pero para rojo). Si reaparece en otra pantalla con
botones de peligro, sumar `--ge-red-dark`.

**2da aparición (cobranzas, 2026-07-14):** reapareció exactamente como
se anticipó, en `.btn.btn--danger:hover` de `cobranzas-gentelella.css`
(esta vez ya con fallback: `var(--ge-red-dark, #c0392b)`). Con el
umbral de 2 apariciones que se usó para consolidar los otros tokens,
correspondía tokenizar — se le preguntó al usuario y **decidió
explícitamente dejarlo como está por ahora** (funciona igual gracias al
fallback). Sigue sin existir `--ge-red-dark` en `gentelella-tokens.css`.
Si aparece una 3ra vez, replantear.

## Empresa-config (2026-07-14) — sin regresión

Primer ítem de la nueva cola (`empresa-config facturacion-config
mercadopago-config automatizacion migracion vencimientos notif-log
saas-billing superadmin soporte whatsapp-conversaciones
whatsapp-onboarding`). La pantalla no tenía todavía ni el link a
`gentelella-tokens.css` ni CSS de reskin propio.

Archivos creados/modificados:
- `frontend/admin/css/empresa-config-gentelella.css` (nuevo) — su CSS base
  vive en `frontend/admin/css/`, así que el archivo de reskin se ubicó ahí
  también, siguiendo la convención de pantallas como `devoluciones` y
  `clientes`.
- `frontend/admin/empresa-config.html` — se agregó el `<link>` a
  `/frontend/shared/gentelella-tokens.css` (path largo) y al nuevo CSS,
  después del resto del CSS de la pantalla; se agregó la clase
  `dash-empresa-config-gentelella` al `<body>` sin sacar la que ya tenía
  (no tenía ninguna).

Ningún token de los 4 en vigilancia (`--ge-chip-bg`, `--ge-warning-text`,
`--ge-whatsapp`, `--ge-info-text`) fue reinventado con un valor
hardcodeado distinto — de hecho ninguno de los 4 aparece en esta
pantalla. No se tocó ningún id/clase que lea JS (esta pantalla no tiene
`empresa-config.js`, todo su script es inline en el HTML) ni se cambió
HTML estructural.

## Facturación-config (2026-07-14) — sin regresión

Segundo ítem de la cola. Igual que `empresa-config`, no tenía todavía
ni el link a `gentelella-tokens.css` ni CSS de reskin propio.

Archivos creados/modificados:
- `frontend/admin/css/facturacion-config-gentelella.css` (nuevo) — CSS
  base de la pantalla vive en `frontend/admin/css/`.
- `frontend/admin/facturacion-config.html` — se agregó el `<link>` a
  `/frontend/shared/gentelella-tokens.css` (path largo) y al nuevo CSS,
  después del resto del CSS de la pantalla; se agregó la clase
  `dash-facturacion-config-gentelella` al `<body>` (no tenía ninguna).

Patrones reusados de pantallas ya cerradas (no inventados): chips
`chip-ok`/`chip-no` con el mismo esquema que `export-contable`
(`--ge-teal-light`/`--ge-teal-dark` y `rgba(240,173,78,.15)` +
`--ge-orange`), `chip-homo` con `--ge-info-text` sobre
`rgba(52,152,219,.12)` (mismo patrón que `.score-normal` en
`clientes`/`riesgo-cheques`), y las 3 variantes de `.alerta`
(ok/err/inf) con el mismo esquema rgba+border que `export-contable`.
Ningún token de los 4 en vigilancia fue reinventado con un valor
distinto. No se tocó ningún id/clase leída por JS (todo el script de
esta pantalla es inline) ni HTML estructural.

## Mercadopago-config (2026-07-14) — sin regresión

Tercer ítem de la cola. Misma situación que las dos anteriores: sin
link a `gentelella-tokens.css` ni CSS de reskin propio.

Archivos creados/modificados:
- `frontend/admin/css/mercadopago-config-gentelella.css` (nuevo).
- `frontend/admin/mercadopago-config.html` — link a
  `/frontend/shared/gentelella-tokens.css` (path largo) y al nuevo CSS;
  clase `dash-mercadopago-config-gentelella` en el `<body>` (no tenía
  ninguna).

Mismos patrones reusados que en `facturacion-config` (chips ok/no,
alertas ok/err/inf, pasos numerados, inputs/focus con `--ge-teal`).
`.btn-danger` (desconectar cuenta) se resolvió con `--ge-red` +
`rgba(231,76,60,.08)` en hover, igual criterio que las alertas de
error. Ningún token de los 4 en vigilancia reinventado. No se tocó
ningún id/clase leída por JS (script inline) ni HTML estructural.

## Automatizacion (2026-07-14) — sin regresión

Cuarto ítem de la cola. Pantalla más compleja hasta ahora: gran parte
del contenido (tarjetas de motor, KPIs, badges, listas) se genera
dinámicamente desde `frontend/admin/js/automatizacion.js`, no está en
el HTML — se leyó el JS completo para relevar cada clase real antes de
escribir el CSS.

Archivos creados/modificados:
- `frontend/admin/css/automatizacion-gentelella.css` (nuevo).
- `frontend/admin/automatizacion.html` — link a
  `/frontend/shared/gentelella-tokens.css` (path largo) y al nuevo CSS;
  clase `dash-automatizacion-gentelella` en el `<body>` (no tenía
  ninguna).

Patrones reusados: `motor-status`/`ms-*` y `kpi-*` con el mismo
esquema ok=teal/warn=orange/error=red/info=blue/idle=muted ya usado en
otras pantallas; `score-pill` (`score-premium/bueno/normal/riesgo/
bloqueado`) copiado 1:1 de `clientes-gentelella.css` para no divergir
entre pantallas. Los 5 acentos de ícono por motor (piloto/cierre/
rutas/stock/score) se mapearon a los 5 tonos de marca ya existentes
(orange/teal/blue/purple/red) — no había un 6to tono disponible para
"score" así que se reusó red en baja opacidad solo como acento
decorativo del ícono (no es un estado de error). No se inventó ningún
token nuevo. No se tocaron clases ni ids leídos por JS, ni los
estilos inline seteados directamente desde JS (badges de severidad en
auditoría, colores del toast) — quedan fuera de alcance del reskin CSS
por decisión metodológica, no por descuido.

## Bug transversal: sidebar sin reskin fuera del dashboard (2026-07-14) — CORREGIDO

**Hallazgo:** todas las pantallas reskineadas (incluida `comparador-precios`,
marcada arriba como "✅ OK") mostraban el sidebar "de fábrica" (blanco, sin
tokens Gentelella), pese a que sus propios CSS de reskin no tenían ningún
problema. Causa raíz: las reglas de `.nav-rail`/`.nav-panel`/
`.nav-section-link`/etc. vivían **únicamente** en
`dashboard-gentelella.css`, escritas bajo el selector
`body.dash-gentelella`. Esa clase solo la tenía el `<body>` de
`dashboard.html` (`class="dash-fireart dash-gentelella"`); el resto de las
pantallas usa `body.dash-<pantalla>-gentelella` (una clase distinta y más
específica), así que el selector nunca matcheaba fuera del dashboard. Se
verificaron los 38 archivos `*-gentelella.css` del proyecto: ninguno de los
otros 37 tenía una sola regla para el sidebar.

Este hallazgo invalida el "✅ OK" de `comparador-precios` y, en rigor, el de
**todas** las pantallas de la tabla de arriba en lo que respecta al sidebar
(no a su propio CSS de contenido, que sí está bien). No es un problema
pantalla por pantalla, es un bug de alcance transversal.

**Fix aplicado (opción 1, la más simple y menos riesgosa):**
1. Se extrajeron las reglas de sidebar (bloque "Reset + SIDEBAR",
   `.nav-rail`/`.nav-rail-logo`/`.nav-ws-btn`/`.nav-panel`/
   `.nav-panel-title`/`.nav-section-label`/`.nav-section-link`/
   `.nav-badge--*`/`.nav-rail-salir`) de `dashboard-gentelella.css` a un
   archivo nuevo compartido: `frontend/shared/gentelella-nav.css`.
2. Se agregó la clase `dash-gentelella` al `<body>` de las 39 pantallas
   restantes (además de su clase específica, sin quitarla), para que
   hereden el selector.
3. Se linkeó `gentelella-nav.css` en esas mismas 39 pantallas, siempre
   inmediatamente después de `gentelella-tokens.css` (fuente de los
   tokens `--ge-*`) y antes del CSS propio de cada pantalla.
4. `dashboard.html` / `dashboard-gentelella.css` **no se tocaron** — ya
   funcionaban correctamente y siguen sirviendo como referencia; queda
   una duplicación menor (mismas reglas en dos archivos) aceptada a
   propósito para minimizar el riesgo del fix, no se refactorizó
   `dashboard-gentelella.css` para consumir el archivo compartido.

Verificado sobre las 41 pantallas (40 + dashboard): las 41 tienen
`dash-gentelella` en el `<body>`, y las 40 no-dashboard cargan
`gentelella-nav.css`. No se tocó ningún id/clase leído por JS.

## Enriquecimiento visual de .fkpi (2026-07-14) — a pedido del usuario

**Contexto:** al revisar `riesgo-cheques` en producción, el usuario notó
que el contenido principal se sentía "no en sintonía" con el sidebar
(que ya tiene mucho carácter visual: navy oscuro, acento teal, hover).
Diagnóstico: no era un bug de tokens/colores (esos ya aplicaban bien),
sino una diferencia estructural entre dos componentes de KPI distintos:
`.kpi-card` del dashboard (ícono circular de color, sparkline, hover con
elevación) vs. `.fkpi` (label + valor + subtexto plano, sin ícono),
compartido por `cheques`, `cobranzas` (x2 vistas), `devoluciones`,
`riesgo-cheques` y `vencimientos` — 22 tarjetas estáticas en total, más
el grid dinámico de "medios de pago" que genera `cobranzas.js`.

**Se acordó con el usuario elevar `.fkpi` al nivel visual de `.kpi-card`:**
ícono circular de color + hover con elevación, en las 5 pantallas +
el grid dinámico.

**Implementación:**
1. Archivo nuevo `frontend/shared/gentelella-fkpi.css` (mismo patrón que
   `gentelella-nav.css`: componente compartido, scope `body.dash-gentelella`,
   se linkea después de `gentelella-nav.css` y antes del CSS propio de
   cada pantalla). Convierte `.fkpi` a CSS Grid (ícono a la izquierda
   ocupando las 3 filas, label/valor/subtexto a la derecha) — sin
   envolver `fkpi-label`/`fkpi-val`/`fkpi-sub` en un contenedor nuevo,
   solo se ubican por `grid-column`/`grid-row`. Agrega hover con
   `translateY(-1px)` + `--ge-shadow-lg`, igual que `.kpi-card:hover`
   del dashboard. Incluye una variante `.fkpi--compacto` (ícono arriba
   centrado) para el grid de medios de pago.
2. Se agregó un `<span class="fkpi-icono {rojo|amarillo|azul|verde}">`
   con un `<svg>` inline como primer hijo de cada una de las 22
   tarjetas `.fkpi` estáticas (en `cheques.html`, `cobranzas.html` x2,
   `devoluciones.html`, `riesgo-cheques.html`, `vencimientos.html`). La
   clase de color reusa exactamente la misma palabra que ya traía
   `fkpi-val` (no se inventó convención nueva) — así el color del
   ícono nunca puede quedar desincronizado del valor. El ícono en sí se
   eligió por semántica del label (ej. reloj para "vencen en X días",
   alerta-triángulo para montos vencidos/en riesgo, check para
   aprobado/cobrado, equis para rechazado, candado para "bloqueado",
   campana para alertas, etiqueta/porcentaje para ofertas y descuentos).
   Set de 9 íconos reutilizados entre las 22 tarjetas (mismo criterio
   de reuso que los íconos del dashboard).
3. `cobranzas.js` (función que arma `#medios-pago-grid`): se cambió el
   template de esa card para usar `class="fkpi fkpi--compacto"` +
   `<span class="fkpi-icono verde">` reusando los mismos íconos por
   medio de pago que ya existían en el objeto `iconos` del propio JS —
   no se tocó la lógica de cálculo de totales, solo el HTML generado.
4. Se linkeó `gentelella-fkpi.css` en las 5 pantallas, siempre
   inmediatamente después de `gentelella-nav.css`.

**Verificado:** ningún id leído por JS fue tocado (`kpi-cartera`,
`kpi-clientes-riesgo`, etc. siguen intactos); se confirmó con grep que
ninguno de los 5 CSS de reskin por pantalla pisa `display`/`grid-*` de
`.fkpi` (solo tocan `background`/`border`/`box-shadow`/`padding`, sin
conflicto de cascada); `notif-log` no tiene `.fkpi` en su HTML (la
regla en `notif-log-gentelella.css` ya estaba inerte antes de este
cambio, no se tocó).

## Próximo paso

Sigue pendiente `migracion` (ítem 5 de la cola actual).
Cola completa restante: `migracion vencimientos notif-log
saas-billing superadmin soporte whatsapp-conversaciones
whatsapp-onboarding`. Al llegar el turno de `vencimientos`, de paso
queda cerrado el trabajo visual que cubre a `lotes` y `liquidacion`
(son stubs de redirect a `vencimientos`). Tokens disponibles para
reusar: `--ge-chip-bg`, `--ge-warning-text`, `--ge-whatsapp`,
`--ge-info-text`. `--ge-red-dark` sigue sin existir pese a 2
apariciones de `#c0392b` — decisión explícita del usuario de no
tokenizar todavía. Recordar: el usuario pidió que SIEMPRE se le
entregue primero el zip actualizado del proyecto, y recién después se
continúe con la siguiente pantalla — no saltear ese paso.

## Chofer (2026-07-26) — incorporado al overlay Corporativo/shadcn

Las 4 pantallas de `frontend/chofer/` (`index`, `invitacion`, `login`,
`remito`) solo cargaban `/shared/tokens.css` — nunca recibieron ni el
reskin Gentelella (no correspondía, es un portal externo para choferes,
no admin) ni el overlay `/shared/reskin-patch.css` +
`/shared/reskin-patch-v2-shadcn.css` que sí tienen `cliente` y
`proveedor` desde antes.

Se relevaron las clases usadas en las 4 pantallas contra el set que el
overlay targetea (`.btn`, `.btn-primary/success/danger/outline`, `.card`,
`.modal`, `.chip`, `.form-group`, `.empty-state`, `.topbar`) — hay buena
superposición, especialmente en `remito.html` (los botones críticos del
flujo — confirmar entrega, no entrega, despachar, registrar devolución —
usan `btn btn-primary/success/danger/outline`) y en `login.html`/
`invitacion.html` (`btn btn-primary`, `form-group`). Clases bespoke sin
la base `.btn`/`.card` (`.btn-refrescar`, `.btn-salir`, `.btn-foto`,
`.card-remito`, `.chip` de estado del pedido) no son alcanzadas por el
overlay — quedan como estaban, sin romperse ni mejorar.

Se agregaron los 2 `<link>` al final del `<head>` (mismo orden que
`proveedor`: después del `<style>` inline de la pantalla, antes de
`a11y-focus.css`, para que el overlay gane por orden de aparición).
Cero cambios de HTML/clases, igual que en la incorporación original a
`cliente`/`proveedor`.

**Verificado sin riesgo de regresión de UX:** no hay en chofer ningún
panel deliberadamente oscuro (como el de totales de `pos`) que el
overlay pudiera aclarar sin querer — los únicos colores fuertes
hardcodeados eran `.btn-primary`/`.btn-success` con los mismos valores
de marca que el resto de la app, ahora reemplazados por la anatomía
compartida (radius, focus ring, escala de tamaño).

Con esto: **chofer queda en el mismo nivel de madurez visual que
cliente y proveedor.**

## Páginas públicas (2026-07-26) — hallazgo: NO es una brecha, es un sistema propio deliberado

A diferencia de chofer, las 4 páginas públicas (`index`, `registro`,
`privacidad`, `terminos`) no cargan `tokens.css` en absoluto — cada una
define su propio `:root` inline. Se verificó que **las 4 comparten
exactamente los mismos tokens** (`--azul: #2563EB` — el mismo azul de
marca que el resto de la app —, `--bg: #F1EFE8`, `--surface: #ffffff`,
`--border: #D3D1C7`, `--text: #2C2C2A`, `--muted: #5F5E5A`,
`--radius: 10px`), más una tipografía de display propia (`Space
Grotesk`) en `index`. Es un micro-sistema de diseño "editorial/kraft"
consistente entre sí, no 4 páginas divergentes — parece una decisión de
identidad de marca para las páginas de cara al público/marketing/legal,
distinta a propósito de la estética de dashboard azul del admin/app.

**No se tocó nada acá** — mezclar el overlay de la app con este sistema
propio pisaría el `:root` deliberado de estas páginas y podría generar
justamente el tipo de inconsistencia que se está tratando de evitar.
Queda pendiente de decisión del usuario si esta separación de identidad
se mantiene (recomendado, ya que está bien ejecutada y es coherente) o
si prefiere unificarla con el resto del sistema.

## Páginas públicas (2026-07-26, actualización) — unificadas por decisión del usuario

Decisión: unificar en vez de mantener la identidad propia. Se hizo con
alias, no con reescritura de reglas — mismo patrón que usa
`reskin-patch-v2-shadcn.css` para sus "alias semánticos": cada archivo
mantiene los mismos nombres de variable que ya usaba en sus ~180 reglas
combinadas (`--azul`, `--bg`, `--surface`, `--border`, `--text`,
`--muted`, `--radius`, etc.) pero el `:root` local ahora las apunta a
`var(--color-primary)`, `var(--color-bg)`, etc. de `tokens.css` en vez
de hardcodear su propio valor. Cero reescritura de las reglas que ya
usaban esas variables — el cambio de paleta se propaga solo.

Se agregó `<link tokens.css>` antes del `<style>` inline (en `index.html`
después del preconnect/Google Fonts existente) y `reskin-patch.css` +
`reskin-patch-v2-shadcn.css` después del `</style>`, antes de
`a11y-focus.css` — mismo orden que el resto del proyecto.

**Cambios visuales resultantes de la unificación:**
- Fondo: pasa de beige `#F1EFE8` a gris-azulado claro `#F8FAFC` (el
  mismo que admin/cliente/proveedor/chofer).
- Hover de botones azules: pasa de navy oscuro `#0E4A87` a
  `#1D4ED8` (el hover real que usa el resto de la app).
- Borde/texto/muted: valores levemente distintos pero mismo rol
  semántico, ahora consistentes con el resto del sistema.
- `registro.html` además gana la anatomía del overlay en `.card`,
  `.btn-primary`, `.alert` (focus ring, radius, densidad) igual que
  `cliente`/`proveedor`/`chofer`.

**Lo que NO se tocó, a propósito:**
- `--ruta`/`--ruta-tint` (verde) y `--kraft`/`--kraft-tint` (marrón/tostado)
  en `index.html`: son acentos decorativos de contenido de las secciones
  "dolores"/"funcs" de la landing, sin rol de superficie/texto — no
  tienen equivalente en `tokens.css` y forzar uno sería inventar un
  color que no representa nada del sistema. Quedan como estaban.
- Tipografía `Space Grotesk` de `index.html`: no formaba parte del
  pedido de unificación de paleta/overlay. Si se quiere evaluar también
  la tipografía, es una decisión aparte.

Con esto: **las 4 páginas públicas quedan en el mismo sistema de colores
y overlay que el resto del proyecto — las 71 pantallas del proyecto
comparten ya una única fuente de verdad de paleta (`tokens.css` /
`gentelella-tokens.css`, ambos con el mismo azul `#2563EB` de base).**

## Nota (2026-08-19): unificación de componentes (tabla/badge/acciones) — estado final

Este doc trackea el reskin de **paleta/overlay** (colores, tokens). Aparte, y en paralelo,
corrió un segundo esfuerzo de unificación **estructural** — mismo componente HTML+CSS+JS de
tabla, badge de estado, fila de acciones, paginación y filtros en todas las páginas admin,
reemplazando las 14+ variantes de nombre de clase (`tabla`, `tabla-main`, `tabla-clientes`,
`prod-tabla`, `ranking-table`, etc.) por una sola (`.tabla-admin` + `.badge-estado` +
`.fila-acciones`, definidos una vez en `frontend/shared/componentes-admin.css`). Documentado
completo en `PLAN_UNIFICACION_UX_ADMIN.md` (raíz del proyecto), no en este archivo.

**Estado al cierre de Fase 5 de ese plan:** Fases 0–4 y los 7 hallazgos derivados, cerrados.
Las ~47 páginas admin en alcance usan el componente canónico, con las excepciones
documentadas a propósito (workspaces con tabla no-listado como `pos.html`/las 4 `.rutas-table`
de armado de rutas, `productos.html` como referencia original no migrada, `saas-billing.html`
con su propio sistema de botones `.btn-prim`/`.btn-sec`, `suspendida.html` con CTA full-width
propio). Queda pendiente, fuera de este cierre: `automatizacion.html` (migración pospuesta,
falta decidir criterio de tabla compartida con `productos.html`) y la unificación del sistema
paralelo de badges `.chip`/`.chip-verde`/etc. de `finanzas.css` (usado por `cheques`,
`cobranzas`, `auditoria`, `devoluciones`, `notas`, `vencimientos`, `riesgo-cheques` y otras —
decisión explícita de tratarlo como su propia fase futura, no tocado en esta pasada).
