# Etapa 8 — Portal de proveedores / órdenes de compra

**Nota de orden:** esta etapa se auditó a pedido explícito del usuario,
salteando las etapas 6 (Rutas y entregas) y 7 (POS) de la tabla del
índice, que siguen `⚪ Pendiente`.

Alcance: `lib/handlers/portal_proveedor.js`, `lib/handlers/proveedores.js`
(dispatcher `_svc=portal`/`_svc=portal-admin` y `handleCompras`),
`frontend/proveedor/portal.html` + `portal.js` (portal público, sin
login), `frontend/admin/js/proveedores.js`, `frontend/admin/js/compras.js`,
`frontend/admin/js/cc-proveedores.js`, y las migraciones de storage
`073_fix_score_y_escritura_portal_proveedor.sql` /
`094_innovacion10_portal_proveedor_columnas.sql`.

## Resumen de hallazgos

| Hallazgo | Severidad | Estado |
|---|---|---|
| 1. XSS en el portal público de proveedores (sin login) — el helper `esc()` existía pero nunca se usaba | 🔴 Alta | ✅ Corregido en código |
| 2. XSS en el panel admin de Cta. Cte. Proveedores, explotable por un proveedor externo vía `numero_factura` | 🔴 Alta | ✅ Corregido en código |
| 3. `numero_factura` sin sanitizar/acotar en el backend (raíz de 1 y 2) | 🟡 Media | ✅ Corregido en código |
| 4. `confirmarEntrega`: el UPDATE final no repetía el filtro por `proveedor_id`/`empresa_id` | 🟡 Baja | ✅ Corregido en código |
| 5. Bucket `facturas-proveedor` público (URLs sin auth) | ⚪ Informativo | Sin cambios — decisión de diseño ya documentada, ver detalle |
| 6. Políticas de storage duplicadas entre migraciones 073 y 094 | ⚪ Higiene | Sin cambios — no es explotable, solo deuda de mantenimiento |

Ningún hallazgo requirió migración SQL — todo el fix es de código
(`frontend/proveedor/portal.js`, `frontend/admin/js/cc-proveedores.js`,
`lib/handlers/portal_proveedor.js`). Sin migraciones, no hay nada
aplicado en Supabase; **todo queda pendiente de `git push`/deploy a
Vercel**, igual que las etapas 1-5.

## Hallazgo 1 — XSS en el portal público de proveedores (🔴 Alta)

`frontend/proveedor/portal.js` es la pantalla que ve el proveedor **sin
login**, entrando solo con un token en la URL. `render()`, `renderOC()` y
`renderFactura()` insertaban directo en `innerHTML` varios valores que
vienen de la base o de la propia carga del proveedor, sin escapar:
nombre de la empresa (`data.empresa`), nombre del proveedor
(`nombre_fantasia`/`razon_social`), número de OC, descripción de ítems, y
**`numero_factura`** — este último es el más grave, porque lo carga el
propio proveedor vía `subirFactura` sin ninguna sanitización server-side
(hallazgo 3). El archivo ya tenía definida una función `esc()` para esto,
pero no se usaba en ningún lado — quedó escrita pero nunca conectada.

Cadena de explotación concreta: un actor con un link de portal válido (el
suyo propio, no hace falta robar nada) sube una factura con
`numero_factura` conteniendo un payload (`<img src=x onerror=...>`), y
la próxima vez que ese mismo portal recarga los datos, el script corre en
el navegador de quien esté mirando esa página — incluyendo, vía el
hallazgo 2, en la sesión de un admin de la distribuidora.

**Fix:** se conectó `esc()` en los cinco puntos de inserción no
escapados (`nombreProveedor`, `data.empresa`, `o.numero`, `i.descripcion`,
`f.numero_factura`).

## Hallazgo 2 — XSS en Cta. Cte. Proveedores, escalación externo→admin (🔴 Alta)

`frontend/admin/js/cc-proveedores.js` (línea 209) usa `sanitize()`/
`window.sanitize()` consistentemente en el resto del archivo para
cualquier dato con origen externo — **excepto** en la celda que muestra
`f.numero_factura` y `f.tipo`, insertados directo en `innerHTML`.

Esto es una escalación real de privilegios: `numero_factura` lo escribe
un **proveedor externo, no autenticado**, y se renderiza en la sesión
autenticada de un **admin** de la distribuidora la próxima vez que abre
la lista de facturas de proveedores — mismo patrón de severidad que el
hallazgo de XSS ya corregido en la etapa 5 de la otra auditoría (nombre
de empresa autoregistrada ejecutando en la sesión del superadmin).

