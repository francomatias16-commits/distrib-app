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
| — | lotes | — (no tiene HTML/CSS propio) | ✅ OK, sin trabajo | `lotes.html` es solo un stub de redirect a `/admin/vencimientos` (sin body visual, sin `<link>` de CSS). Se confirmó con el usuario y se decidió: saltear por ahora, y resolver `vencimientos` en su turno normal de cola (ítem más adelante) en vez de adelantarlo — a diferencia de `cta-cte`/`presupuestos`, acá el destino del redirect (`vencimientos`) todavía NO tiene su propio reskin, así que esto no es "ya resuelto", es "pendiente bajo otro nombre" |
| — | cta-cte | — (no tiene HTML/CSS propio) | ✅ OK, sin trabajo | Confirmado: `cta-cte.html` es 100% un stub de redirect a `/admin/cobranzas?vista=saldos` (sin `<link>` de CSS, sin clases propias) — queda totalmente cubierto por `cobranzas-gentelella.css`, que ya declara explícitamente que cubre la vista "saldos" (`cta-cte.js`). Igual que pasó con `presupuestos`. |
| 17 | riesgo-cheques | frontend/admin/css/riesgo-cheques-gentelella.css | ✅ OK | Sin regresión de hex — no usa ninguno de los 4 tokens en vigilancia como color nuevo (si aparecían iban a reusarse, no reaparecieron). CSS base es `finanzas.css` + `clientes.css` (comparte `.score-badge`/`.score-premium`/etc. con la pantalla `clientes`, ya tokenizados ahí — se repitieron los mismos `--ge-*` acá, no valores nuevos). Revisé con cuidado el patrón de bug real de `cobranzas` (clase compuesta vs. dos clases separadas): acá `score-badge`/`score-premium` SÍ se generan como dos clases separadas (`class="score-badge ${cat.cls}"` en `riesgo-cheques.js`) y el CSS las trata como selectores independientes — no hay bug. Único hardcode nuevo es `#fff` (implícito vía `color:#fff` en avatar, ya existía antes del reskin, no se tocó). Agregado además `.alerta-inline.warning` (no existía override en ninguna pantalla previa, solo `.danger`) |
| 18 | conciliacion-bancaria | frontend/admin/css/conciliacion-bancaria-gentelella.css | ✅ OK | CSS base de esta pantalla es un `<style>` inline en el HTML (mismo patrón que `reglas-precio`/`comparador-precios`/`fidelizacion`) + `reportes.css` para `.kpi-card` genérico — el reskin sobreescribe todo bajo el scope sin tocar el inline. Revisé cada clase dinámica de `conciliacion-bancaria.js` contra el CSS: `badge-tipo ${m.tipo}`, `badge-estado ${m.estado}` y `score ${claseScore(...)}` se generan como pares de clases separadas por espacio (ej. `class="badge-tipo credito"`) y el CSS usa selectores compuestos de 2 clases (`.badge-tipo.credito`) — igual al patrón correcto de `clientes`/`riesgo-cheques`, no repite el bug de `cobranzas`. Sin regresión de hex, único hardcode es `#fff` (x1, texto sobre botón sólido) |
| 19 | cc-proveedores | frontend/admin/css/cc-proveedores-gentelella.css | ✅ OK | CSS base es `compras.css` (compartido con Compras/Proveedores, ya tenía un 3er scope `#vista-cc-proveedores` con acento turquesa) + `<style>` inline en el HTML para `.tab-btn`/`.kpi-card`/`.badge-pendiente`/`.badge-parcial`/`.badge-pagada`/`.badge-anulada`/`.badge-vencida`/`.cruce-table`/`.item-row`. Reskin sobreescribe ambos con `--ge-*` sin tocar HTML/JS. KPI "Saldo pendiente" trae `background`/`color` inline por atributo `style=""` (no clase) — se sobreescribió por id (`#kpi-saldo`/`#kv-saldo`) con `!important`, sin editar el atributo inline. El avatar circular de proveedor (`avatarProveedor()` en el JS) asigna su color de fondo por una paleta fija inline — se dejó intacto, solo se ajustó sombra/forma vía `.prov-avatar`. Colores de las tablas "Cruce OC↔Factura" (verde/amarillo/rojo de match) están hardcodeados inline en el JS (no como clases), por lo que quedan fuera del alcance de un reskin solo-CSS — igual que en pantallas previas con el mismo patrón. Sin regresión de hex, único hardcode es `#fff` (x1) |
| 20 | compras | frontend/admin/css/compras-gentelella.css | ✅ OK | Mismo `compras.css` base que `cc-proveedores` (scope `#vista-compras`, acento turquesa ya existente). Cubre badges de estado de OC (`badge-borrador/enviada/confirmada/recibida_parcial/recibida/cancelada`), tabla, botones de tabla, paginación, y los 4 modales (Nueva OC / Detalle / Recepción / Historial) con su `.form-input`/`.inner-tabla`/`.totales-box`/`.progreso-recepcion`/`.btn-cancelar`/`.btn-accion-modal`. Fuera de alcance (inline por `style=""`, no clases, igual criterio que en pantallas previas): los botones "Recepciones"/"Comparar proveedores" del topbar, toda la zona de escaneo OCR de remito (botones Cámara/Archivo, panel de diferencias, colores de alerta), y el badge "Descartada" + colores del historial de recepciones — todos generados con estilo inline directo en el JS. Sin regresión de hex, único hardcode es `#fff` (x4, texto sobre botones sólidos) |
| 21 | proveedores | frontend/admin/css/proveedores-gentelella.css | ✅ OK | Mismo `compras.css` base que `compras`/`cc-proveedores` (scope `#vista-proveedores`, acento turquesa ya existente). Cubre topbar/filtros/buscador, tabla principal, sección "Links de acceso activos" (segunda tabla del mismo tipo), badges Activo/Inactivo, botones de tabla (Editar/Compras/Portal/Dar de baja/Activar/Revocar), paginación, modal de alta/edición de proveedor (`.form-grid`/`.form-sec-label`/`.ayuda-contextual`) y modal del portal de autogestión (`.portal-cargando/-error/-link-box/-acciones`). Fuera de alcance (inline por `style=""`, no clases): el indicador "● Activo" y el color del botón "Revocar" en la tabla de links, generados en el JS. Sin regresión de hex, único hardcode es `#fff` (x2) |
| — | liquidacion | — (no tiene HTML/CSS propio) | ✅ OK, sin trabajo | `liquidacion.html` es 100% un stub de redirect a `/admin/vencimientos?vista=liquidacion` (sin `<link>` de CSS, sin body visual). Mismo caso que `lotes`: el destino (`vencimientos`) todavía no tiene su propio reskin, así que esto no es "ya resuelto", es "pendiente bajo otro nombre" — se resolverá cuando `vencimientos` llegue a su turno en la cola. |
| 22 | export-contable | frontend/admin/css/export-contable-gentelella.css | ✅ OK | CSS base es un `<style>` inline en el HTML (mismo patrón que `reglas-precio`/`comparador-precios`/`fidelizacion`/`conciliacion-bancaria`) + `reportes.css` para el layout general. Cubre las 2 tarjetas de sección (Configuración / Generar export), las cards seleccionables de proveedor contable (CSV genérico/Tango/Bejerman/Contabilium) con sus badges Listo/Próximamente, formularios (plan de cuentas + separador decimal/formato fecha), alertas ok/err/inf, y la tabla de historial de exportaciones. No hay clases dinámicas compuestas generadas por `export-contable.js` que revisar por el bug de `cobranzas` — `selected`/`disabled` se agregan como clases separadas, igual al patrón correcto. Sin regresión de hex, único hardcode es `#fff` (x1) |

