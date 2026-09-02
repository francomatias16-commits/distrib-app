# v962 — Fix XSS almacenado en Rutas (auditoría de bugs, Etapa 4)

Revisados completos `frontend/admin/js/rutas.js` (1905 líneas),
`rutas-resumen.js`, `zonas.js`, `remito.js`, `lib/repos/rutas.js` y
`lib/handlers/rutas-live.js`. Mismo patrón que los hallazgos #16/#19/#20/#21
de rondas anteriores: datos de texto libre interpolados sin `esc()`/
`sanitize()` en un `innerHTML`/`.bindPopup()`, de forma inconsistente con
el resto del archivo.

## Hallazgo 🟠 Alto #22 — `rutas.js`, popup del mapa de seguimiento en vivo

`inicializarMapa()` (tab "Seguimiento"): `cliente`, `dir` y `e.receptor` se
insertaban crudos dentro del `.bindPopup()` de Leaflet. El mismo archivo ya
tiene el fix correcto aplicado en otros tres lugares que muestran
`e.receptor` (modal de detalle de entrega, tabla de reportes, popup del
mapa de *reporte cerrado*) — solo quedó afuera el popup del mapa *en vivo*.

`receptor` es un campo de texto libre (`frontend/chofer/remito.html`, input
`#receptorEntrega`) que el chofer carga al confirmar una entrega. Es una
vía de escalamiento real: un chofer (rol de menor privilegio) confirma una
entrega con un `receptor` malicioso y el payload corre en el navegador de
cualquier dueño/admin/vendedor que tenga abierto el mapa de seguimiento en
vivo mientras la entrega se confirma.

```js
// Antes:
.bindPopup(`
  <div style="min-width:160px;">
    <strong>${cliente}</strong><br>
    ${dir ? `${dir}<br>` : ''}
    ...
    ${e.receptor ? `<br>Recibió: ${e.receptor}` : ''}
  </div>
`)

// Ahora:
.bindPopup(`
  <div style="min-width:160px;">
    <strong>${esc(cliente)}</strong><br>
    ${dir ? `${esc(dir)}<br>` : ''}
    ...
    ${e.receptor ? `<br>Recibió: ${esc(e.receptor)}` : ''}
  </div>
`)
```

## Hallazgo ⚪ Bajo #23 — `rutas.js` y `remito.js`

`rutas.js`, `cambiarTipoInvitacion()` (`<select>` "invitar chofer
existente"): `c.nombre` sin `esc()`, inconsistente con `avatarChofer()` y
la tabla de reportes del mismo archivo.

`remito.js`, pie del remito imprimible: `empresa.cuit` sin `sanitize()`,
inconsistente con los otros dos usos del mismo campo en el mismo archivo.
Dato cargado únicamente por dueño/admin, riesgo bajo.

```js
// rutas.js — antes:
`<option value="${c.id}">${c.nombre}${c.telefono ? '' : ' (sin teléfono)'}</option>`
// ahora:
`<option value="${c.id}">${esc(c.nombre)}${c.telefono ? '' : ' (sin teléfono)'}</option>`

// remito.js — antes:
Remito ${nroStr} · ${sanitize(empresa.nombre)}${empresa.cuit ? ' · CUIT ' + empresa.cuit : ''} · Emisión: ${fechaEmision}
// ahora:
Remito ${nroStr} · ${sanitize(empresa.nombre)}${empresa.cuit ? ' · CUIT ' + sanitize(empresa.cuit) : ''} · Emisión: ${fechaEmision}
```

## Sin hallazgos

`rutas-resumen.js` y `zonas.js` (frontend) y `lib/repos/rutas.js` +
`lib/handlers/rutas-live.js` (backend): sanitización consistente en todo
el frontend; consultas parametrizadas vía Supabase y scoping por
`empresa_id` en cada acción del backend, sin inyección ni fugas de
autorización.

## Verificación

`node --check` OK en `rutas.js` y `remito.js` (únicos archivos editados).

## Alcance

Con esto, Rutas queda cerrada para esta ronda de la Etapa 4.
Ver `AUDITORIA_BUGS_v954.md` para el detalle completo y el estado del plan.
Sigue: portales cliente/chofer/proveedor.