**Fix:** `${f.numero_factura}` → `${window.sanitize(f.numero_factura)}`,
mismo tratamiento para `f.tipo`.

**Nota fuera de alcance:** se detectó de paso el mismo patrón sin
escapar en `frontend/admin/js/cobranzas.js:267` (`f.numero_factura` de
**facturas de venta**, no de proveedor) — corresponde al módulo 3 (Cta.
cte. y cobros, ya cerrado 3/3). Queda registrado acá para no perderlo,
pero no se tocó por estar fuera del alcance de esta etapa.

## Hallazgo 3 — `numero_factura` sin sanitizar en el backend (🟡 Media)

`subirFactura` en `portal_proveedor.js` solo validaba que
`numero_factura` no fuera vacío — sin tope de longitud ni chequeo de
tipo. Es la causa raíz que habilita 1 y 2: escapar en el render es la
defensa correcta contra XSS, pero dejar el dato crudo sin ningún límite
en el backend es una capa de defensa en profundidad que faltaba.

**Fix:** se agregó validación (`string`, no vacío tras `trim()`, máximo
40 caracteres) y se persiste con `trim()` aplicado.

## Hallazgo 4 — Filtro de tenant incompleto en `confirmarEntrega` (🟡 Baja)

El propio archivo documenta en su cabecera: *"Las escrituras (...)
SIEMPRE filtran explícitamente por proveedor_id/empresa_id (...) la
validación de pertenencia es responsabilidad exclusiva de este código,
nunca delegada a la DB"* — porque usa `SERVICE_ROLE_KEY`, que bypassea
RLS. El `SELECT` previo en `confirmarEntrega` sí filtraba por los tres
campos, pero el `UPDATE` final solo filtraba por `.eq('id', orden_id)`.

**No es explotable hoy** (el `orden_id` que llega al `UPDATE` es el mismo
que ya validó el `SELECT` inmediatamente antes, en el mismo request), pero
rompe el invariante documentado y deja el código frágil ante un futuro
refactor que separe o reordene esos dos pasos.

**Fix:** se agregaron `.eq('proveedor_id', proveedor_id)` y
`.eq('empresa_id', empresa_id)` al `UPDATE`, igual que en el resto del
archivo.

## Hallazgo 5 — Bucket `facturas-proveedor` público (⚪ Informativo, sin cambios)

Las facturas subidas por el proveedor quedan en un bucket con
`public: true` — `archivo_url` funciona sin autenticación, y la ruta
(`empresa_id/proveedor_id/timestamp_ms.ext`) no tiene componente
aleatorio. Es una decisión de diseño **ya documentada explícitamente**
en las migraciones 073/094 (mismo patrón que el bucket `remitos`), no un
hallazgo nuevo — se deja registrado porque ahora el bucket contiene
facturas con datos potencialmente sensibles (montos, CUIT si aparece en
el PDF) y podría valer la pena revisar el patrón general de storage
público del proyecto en una auditoría de infraestructura, no en esta.

## Hallazgo 6 — Políticas de storage duplicadas (⚪ Higiene, sin cambios)

Las migraciones 073 y 094 crean, cada una por su cuenta, políticas RLS
distintas para el mismo bucket `facturas-proveedor` (`073` usa
`DROP POLICY IF EXISTS` + nombres `_service`/`_public`; `094` usa
`CREATE POLICY` sin `DROP` previo + nombres `_public_select`/
`_no_delete`). No es explotable — ambos conjuntos apuntan al mismo
resultado funcional — pero es deuda de mantenimiento: si alguna vuelve a
correr fuera de orden, `094` fallará por policies duplicadas (Postgres no
tiene `CREATE POLICY IF NOT EXISTS`). Se deja registrado, no se tocó por
ser de bajo impacto y no bloquear nada.

## Pendiente / fuera de alcance de esta etapa
- Etapas 6 (Rutas y entregas) y 7 (POS) siguen `⚪ Pendiente` — se
  saltearon a pedido explícito para llegar directo a la 8.
- El hallazgo de `cobranzas.js` (nota del Hallazgo 2) queda para cuando
  se retome el módulo 3.
- No se revisó a fondo el flujo de recepción de mercadería con OCR
  (`upload-remito`, `recepcionar`) más allá de confirmar el aislamiento
  por `empresa_id` — quedaría para una pasada futura si se quiere ir más
  a fondo en ese sub-flujo.
