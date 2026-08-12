# Etapa 5 — Frontend (admin/cliente/chofer/proveedor)

Estado: 🟢 Completa (foco XSS) — 8 hallazgos de XSS corregidos, 0 abiertos. Responsividad: spot-check liviano, sin gaps detectados (no es un barrido exhaustivo página por página).

> **Nota de sincronización (sesión 7):** el ZIP `distrib_v295_auditoria_sesion6_etapa4_cerrada.zip` con el que arrancó esta sesión era un checkpoint *anterior* a esta etapa (su `05_frontend.md` interno decía "No iniciada"). Los 4 archivos con más cambios (`remito.js`, `shared/adminlte-widgets.js`, `admin/js/migracion.js`, `admin/saas-billing.html`) ya habían sido provistos actualizados y se copiaron tal cual al árbol del proyecto. Los otros 5 archivos mencionados en el hallazgo #4 (`admin/clientes.html`, `admin/proveedores.html`, `admin/js/clientes.js`, `admin/js/riesgo-cheques.js`, `admin/js/comparador-precios.js`) **todavía tenían el código vulnerable** en el ZIP — se reaplicaron los mismos fixes descritos abajo (helper `onclickArg`/`escOnclickArg` + `JSON.stringify`), verificados con `node --check` sobre los 6 archivos JS y los bloques `<script type="module">` de los 3 HTML, más el mismo test de 3 payloads de inyección (comillas dobles/simples, `<script>`) contra `verChequesDeCliente` y `cargarDetalle` — los 3 quedan neutralizados como texto plano. El proyecto ya queda consistente end-to-end con lo documentado abajo.


## Metodología
Barrido automatizado (script Python) sobre los 74 archivos JS del frontend (`admin/js`, `cliente`, `chofer`, `proveedor`, `shared`) buscando bloques `.innerHTML = \`...\`` con interpolaciones `${...}` que no pasan por ninguna función de escape conocida (`sanitize`/`s`/`esc`/`escapeHtml`/`escHtml`). Cada hit se revisó a mano contra el código real (no todo lo que marca el script es explotable — la mayoría son números, enums o HTML ya escapado por otro lado). Además, barrido manual de `onclick="...('${...}')"` con texto libre (no UUIDs) interpolado directamente en el atributo, que es una segunda clase de vulnerabilidad que el script de innerHTML no cubre.

## Hallazgos (todos corregidos en este ZIP)

### 1. XSS reflejado — nombre de hoja de Excel (`admin/js/migracion.js`)
El selector de hoja del importador de Excel (`parsearExcel`) insertaba `wb.SheetNames` (nombres de hoja del archivo subido) sin escapar en un `<option value="${nombre}">${nombre}</option>`. Como el wizard de migración está pensado para importar exports de sistemas viejos/terceros, el archivo no siempre es 100% confiable. **Fix:** `escapeHtml()` (ya existente en el mismo archivo) aplicado a ambos usos.

### 2. XSS almacenado — remito imprimible (`admin/js/remito.js`)
Tres campos de datos reales (no ejemplos) se insertaban sin `sanitize()`:
- `cliente.fantasia` (nombre de fantasía del cliente)
- `it.productos?.nombre` / `unidad` (nombre y unidad de cada producto en la tabla de ítems)
- `p.notas_cliente` (observaciones del pedido, texto libre)

Cualquiera de estos con un payload tipo `<img src=x onerror=...>` ejecuta en la sesión del admin/vendedor al abrir el remito para imprimir. **Fix:** `sanitize()` en los tres, más `white-space: pre-line` en `.notas-box` para no perder los saltos de línea que antes venían "gratis" al no escapar.

### 3. XSS almacenado — `ProfileCard` (`shared/adminlte-widgets.js`, usado por `clientes.html` y `proveedores.html`)
El widget compartido de tarjeta de perfil (usado en la ficha de cliente y de proveedor) insertaba `nombre`, `rol`, `stats[].value/label`, `lista[].value/label` sin escapar. Ambos callers le pasan directamente `razon_social`/`categoria`/`zona`/`vendedor`/`telefono`/`condicion_pago`, etc. — datos de negocio reales, no controlados. **Fix:** escape centralizado dentro de `ProfileCard.render()` (con un helper local, no dependía de que `ui-utils.js` ya esté cargado) — corrige ambos call sites de una sola vez.

### 4. Inyección vía atributo `onclick` (varios archivos) — la más seria de las 3
Patrón repetido: `onclick="funcion('${valor}')"` con `valor` = texto libre (nombre de cliente/proveedor/empresa, teléfono), en vez de un UUID propio. El problema es más profundo que XSS simple: **`sanitize()`/sus variantes locales (`esc`, `escHtml`) escapan `&`, `<`, `>` pero NO comillas simples ni dobles** (no hace falta escaparlas para insertar texto como contenido de un tag — sólo hace falta cuando ese texto termina dentro de un atributo o de un string de JS). Como consecuencia, un nombre de cliente/empresa con una comilla podía romper el atributo `onclick` o el string de JS y ejecutar código arbitrario en la sesión de quien mira esa ficha — en el caso de `saas-billing.html`, en la sesión del **superadmin del SaaS**, con el nombre de la empresa como vector (cualquier empresa se autoregistra y elige su propio nombre en `registro.js`).

