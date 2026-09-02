# v962 — Fix XSS en "Comprobantes históricos" (auditoría de bugs, Etapa 4 — Facturación)

## Alcance de la revisión

Módulo Facturación completo: `frontend/admin/js/facturacion.js` (781
líneas), `frontend/admin/js/notas-credito.js` (509 líneas) y
`frontend/admin/facturacion-config.html` — sin hallazgos, ya sanitizan de
forma consistente (`escHtml()`/`window.sanitize()` para todo dato de
usuario, `.value`/`.textContent` para el resto). `facturacion.js` incluso
tenía ya un comentario documentando una consolidación previa: su
`escHtml()` local delega en `window.sanitize()` en vez de tener su propia
implementación (que "antes... no escapaba comillas de ningún tipo").

El único hallazgo está en el script inline `type="module"` embebido en
`frontend/admin/facturacion.html` — a diferencia de los dos `.js` externos
cargados en la misma página, este no sanitizaba.

## Hallazgo 🟡 Medio #21

`frontend/admin/facturacion.html` — `renderComprobantesHist()`, pestaña
"Comprobantes históricos" (solo lectura sobre la tabla
`comprobantes_historicos`, poblada únicamente desde el wizard de
migración de datos — `frontend/admin/js/migracion.js` /
`lib/handlers/migracion.js`, no auditado en esta ronda).

### El problema

```js
tbody.innerHTML = rows.map(r => `
  <tr>
    <td data-label="Tipo">${TIPO_LABEL_CH[r.tipo] || r.tipo}</td>
    <td data-label="Número original">${r.numero_original || '—'}</td>
    <td data-label="Cliente">${r.clientes?.nombre_fantasia || r.clientes?.razon_social || '—'}</td>
    ...
    <td data-label="Observaciones">${r.observaciones || '—'}</td>
  </tr>
`).join('');
```

`numero_original`, el nombre del cliente y `observaciones` son texto libre
cargado a mano por quien corre el wizard de migración al importar el
historial de comprobantes de un sistema anterior — a diferencia del resto
de una factura normal (número, CAE, fechas), que son generados por el
sistema. Confirmado en el backend
(`lib/handlers/facturas.js`, `handleComprobantesHistoricos`): el comentario
del propio código dice *"No hay alta/baja/edición: se cargan únicamente
desde el wizard de migración"* — es decir, texto sin ninguna validación de
contenido, solo de que exista la fila.

Esta vista además es de solo lectura para cualquiera con acceso a
Facturación (no solo para quien hizo la migración), así que un payload
cargado una sola vez durante la migración queda ejecutándose para todo el
equipo cada vez que alguien abre esa pestaña — mismo patrón de fondo que
los hallazgos #16/#19/#20 de esta y rondas anteriores.

De paso, el mensaje de error del `catch` de `cargarComprobantesHistoricos()`
también se interpolaba crudo en el mismo `innerHTML` — vector improbable en
la práctica (el mensaje sale de `data.error` del propio backend o de un
`Error` de JS, no de un campo de usuario), pero se corrigió por
consistencia defensiva ya que toca el mismo patrón.

### El fix

```js
tbody.innerHTML = rows.map(r => `
  <tr>
    <td data-label="Tipo">${TIPO_LABEL_CH[r.tipo] || window.sanitize(r.tipo)}</td>
    <td data-label="Número original">${window.sanitize(r.numero_original || '—')}</td>
    <td data-label="Cliente">${window.sanitize(r.clientes?.nombre_fantasia || r.clientes?.razon_social || '—')}</td>
    ...
    <td data-label="Observaciones">${window.sanitize(r.observaciones || '—')}</td>
  </tr>
`).join('');
```

Y en el catch:

```js
tbody.innerHTML = `<tr><td colspan="6" class="tabla-loading">${window.sanitize(err.message)}</td></tr>`;
```

Se usa `window.sanitize` directo (no `escHtml()`, que es una función local
de `facturacion.js`) porque este bloque es un script `type="module"` —
mismo criterio que ya usaba `notas-credito.js` en el resto de la página.

### Verificación

El bloque `<script type="module">` se extrajo y se corrió `node --check`
sobre su contenido — sintaxis OK. `facturacion.js`, `notas-credito.js` y
`stock.js` (tocado en el changelog de Stock de esta misma ronda) también
verificados.

## Pendiente

El wizard de migración (`frontend/admin/js/migracion.js` +
`lib/handlers/migracion.js`), única vía de carga de
`comprobantes_historicos`, queda fuera del alcance de esta ronda —
candidato para una futura pasada de Etapa 4 o una revisión aparte, ya que
no es uno de los módulos del plan original (Facturación, Cheques, Cta-Cte,
Rutas, portales).

Con esto, Facturación queda cerrada. Ver `AUDITORIA_BUGS_v954.md` para el
detalle completo y el estado del plan. Sigue: Cheques, Rutas, portales
cliente/chofer/proveedor.