## Cola restante (20 pantallas)

reportes-financieros,
liquidacion, export-contable, reportes-financieros, reportes-ventas,
reportes-stock, rentabilidad-producto-vendedor, rentabilidad-zona,
auditoria, anomalias, usuarios, empresa-config, facturacion-config,
mercadopago-config, automatizacion, migracion, vencimientos,
notif-log, saas-billing, superadmin, soporte,
whatsapp-conversaciones, whatsapp-onboarding

**Nota:** `vencimientos` (más adelante en esta cola) va a resolver también
el caso `lotes` (ver fila de la tabla arriba) — cuando le llegue el turno,
tratarlo como si cerrara ambos ítems a la vez.

(Excluidas del reskin por defecto: login, setup, setup-wizard,
sin-permiso, suspendida — pantallas de auth/estado del sistema.)

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

## Próximo paso

`lotes`, `cta-cte` y `liquidacion` quedaron resueltos sin trabajo
propio (ver tabla arriba) — los 3 son stubs de redirect;
`liquidacion`/`lotes` apuntan a `vencimientos`, que todavía no tiene
su propio reskin (queda "pendiente bajo otro nombre" para cuando le
llegue el turno en la cola). `riesgo-cheques`, `conciliacion-bancaria`,
`cc-proveedores`, `compras`, `proveedores` y `export-contable` ya están
integrados. Sigue `reportes-financieros`. Tokens disponibles para
reusar: `--ge-chip-bg`, `--ge-warning-text`, `--ge-whatsapp`,
`--ge-info-text`. `--ge-red-dark` sigue sin existir pese a 2
apariciones de `#c0392b` — decisión explícita del usuario de no
tokenizar todavía. Recordar siempre subir el zip más reciente del
proyecto a Replit antes de pedirle la siguiente pantalla.
