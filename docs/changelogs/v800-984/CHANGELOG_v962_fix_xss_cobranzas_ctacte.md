# v962 — Fix XSS almacenado en Cobranzas y Cta-Cte (auditoría de bugs, Etapa 4)

`cobranzas.js` y `cta-cte.js` se cargan juntos en `cobranzas.html`, así que
se revisaron los dos completos en la misma pasada. Mismo patrón que el
hallazgo 🟠 #16 (Clientes) y 🔴 #17 (`ui-utils.js`): datos de texto libre de
usuario interpolados sin `sanitize()`/`escHtml()` en un `innerHTML`, de
forma inconsistente con el resto del archivo, que sí sanitiza.

## Hallazgo 🟡 Medio #19 — `cobranzas.js`

Tabla de "Facturas pendientes": `f.numero_factura`, `f.cliente_nombre` y la
etiqueta del chip de prioridad (`chip.label`) se interpolaban crudos en las
celdas `<td>`. `cliente_nombre` en particular lo carga cualquier usuario
con permiso de ABM de Clientes — mismo vector de escalamiento que #16: un
nombre malicioso cargado por un rol de menor privilegio se ejecuta en el
navegador de cualquiera que abra Cobranzas.

```js
// Antes:
<td data-label="N° Factura" ...>${f.numero_factura || '—'}</td>
<td data-label="Cliente">${f.cliente_nombre || '—'}</td>
...
<span class="chip ${chip.cls}" ...>${chip.label}</span>

// Ahora:
<td data-label="N° Factura" ...>${window.sanitize(f.numero_factura || '—')}</td>
<td data-label="Cliente">${window.sanitize(f.cliente_nombre || '—')}</td>
...
<span class="chip ${chip.cls}" ...>${window.sanitize(chip.label)}</span>
```

## Hallazgo 🟡 Medio #20 — `cta-cte.js`

Tabla de "Saldos por cliente" (`renderTabla`): `nombre`
(`c.nombre_fantasia || c.razon_social`) se insertaba crudo en el `<div>`
del nombre, mientras dos líneas más abajo el propio código sí envuelve
`c.razon_social` en `sanitize()` cuando difiere del nombre mostrado —
inconsistencia dentro de la misma función, con el mismo dato de origen.

```js
// Antes:
<div style="font-weight:600">${nombre}</div>
${c.razon_social !== nombre ? `<div ...>${sanitize(c.razon_social)}</div>` : ''}

// Ahora:
<div style="font-weight:600">${sanitize(nombre)}</div>
${c.razon_social !== nombre ? `<div ...>${sanitize(c.razon_social)}</div>` : ''}
```

El resto de `cta-cte.js` (movimientos del panel de detalle, modal de
cobro, envío de estado de cuenta) ya sanitiza correctamente o usa
`.value`/`.textContent`, que no son vector de XSS — sin hallazgos ahí.

## Verificación

`node --check` OK en ambos archivos. No hay tests unitarios de render en
ninguno de los dos módulos (no se agregaron en esta ronda — el patrón de
fix es idéntico al ya cubierto por `tests/frontend/ui-utils-sanitize.test.js`
para la función `sanitize()` en sí).

## Alcance

Con esto, Cobranzas y Cta-Cte quedan cerrados para esta ronda de la Etapa 4.
Ver `AUDITORIA_BUGS_v954.md` para el detalle completo y el estado del plan.
Sigue: Facturación, Cheques, Rutas, portales cliente/chofer/proveedor.
