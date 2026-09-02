# v245 — Etapa 6: Export contable (diseño + base + esqueleto)

## Contexto
Primera entrega del frente "Export contable" de la Etapa 6 ("Integraciones
externas"). Alcance acordado para esta entrega: **diseño + migración SQL +
esqueleto de handler**, no la feature completa. De los tres formatos
pedidos (Tango, Bejerman, Contabilium), ninguno queda funcional todavía —
ver "Por qué nada quedó implementado al 100%" más abajo. El export **CSV
genérico sí queda completo y funcional**, para validar todo el circuito
(config → permisos → vistas SQL → archivo → auditoría) sin depender de
conseguir un layout externo.

## Qué se agregó

### Backend (Supabase) — `supabase/migrations/245_etapa6_export_contable.sql`
- `export_contable_config`: 1 fila por empresa. Guarda proveedor elegido
  (`tango` / `bejerman` / `contabilium` / `generico_csv`), plan de cuentas
  (JSONB abierto — ver nota de diseño), separador decimal y formato de
  fecha. RLS: lectura dueño/admin/contador, escritura solo dueño/admin.
- `export_contable_log`: historial de cada exportación (empresa, proveedor,
  tipo, rango de fechas, cantidad de registros, quién la generó). No
  bloquea re-exportar el mismo rango — es solo auditoría/trazabilidad.
- `codigo_contable` (nullable) agregado a `clientes` y `proveedores`: para
  cuando haga falta matchear contra el código interno que Tango/Bejerman
  le asignan a cada cliente (no siempre coincide con buscar por CUIT).
- `v_comprobantes_contables_venta`: UNION de `facturas` (emitidas) +
  `notas_credito` (emitidas), normalizado con `signo` (+1/-1) para que
  `total * signo` dé directo el neto a imputar en Ventas.
- `v_comprobantes_contables_compra`: `facturas_proveedor` (no anuladas),
  mismo shape normalizado que la vista de venta.
- `get_export_contable_config()`: RPC de lectura para el frontend, mismo
  patrón que `get_facturacion_config()` de la integración ARCA.

### Backend (API)
- `lib/handlers/export-contable.js` (nuevo): mismo patrón de auth que
  `facturas.js` (roles dueño/admin/contador para generar, dueño/admin para
  configurar). Rutas:
  - `GET/POST /api/export-contable/config`
  - `GET /api/export-contable/historial`
  - `GET /api/export-contable?tipo=ventas|compras|cobranzas&desde=&hasta=&proveedor=`
- `lib/export-contable/index.js`: dispatcher — cada formateador expone
  `generar({tipo, comprobantes, desde, hasta, config, empresa_id, supabase})`
  y devuelve `{contenido, nombreArchivo, mimeType}`.
- `lib/export-contable/formato-generico-csv.js`: **completo y funcional**.
- `lib/export-contable/formato-tango.js`, `formato-bejerman.js`: esqueletos
  documentados que devuelven 501 a propósito (ver más abajo).
- `lib/export-contable/formato-contabilium.js`: esqueleto con una
  advertencia de diseño distinta a los otros dos (ver más abajo).
- `api/index.js`: registrado el módulo `export-contable` en `HANDLERS`.
- `vercel.json`: rewrites agregados, mismo patrón que `facturas`.

## Por qué nada quedó implementado al 100%

**Tango y Bejerman** importan asientos vía archivo (plano de ancho fijo o
Excel con plantilla propia), pero el layout exacto —posiciones de columna,
si es 1 o 2 líneas por asiento, cómo se discrimina el IVA— depende de la
versión y de cómo esté parametrizado el Tango/Bejerman de cada contador.
Generar esto sin un archivo de ejemplo real ya aceptado por el sistema del
cliente tiene el riesgo de producir un archivo que "importa" pero cruza
cuentas mal — un error silencioso, peor que no tener la feature. Antes de
completar estos dos formateadores hace falta:
1. Un archivo de ejemplo real de importación de asientos, del Tango/Bejerman
   que efectivamente use el contador.
2. Confirmar el criterio de asiento (por comprobante vs. resumen por
   período) y el mapeo exacto de campos.

**Contabilium** es distinto en su naturaleza: es un sistema cloud con API
REST propia, no un programa de escritorio que importa archivos. Forzarlo
al mismo contrato `{contenido, nombreArchivo, mimeType}` que Tango/Bejerman
sería la decisión de diseño equivocada — lo correcto es que el backend
llame directo a su API con reintentos (mismo patrón que
`lib/circuit-breaker.js` ya usa para otras integraciones), y devuelva un
resumen de subida en vez de un archivo. Eso implica una rama aparte en
`generarHandler()` de `export-contable.js` que todavía no existe. Quedó
documentado en el propio archivo del formateador en vez de forzar algo que
no encaja.

### Frontend (nuevo)
- `frontend/admin/export-contable.html` + `frontend/admin/js/export-contable.js`:
  página nueva con 3 bloques — configuración (elegir proveedor + plan de
  cuentas + formato), generar export (tipo/rango de fechas → descarga
  directa) e historial (últimas 50 exportaciones). Tango/Bejerman/
  Contabilium se muestran como tarjetas seleccionables con badge
  "Próximamente" (siguen devolviendo 501 del backend); CSV genérico está
  marcado "Listo" y es el único funcional hoy.
  - Solo dueño/admin puede modificar la configuración (plan de cuentas,
    proveedor, formato) — contador ve esos campos pero deshabilitados.
    Los tres roles pueden generar exports y ver el historial.
  - Reutiliza los mismos tokens de diseño y estructura que
    `comparador-precios.html` (la página más reciente del proyecto al
    momento de esta entrega), no el estilo más viejo de
    `facturacion-config.html`.
- `frontend/admin/js/nav-data.js`: nueva sección "Export contable" dentro
  del grupo Facturación (roles dueño/admin/contador).
- `frontend/admin/facturacion.html`: botón "Export contable" agregado
  junto al de "Configurar AFIP" existente.
- `vercel.json`: rewrite `/admin/export-contable → export-contable.html`.

## Pendiente / próximos pasos sugeridos
1. Conseguir el archivo de ejemplo de Tango y/o Bejerman del contador real
   para poder calcar el layout con confianza.
2. Decidir si Contabilium se prioriza (requiere credenciales de API por
   empresa — nueva tabla o extensión de `export_contable_config`, nunca en
   el JSONB de `plan_cuentas`, que es legible desde el frontend).
3. Frontend: no se tocó nada todavía — falta una pantalla (ej.
   `frontend/admin/facturacion-config.html` como modelo) para elegir
   proveedor, cargar plan de cuentas y disparar el export desde
   `cta-cte.html` / `reportes-financieros.html`.
4. Confirmar con el contador si "cobranzas" necesita mapeo a un asiento
   (Caja/Banco vs Deudores por Venta) o alcanza con el listado plano que
   ya arma `formato-generico-csv.js`.