Se encontraron y corrigieron 6 puntos con este patrón:
- `admin/saas-billing.html` — 4 botones (`confirmarPago`, `reactivarEmpresa`, `suspenderEmpresa`, `cambiarPrecio`) usaban un escape manual incompleto (`.replace(/'/g, "\\'")`) que no cubre comillas dobles.
- `admin/clientes.html` / `admin/proveedores.html` — acciones del `ProfileCard` (botón "WhatsApp"/"Ver pedidos"/"Ver compras") interpolaban `datos.telefono`/`datos.id` crudos.
- `admin/js/clientes.js` — `onclick="gestionarAccesoPortal('${c.id}', '${escHtml(nombre)}', ...)"`.
- `admin/js/riesgo-cheques.js` — `onclick="verChequesDeCliente('${...c.nombre...}')"`.
- `admin/js/comparador-precios.js` — `onclick="cargarDetalle('${...}', '${...producto_nombre...}')"`.

**Fix:** helper `onclickArg()`/`escOnclickArg()` (mismo criterio, definido donde hacía falta: exportado desde `shared/adminlte-widgets.js` y replicado como función local en los archivos que no importan ese módulo) que delega el escape del string de JS a `JSON.stringify` (cubre comillas y backslashes correctamente) y además escapa `"`, `&`, `<`, `>` para el atributo HTML que lo contiene. Verificado con un script de prueba en Node con 4 payloads (incluyendo el que rompía el string original) — los 4 quedan neutralizados como texto plano, sin ejecutar nada extra.

**Nota para el futuro:** no se auditaron los ~15 usos restantes de `onclick="...('${id}')"` en el resto del frontend porque en todos los que se revisaron el valor interpolado es un UUID propio de la base (no texto libre) — bajo riesgo. Si en algún momento se agrega un `onclick` nuevo con texto libre (nombre, teléfono, dirección, etc.), usar `onclickArg()`, no `sanitize()`/`esc()` solos.

## Revisado y sin hallazgos
- **Credenciales/config pública** (`env-config.js`): claves de Supabase (anon), Firebase y WhatsApp App ID/Config ID están hardcodeadas a propósito y documentado en comentarios — son identificadores públicos por diseño (Firebase/Supabase no dependen de ocultarlas), no secretos. El WhatsApp App Secret real vive solo como env var del backend, nunca en el frontend.
- **Almacenamiento de sesión**: no hay JWT/token en `localStorage` propio del proyecto (`grep` solo encontró `push_token` de notificaciones push, que no es sensible) — la sesión la maneja el cliente de Supabase con su mecanismo estándar.
- **CSP** (`vercel.json`): headers de seguridad ya configurados (`X-Frame-Options`, `HSTS`, `X-Content-Type-Options`, `Content-Security-Policy`) tanto para `/api/*` como para `/frontend/*.html`. Nota de diseño: `script-src` incluye `'unsafe-inline'` (necesario por los `onclick` inline usados en toda la app) — reduce parte de la protección que CSP daría contra XSS, pero es una decisión de arquitectura existente, no algo nuevo de esta sesión.
- **Mensajería de terceros** (`admin/js/whatsapp-conversaciones.js`, portal de proveedor): el contenido real de mensajes de WhatsApp (`m.texto`) y los datos del portal de proveedor ya pasan por `esc()`/`sanitize()` correctamente — es la superficie más expuesta a texto de terceros y está bien protegida.
- **Remito del portal chofer** (`chofer/remito.html`): todo el árbol de datos (cliente, teléfono, productos, medio de cobro) pasa por `esc()` consistentemente. Sin hallazgos.
- **Catálogo/carrito de cliente** (`cliente/catalogo.html`, `cliente/carrito.html`): nombres de producto/categoría escapados correctamente.
- **`eval()`/`new Function()`**: no se usan en ningún archivo del frontend. `document.write()` aparece en `export-utils.js` (`printTable`, sin callers actuales — código muerto) y en `remito.js` (ventana de impresión, con contenido ya escapado antes de llegar ahí).

## Hallazgos de higiene (no urgentes, no explotables hoy)
- `ribbonCard()` y `KanbanBoard` (`shared/adminlte-widgets.js`) no tienen ningún caller en el proyecto — código muerto, candidato a limpieza futura.
- `ExportUtils.printTable()` (`admin/js/export-utils.js`) tampoco tiene callers hoy.
- `admin/js/proveedores.js:318` (`enviarPortalWhatsapp`) usa el mismo escape manual incompleto (`.replace(/'/g, ...)`) sobre `data.url`, pero ese valor lo genera el propio backend (token de portal), no es texto de usuario — riesgo bajo, no se tocó.

## Responsividad móvil
Spot-check liviano (no exhaustivo): las 100% de las páginas HTML tienen `<meta name="viewport">`, y hay 27 archivos CSS con `@media queries` en `admin/css`/`shared`. No se detectaron páginas sin ningún soporte responsive. Un barrido página por página (breakpoints específicos, tablas que no colapsan bien en mobile, etc.) queda pendiente si se quiere ir más profundo — no se hizo en esta pasada porque el foco de la sesión fue seguridad (XSS).

## Pendiente
- Nada bloqueante. Como trabajo futuro: unificar el patrón de escape (hoy conviven `sanitize`/`s`/`esc`/`escHtml`/`escapeHtml`, todos con la misma implementación pero re-declarados por archivo) en un solo helper importado, para que sea más difícil que una función nueva "olvide" escapar — mismo tipo de recomendación que ya se hizo en Etapa 3 para el chequeo de auth inline repetido.
