# CHANGELOG v194 — Migraciones: tres correctivos de visibilidad

## Resumen ejecutivo

Este release cierra tres brechas detectadas en el módulo de migración:

1. **[IMPLEMENTADO - Frontend]** Indicador global en el dashboard de sesiones con errores/advertencias pendientes
2. **[IMPLEMENTADO - Frontend + guía de backend]** Datos extra (campos sin mapear) visibles en la ficha del registro migrado
3. **[IMPLEMENTADO - Frontend]** Mapeo verificado 1:1 de las 18 entidades migrables con sus pantallas admin

---

## Punto 1 — Dashboard: indicador de migraciones pendientes

**Problema:** Sin alerta global de migraciones con advertencias/errores pendientes. Si el usuario no volvía a entrar manualmente a `migracion.html`, no se enteraba de que quedaron sesiones sin resolver.

**Corrección implementada:**
- `frontend/admin/dashboard.html`: nuevo `<div id="alerta-migracion-pendiente">` después del div de alerta de stock.
- `frontend/admin/js/dashboard-optimizado.js`: función `cargarAlertasMigracion()` que llama a `GET /api/migracion`, filtra sesiones con `estado === 'error'` o `filas_con_error > 0`, y ejecuta `renderAlertaMigracionPendiente()` para mostrar una tarjeta naranja con el número de sesiones y un link a `migracion.html`.
- `frontend/admin/css/dashboard.css`: estilos `.alerta-proactiva--migracion`, `.mig-dash-badge`.

**Sin cambios de backend requeridos para este punto.**

---

## Punto 2 — Datos extra sin destino: JSON "extras" en la ficha del registro

**Problema:** Mapeo estrictamente rígido. Si el sistema viejo del cliente traía un campo custom inexistente en el sistema, los datos se descartaban silenciosamente.

### Cambios de frontend implementados

**`frontend/admin/js/migracion-badge.js`** — reescrito completo:
- Agrega `_renderExtras(cont, datosExtras)`: panel colapsable con tabla de extras.
- `renderBadgeOrigenMigracion()` ahora lee `data.datos_extras` en la respuesta de `accion=origen` y, si hay datos, los muestra en el panel colapsable debajo del badge.
- Los estilos CSS del panel de extras están inline-inyectados (igual que el badge original).

**`frontend/admin/js/migracion.js`**:
- `renderColumnasSinMapear()` mejorado: acepta un 4to parámetro `muestras` (objeto `{ columna: [val1, val2, val3] }`) y, cuando está disponible, muestra los valores de ejemplo en una tabla en lugar de una lista plana.
- Nueva función `_cargarMuestrasExtras(sesionId, columnasSinMapear)`: llama al endpoint existente de staging rows para obtener hasta 3 valores de muestra por columna sin mapear.
- `mostrarResultado()`: si hay columnas sin mapear y hay sesionId, llama async a `_cargarMuestrasExtras` antes de renderizar para mostrar ejemplos concretos.

### Cambios de backend REQUERIDOS (NO incluidos en el distrib)

Para que `datos_extras` aparezca en la ficha del registro migrado (`migracion-badge.js` lo lee de la respuesta de `accion=origen`), el handler de backend debe:

#### En `lib/handlers/migracion.js`, case `'origen'`:

Actualmente retorna:
```json
{
  "migrado": true,
  "sesion_id": "uuid...",
  "fecha": "2024-01-15T...",
  "nombre_archivo_original": "clientes.xlsx"
}
```

**Debe retornar también:**
```json
{
  "migrado": true,
  "sesion_id": "uuid...",
  "fecha": "2024-01-15T...",
  "nombre_archivo_original": "clientes.xlsx",
  "datos_extras": {
    "codigo_interno": "CLI-0042",
    "observaciones_internas": "cliente frecuente",
    "codigo_ruta": "A-07"
  }
}
```

**Cómo obtener `datos_extras`:**
```js
// En el handler de accion=origen, después de confirmar que el registro
// fue migrado (migracion_log o campo migrado_de_sesion_id en la entidad):

// 1. Obtener la staging row del registro
const { data: staging } = await supabase
  .from('migracion_staging_rows')
  .select('datos_originales, sesion_id')
  .eq('registro_id_final', registroId)   // o el campo que linkea staging → entidad final
  .eq('empresa_id', empresaId)
  .maybeSingle();

if (staging?.datos_originales) {
  // 2. Obtener el mapeo de la sesión para saber qué columnas SÍ se usaron
  const { data: sesion } = await supabase
    .from('migracion_sesiones')
    .select('mapeo_columnas')
    .eq('id', staging.sesion_id)
    .single();

  // 3. Calcular columnas sin mapear
  const colUsadas = new Set(Object.values(sesion?.mapeo_columnas || {}));
  const extras = {};
  for (const [col, val] of Object.entries(staging.datos_originales)) {
    if (!colUsadas.has(col) && val !== '' && val != null) {
      extras[col] = val;
    }
  }
  if (Object.keys(extras).length > 0) {
    response.datos_extras = extras;
  }
}
```

**Nota:** La tabla `migracion_staging_rows` ya existe y ya tiene `datos_originales`. Solo hace falta el link entre `registro_id_final` y el UUID de la entidad (columna que ya debería estar presente si el handler de confirmación la llena al crear el registro).

---

## Punto 3 — Mapeo verificado 18 entidades → pantallas admin

**Problema:** Sin verificación de dónde aparece cada entidad migrada en el admin. Especialmente para `precios_clientes`, `ordenes_compra`, `pagos_proveedores`, `ventas_pos`, `comprobantes_historicos` y `direcciones`.

**Corrección implementada:**
- `ORDEN_GUIADO` en `migracion.js` ahora tiene `url_admin` y `nota_pantalla` por entidad.
- `renderChecklist()` muestra un link "Ver en admin →" cuando una entidad está completada, y una nota ámbar cuando la entidad no tiene página global dedicada.
- `migracion.css`: estilos `.mig-ck-link-admin`, `.mig-ck-nota-ok`, `.mig-ck-nota-gap`.

### Tabla de mapeo verificado

| Entidad | Pantalla admin | Estado pantalla |
|---------|---------------|-----------------|
| categorias | /admin/productos | ✅ Existe (dropdown categoría en productos) |
| depositos | /admin/stock | ✅ Existe (selector de depósito) |
| listas_precios | /admin/clientes | ✅ Existe (campo en ficha del cliente) |
| zonas | /admin/rutas | ✅ Existe (campo en ficha del cliente) |
| clientes | /admin/clientes | ✅ Pantalla dedicada |
| productos | /admin/productos | ✅ Pantalla dedicada |
| lotes | /admin/stock | ✅ Existe (sección FEFO/lotes) |
| precios_clientes | /admin/clientes | ⚠ Solo en ficha del cliente, sin vista global |
| pedidos | /admin/pedidos | ✅ Pantalla dedicada |
| cta_cte | /admin/cta-cte | ✅ Pantalla dedicada |
| proveedores | /admin/compras | ✅ Existe (sección proveedores en compras) |
| ordenes_compra | /admin/compras | ✅ Tabla en compras |
| pagos_proveedores | /admin/cc-proveedores | ✅ Tabla en CC-Proveedores |
| cheques | /admin/cheques | ✅ Pantalla dedicada |
| puntos_fidelizacion | /admin/fidelizacion | ✅ Pantalla dedicada |
| ventas_pos | /admin/pos | ⚠ Sin historial global dedicado; visibles en reportes |
| comprobantes_historicos | /admin/facturacion | ⚠ Solo en ficha del cliente, sin vista global |
| direcciones | /admin/clientes | ⚠ Solo en ficha del cliente, sin vista global |

### Gaps identificados (sin página admin dedicada)

Las entidades marcadas con ⚠ tienen cobertura parcial. Para cierre total, evaluar:
- **precios_clientes**: agregar pestaña "Precios especiales" en clientes.html con tabla global
- **ventas_pos**: agregar sección de historial en pos.html o en reportes
- **comprobantes_historicos**: agregar pestaña en facturacion.html o búsqueda global
- **direcciones**: agregar sección "Direcciones de entrega" en clientes.html

---

## Archivos modificados en este release

```
frontend/admin/dashboard.html            — div#alerta-migracion-pendiente
frontend/admin/css/dashboard.css         — estilos del widget de migración
frontend/admin/js/dashboard-optimizado.js — cargarAlertasMigracion + renderAlertaMigracionPendiente
frontend/admin/js/migracion-badge.js     — reescrito: soporte datos_extras + panel colapsable
frontend/admin/js/migracion.js           — ORDEN_GUIADO + renderChecklist + renderColumnasSinMapear
frontend/admin/css/migracion.css         — estilos de link admin y notas de mapeo
```

## Backend REQUERIDO (por fuera del distrib)

```
lib/handlers/migracion.js               — case 'origen': incluir datos_extras en la respuesta
```
