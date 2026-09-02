# Plan de unificación de diseño, estructura y UX — Panel Admin
### Proyecto: repartos-distrib (v874/v879) — Referencia: Productos + Stock

---

## 0. Confirmación del diagnóstico sobre el ZIP actual (v879)

Repetí las verificaciones clave sobre el paquete que subiste ahora y coinciden con lo ya auditado:

- **56 páginas HTML** en `frontend/admin/`.
- **44 de 56** ya tienen la clase `dash-*-gentelella` en el `<body>`, y **39** tienen su propio archivo `css/*-gentelella.css`. Es decir: el "reskin" ya pintó cada página con la misma paleta y tokens, pero **cada página sigue definiendo su propia tabla, sus propios badges y su propio patrón de botones de acción**, con nombres de clase distintos entre sí. Por eso se ve "casi igual" pero no idéntico.
- `reskin-patch.css` + `reskin-patch-v2-shadcn.css` (inyectados en 57 páginas vía `shared/`) resuelven color, foco de teclado y utilidades opt-in (`btn-ghost`, `table-compact`, `empty-state`, etc.), pero **no fuerzan una estructura de tabla ni de acciones** — eso quedó librado a cada página.
- El **badge de estado** (`.badge-estado`) está re-declarado en **11 archivos CSS distintos** (`clientes`, `facturacion`, `stock`, `observabilidad`, `usuarios`, `whatsapp-conversaciones`, etc.), cada uno con su propio padding/radius/colores locales en vez de heredar de un único lugar.
- Hay **dos familias de "acciones por fila"** conviviendo:
  - **Familia A (texto + menú ⋮)**: `productos.js`, `stock.js`, `cc-proveedores.js`.
  - **Familia B (solo íconos cuadrados)**: `facturacion.js`, `auditoria.js`, `cheques.js`, `devoluciones.js`, `notas.js`, `notas-credito.js`.
- La clase de la etiqueta `<table>` no tiene un nombre único: existen `tabla`, `tabla-main`, `tabla-clientes`, `tabla-facturas`, `tabla-stock`, `tabla-historial`, `tabla-card`, `tabla-puntos`, `prod-tabla`, `ranking-table`, `rutas-table`, `saas-table`, `obs-tabla`, `pos-tabla-atajos`, entre otras — **14+ nombres distintos** para el mismo componente visual.
- **Importante, y esto no cambia el plan pero sí el orden de trabajo**: Productos y Stock son la pareja de referencia visual, pero **no son la misma plantilla entre sí** (Productos = `prod-tabla`, con columnas propias como orden/margen; Stock = `tabla-stock`). Antes de "clonar Productos" tengo que definir un **componente canónico único**, tomando de cada uno lo que ya está bien resuelto, y after eso replicarlo — no puedo copiar un archivo sobre el otro literalmente.

**Conclusión del diagnóstico:** no falta un sistema de diseño (los tokens de color/tipografía ya son consistentes). Falta **una capa de componentes HTML+CSS+JS reutilizable** para: tabla, thead, badge de estado, fila de acciones, paginación, barra de filtros/búsqueda y header de página. Ese es el trabajo real.

---

## 1. Objetivo y alcance

**Objetivo:** que las 56 páginas del panel admin (y, si se decide en el punto 7, la PWA chofer/páginas públicas con su propio criterio) usen **el mismo componente de tabla, badge, acciones, paginación, filtros y header**, con **una sola fuente de verdad en CSS/JS**, en vez de reimplementaciones por página.

**Fuera de alcance salvo que lo pidas explícitamente:**
- PWA chofer (4 páginas): tiene un sistema mobile-first deliberadamente distinto (botones full-width, radius 10px, `#185FA5`). Meterle el reskin de escritorio degradaría el uso real con guantes en la calle, según ya se comprobó.
- Páginas públicas/marketing (`index.html`, `registro.html`, `cliente/login.html`, `privacidad.html`, `terminos.html`): tienen CTAs de conversión con su propio diseño; no son "admin".
- 5 stubs de redirect (`cta-cte`, `liquidacion`, `lotes`, `presupuestos`, `superadmin`): no tienen contenido visual propio.

Esto deja **~47 páginas admin reales** a unificar (56 totales − 9 fuera de alcance de la familia B/C ya identificadas).

---

## 2. El "componente canónico": qué se define una sola vez

Voy a construir (o consolidar si ya existe algo aprovechable) **un único archivo**, `frontend/shared/componentes-admin.css` + un pequeño `componentes-admin.js` con helpers, que define de forma definitiva:

| Componente | Nombre de clase único | Reemplaza a |
|---|---|---|
| Contenedor de tabla | `.tabla-wrap` | (ya es el más usado, se mantiene) |
| Tabla | `.tabla-admin` (+ modificador opcional `table-compact`/`table-comfortable`, ya existente) | `tabla`, `tabla-main`, `tabla-clientes`, `tabla-facturas`, `tabla-stock`, `tabla-historial`, `tabla-card`, `tabla-puntos`, `prod-tabla`, `ranking-table`, `rutas-table`, `saas-table`, `obs-tabla` |
| Header ordenable | `.th-sort` + `data-col` (patrón ya usado en Productos) | soluciones ad-hoc por página |
| Badge de estado | `.badge-estado` + `.badge-{ok\|warning\|critico\|inactivo\|pendiente...}` definido **una sola vez** en el componente canónico | las 11 redefiniciones locales |
| Fila de acciones | `.fila-acciones` = botón(es) de texto para la acción primaria + `.btn-menu` (ícono ⋮) para secundarias, **patrón de Productos/Stock** | el patrón de solo-íconos de Facturación/Auditoría/Cheques/Devoluciones/Notas |
| Paginación | `.paginacion-wrap` + `.btn-pag` (patrón ya usado en Productos/Stock) | variantes sueltas en otras páginas |
| Barra de filtros | `.filtros-bar` con inputs/selects consistentes | headers de filtro ad-hoc |
| Header de página | `.topbar` + `.topbar-title` (ya estandarizado en 44/56) | los 12 restantes |
| Estado vacío / cargando | `.tabla-loading` / `.tabla-empty` (ya definidos, se mantienen y unifican mensaje/ícono) | variantes de texto suelto |

**Regla de oro:** el CSS por página (`css/<pagina>.css`, `css/<pagina>-gentelella.css`) deja de tener permitido declarar `.badge-estado`, tablas o botones de acción desde cero. Solo puede: (a) definir colores/columnas específicas de esa página que no aplican a ninguna otra, o (b) quedar vacío/eliminarse si no le queda nada propio.

---

## 3. Por qué Facturación (y su familia) es el caso más grande, no el único

Facturación no es un caso aislado de "se ve distinto": es el representante de una **familia de 6 páginas** con el mismo patrón "solo íconos" (`auditoria`, `cheques`, `devoluciones`, `facturacion`, `notas`, `notas-credito`). Corregir solo `facturacion.html` dejaría 5 páginas más todavía inconsistentes con Productos/Stock. El plan las trata como grupo.

De la misma manera, hay una tercera familia (`cc-proveedores` ya tiene texto+kebab, pero con su propia clase de tabla `tabla-main`) y un grupo grande de páginas con clase de tabla genérica `tabla` (`comparador-precios`, `compras`, `conciliacion-bancaria`, `export-contable`, `gastos-generales`, `notif-log`, `puntos`, `reglas-precio`, `rentabilidad-producto-vendedor`, `rentabilidad-zona`, `riesgo-cheques`, `vencimientos`, `whatsapp-conversaciones`, `fidelizacion`) que hoy no comparten estructura entre sí tampoco, aunque usen el mismo nombre de clase por casualidad.

---

## 4. Fases de ejecución

### Fase 0 — Construcción del componente canónico (sin tocar ninguna página todavía)
1. Extraer de `productos.html`/`productos.js`/`productos.css` y `stock.html`/`stock.js`/`stock.css` el marcado y CSS de: tabla, thead ordenable, badge de estado, fila de acciones (texto + kebab), paginación, filtros.
2. Resolver las diferencias entre ambos (p. ej. Productos usa `prod-th-sort`, Stock no ordena columnas) y decidir el superset canónico.
3. Escribir `frontend/shared/componentes-admin.css` con esas reglas, con **especificidad suficiente para no necesitar `!important`** (a diferencia del parche de reskin), pensado para ser la base y no un parche encima de un parche.
4. Escribir 3–5 funciones JS reutilizables en `frontend/shared/componentes-admin.js` (ej. `renderBadgeEstado(estado, mapaEstados)`, `renderFilaAcciones(acciones[])`, `renderPaginacion(...)`) para que cada página deje de tener su propio HTML-en-template-string para lo mismo.
5. Aplicar el componente **solo en una página de prueba que no sea Productos ni Stock** (propongo `cc-proveedores.html`, porque ya usa el patrón de acciones correcto y solo necesita el cambio de clase de tabla — es el riesgo más bajo) y validar visual + funcional antes de escalar.

**Entregable de Fase 0:** componente canónico + 1 página piloto migrada y verificada. Te la muestro antes de seguir.

### Fase 1 — Familia B: unificar el patrón de acciones (el cambio más visible)
Migrar `facturacion.html`, `auditoria.html`, `cheques.html`, `devoluciones.html`, `notas.html`, `notas-credito.html` del patrón "solo íconos" al patrón "texto + menú ⋮" de Productos/Stock, más el badge y la tabla canónicos.
- Orden sugerido dentro de la fase: `facturacion` primero (es la que mencionaste), después las otras 5 en el mismo lote de patrón porque comparten el mismo problema.
- Cada página se migra y se prueba individualmente (no todas de una vez), para poder revertir una sola si algo rompe.

### Fase 2 — Grupo de tabla genérica `tabla` ✅ CERRADA
Migrar las páginas que usan `<table class="tabla">` sin estructura compartida real al componente canónico.

**Estado final: 12 páginas migradas y auditadas** — `comparador-precios`, `conciliacion-bancaria`, `rentabilidad-zona`, `notif-log`, `riesgo-cheques`, `export-contable`, `reglas-precio`, `rentabilidad-producto-vendedor`, `gastos-generales`, `whatsapp-conversaciones`, `fidelizacion`, `vencimientos` (solo la tabla de ofertas — la de lotes es `.tabla-main`, baja a Fase 3).

**Corrección al listado original:** `compras` y `puntos`, incluidas en el listado inicial de esta fase, en realidad no usan la clase `tabla` (`compras.html` usa `.tabla-main` + tablas anidadas `.inner-tabla`; `puntos.html` usa `.tabla-puntos`/`.tabla-historial`). Se excluyen de Fase 2 y bajan a Fase 3, donde corresponden por estructura.

**Auditoría de cierre (checklist §5, corrida sobre las 12 páginas):**
1. Las 12 tienen `<table class="tabla-admin">` (o las varias tablas que correspondan) y cero `class="tabla"` remanente.
2. Las 12 cargan `/frontend/shared/componentes-admin.css` en el `<head>`.
3. Ningún `.js` de las 12 depende de la clase `.tabla` (`querySelector`, `classList`, `getElementsByClassName` — 0 coincidencias).
4. Ninguna de las 12 usa `data-label`/`table-responsive-cards`, así que no hay riesgo de mobile roto por la migración.
5. `body class` `dash-<pagina>-gentelella` coincide en cada HTML con el scope usado en su `*-gentelella.css` propio.
6. Padding/white-space que venían de CSS compartidos (`finanzas.css`, usado por 13 páginas; `reportes.css`) se preservaron explícitamente con comentarios en cada `*-gentelella.css`, sin tocar los archivos compartidos.

**Bug real corregido en el camino (`gastos-generales.html`):** el gentelella tenía reglas `tr.regla-inactiva`/`tr.regla-vencida` copiadas de `reglas-precio-gentelella.css` sin adaptar — nunca se activaban porque `gastos-generales.js` usa `.gasto-inactivo`. El efecto de opacidad vivía solo en el `<style>` inline (ahora removido); corregido para que el componente canónico sea la única fuente de ese efecto.

**Excepción documentada (no es un bug):** `riesgo-cheques.js` genera dinámicamente una tabla de detalle compacta (`class="tabla"`, embargos/rechazos) dentro de un modal — es una tabla secundaria distinta de la tabla-lista principal (que sí es `.tabla-admin`). Queda fuera del alcance de Fase 2 a propósito, no se tocó.

**Nota de proceso:** durante el cierre se detectó que 3 páginas (`export-contable`, `reglas-precio`, `rentabilidad-producto-vendedor`) habían sido migradas en una sesión anterior cuyos archivos se recibieron sueltos, no dentro del último ZIP de referencia — el ZIP tenía la versión pre-migración. Se corrigió reemplazando por los archivos migrados antes de dar la fase por cerrada.

### Fase 3 — Páginas con nombre de clase propio
`clientes` (`tabla-clientes`), `cajas` (`tabla-historial`), `automatizacion` (`tabla-card`), `puntos` (si no entró en Fase 2), `proveedores`/`rutas`/`usuarios`/`vencimientos`/`cc-proveedores` (`tabla-main`), `saas-billing` (`saas-table`), `reportes-*` (`ranking-table`), `observabilidad` (`obs-tabla`). Estas requieren más cuidado porque varias tienen columnas y anchos particulares (ranking, historial) — se preserva la columna especial, se unifica el resto (thead, badges, acciones, paginación).

### Fase 4 — Casos especiales, uno por uno con criterio propio
- `stock.html` y `pedidos.html`: ya usan `table-compact`, se revisan por si les falta algo del canónico (probablemente sea el menor esfuerzo).
- `pos.html` (`pos-tabla-atajos`): es una grilla de atajos de venta, no una tabla de listado — **no se fuerza** al patrón canónico si no corresponde funcionalmente; se decide caso por caso.
- Páginas sin tabla pero con inconsistencias de header/filtros igual (`dashboard`, `empresa-config`, `facturacion-config`, `mercadopago-config`, `migracion`, `avisos`, `anomalias`): se revisan aparte para header/topbar y botones, no aplica lo de tabla.

### Fase 5 — Limpieza final
- Eliminar de cada `css/<pagina>.css` y `css/<pagina>-gentelella.css` las reglas que quedaron redundantes (los 11 `.badge-estado` locales, las declaraciones de tabla duplicadas), dejando solo lo verdaderamente específico de esa página.
- Auditoría final: recorrer las 47 páginas y confirmar que **todas** usan `.tabla-admin`, `.badge-estado` canónico y `.fila-acciones`.
- Actualizar `docs/GENTELELLA_RESKIN_TRACKING.md` con el estado final, igual que se hizo con `README-reskin-v2.md`.

---

## 5. Cómo se ejecuta cada página (checklist repetible)

Para cada página del listado de fases, el trabajo puntual es:
1. Reemplazar la clase de `<table>` y su contenedor por las canónicas.
2. Reemplazar el render de badges en el `.js` correspondiente por `renderBadgeEstado(...)`.
3. Reemplazar el render de la celda de acciones por `renderFilaAcciones(...)` (texto + kebab), preservando las acciones reales de esa página (no se inventan ni se quitan acciones existentes).
4. Confirmar que la paginación (si existe) usa `.paginacion-wrap`/`.btn-pag`.
5. Quitar del CSS de la página las reglas ahora redundantes.
6. Verificación visual (captura o revisión en navegador si está disponible) + verificación funcional: que los `onclick` y IDs sigan apuntando a las funciones reales del `.js` (esto es lo que más riesgo de romper tiene, porque varias páginas usan `data-label` para las tarjetas responsive — hay que preservar esos atributos al migrar el `<td>`).

---

## 6. Riesgos identificados y cómo se mitigan

- **JS acoplado a nombres de clase antiguos** (selectores `document.querySelector('.tabla-facturas')`, etc.): antes de cambiar una clase en el HTML, reviso el `.js` de esa página para no dejar selectores rotos. Es el riesgo más alto y por eso cada página se migra y prueba individualmente, no en bloque.
- **Cards responsive (`data-label`)**: varias tablas (stock, pedidos) ya usan `table-responsive-cards` con `data-label` por celda para mobile. Al unificar hay que conservar ese atributo en cada `<td>` migrado, si no el mobile se rompe.
- **Columnas verdaderamente únicas por página** (ranking, historial de caja, kebab con acciones distintas): el componente canónico no elimina columnas propias del negocio, solo unifica el **envoltorio** (tabla, thead, badge, acciones, paginación).
- **Regresión visual silenciosa**: como `reskin-patch-v2-shadcn.css` usa `!important` y se carga al final, un componente canónico mal ordenado en el `<head>` podría no aplicarse. Se define el orden de carga exacto en Fase 0 y se replica igual en las 47 páginas.

---

## 7. Lo que NO voy a tocar salvo que me lo pidas

Confirmo que dejo fuera del alcance, salvo pedido explícito tuyo:
- PWA chofer (4 páginas) — diseño mobile-first deliberadamente distinto, ya evaluado y descartado antes.
- Páginas públicas/marketing (5) — CTAs de conversión, no son admin.
- Los 5 stubs de redirect.

Si en algún momento querés que estas también entren (por ejemplo, si el diseño mobile-first del chofer también debería alinearse a un sistema único), lo trato como una fase aparte con su propio criterio, porque ahí sí cambia la decisión de producto, no solo de consistencia.

---

## 8. Cómo propongo arrancar

Dado el tamaño (47 páginas reales, 2 archivos JS/CSS por página en promedio, más el componente canónico nuevo), la forma más segura de trabajar es:

1. Yo arranco por la **Fase 0** (componente canónico + página piloto `cc-proveedores`) y te la muestro.
2. Con tu OK sobre el componente, sigo con **Fase 1** (Facturación y su familia de 6), que es lo que disparó tu pregunta original — página por página, mostrándote cada una antes de pasar a la siguiente.
3. Después seguimos con las fases 2 a 5 en el mismo ritmo.

¿Arranco con la Fase 0 ahora (componente canónico + `cc-proveedores.html` como piloto), o preferís que primero te muestre nada más el componente canónico en un mock aislado antes de tocar cualquier página real del proyecto?

---

## 9. Log de avance y hallazgos transversales (se completa durante la ejecución)

### Avance de Fase 1 (Familia B)

| Página | Estado |
|---|---|
| `facturacion.html` | ✅ Migrada: tabla `.tabla-admin`, badges canónicos, `.fila-acciones`/`.btn-tabla`/`.btn-kebab`, CSS local limpio |
| `auditoria.html` | ✅ **Migrada completa** (ver §11 — cierre del Hallazgo #3): patrón de acciones (`.btn-icon` → `.fila-acciones`/`.btn-tabla`, ambas tablas: Registro de cambios y Eventos de negocio), tabla (`table.tabla` → `.tabla-admin` en ambas) y badges (`.chip`, cerrado en el Hallazgo #2) |
| `cheques.html` | ✅ **Migrada completa** (ver §11): patrón de acciones migrado (`.btn-icon`/`.btn-text-action` → `.fila-acciones` con dos `.btn-tabla` — "Editar" y "Verificar BCRA" — + `.btn-kebab` para "Anular"/"Reactivar", mutuamente excluyentes según estado, mismo menú flotante que Facturación). El `<select>` de cambio de estado se preservó dentro de `.fila-acciones`, sin tocar su lógica. Además renombré `.acciones-fila` → `.fila-acciones` en `cheques-gentelella.css` (era el mismo componente con nombre distinto, exclusivo de esta página, sin riesgo de romper otras) y limpié las reglas huérfanas de `.btn-icon`/`.btn-icon-danger`/`.btn-text-action` de ese mismo archivo. Tabla (`table.tabla` → `.tabla-admin table-compact`) y badges (`.chip`) ya migrados |
| `devoluciones.html` | ✅ **Migrada completa** (ver §11): acción única "Ver detalle" → `.fila-acciones`/`.btn-tabla`. **No** se tocó `.btn-icon` en `devoluciones-gentelella.css` porque esa clase la sigue usando el botón "Quitar" del panel de nota de débito (`ndQuitarItem`), que no es parte del patrón de fila de tabla. Tabla (`table.tabla` → `.tabla-admin`) y badges ya migrados |
| `notas.html` | ✅ **Migrada completa** (ver §11): "Ver" → `.btn-tabla`, "Anular" (condicional, solo si no está anulada) → `.btn-kebab` con menú flotante propio (`menu-acciones-nota`). Tabla (`table.tabla` → `.tabla-admin`) y badges (`.chip`) ya migrados |
| `notas-credito` (pestaña dentro de `facturacion.html`, `js/notas-credito.js`) | ✅ **Corrección importante**: el resumen de la sesión anterior decía que esta pestaña "no tenía lógica de render". Es falso — `renderTablaNC()` sí renderiza y está conectada vía `switchTab('nc')` → `cargarNotasCredito()`. Estaba con el patrón viejo (`.btn-icon` + un `<span class="badge badge-${nc.estado}">` armado a mano con estado crudo, sin CSS que lo resolviera porque `compras.css` —dueño de esas clases— no lo carga `facturacion.html`, el mismo tipo de bug que ya habíamos corregido en el modal de Facturas). Migrado completo: badge vía `estadoInfoNC()` + `ComponentesAdmin.renderBadgeEstado`, acciones a `.fila-acciones`/`.btn-tabla` ("Ver") + `.btn-kebab` ("Emitir a AFIP"/"Ver PDF", condicionales), mismo bug corregido también en el modal de detalle de NC. Eliminé `labelEstadoNC()` (quedó huérfana) |
| `devoluciones.html` | ⏳ Sin tocar |
| `notas.html` / `notas-credito` | ⏳ Sin tocar — además usa tabla agrupada (`tabla-agrupada.js`/`.css`), revisar aparte antes de migrar |

### Hallazgos transversales (recursos compartidos entre páginas, no se tocan página por página — requieren su propia fase)

**#1 — `.btn-tabla`** (resuelto en Fase 0): vivía solo en `compras.css` y llegaba a `cc-proveedores.html` por casualidad porque esa página también carga `compras.css`. Se centralizó en `componentes-admin.css` para que cualquier página lo tenga disponible sin depender de qué otro CSS cargue.

**#2 — `.chip` / `.chip-verde` / `.chip-rojo` / `.chip-amarillo` / `.chip-gris` / `.chip-azul`**: sistema de badge paralelo a `.badge-estado`, definido en `frontend/admin/css/finanzas.css`. No está limitado a la Familia B: lo cargan 13 páginas (`anomalias`, `auditoria`, `avisos`, `cheques`, `cobranzas`, `devoluciones`, `notas`, `notif-log`, `observabilidad`, `puntos`, `riesgo-cheques`, `vencimientos`, `whatsapp-conversaciones`) y se usa en 13 archivos `.js` (incluye páginas fuera de la Familia B, como `pedidos.js`, `rutas.js`, `reglas-precio.js`, `rentabilidad-*.js`, `liquidacion.js`, `gastos-generales.js`, `cobranzas.js`, `rutas-resumen.js`). **Decisión (2026-08-19): no se toca todavía.** Se trata como su propia fase de unificación de badges (candidata a correr junto con o después de la Fase 2/3 del plan original), no como parte de la migración página-por-página de Fase 1.

**#3 — `table.tabla` / `.tabla-header` / `.tabla-overflow` / `.tabla-footer`**: la estructura de tabla que usa Auditoría (`table.tabla`, con wrapper `.tabla-header`/`.tabla-overflow`/`.tabla-footer`) también está definida centralmente en `finanzas.css`, y ese mismo bloque de reglas (`table.tabla th/td`, hover, `.monto`/`.monto-rojo`/`.monto-verde`) se reutiliza explícitamente vía selectores con id (`#vista-devoluciones table.tabla`, `#vista-notas table.tabla`, `#vista-cheques table.tabla`, `#vista-riesgo-cheques table.tabla`, `#vista-vencimientos table.tabla`). Es decir, es la misma situación que `.chip`: un componente de tabla compartido entre varias páginas de la familia "finanzas", no exclusivo de Auditoría. **No se migró a `.tabla-admin` en esta pasada** por la misma razón que `.chip`: hacerlo ahí sin coordinar las otras páginas que comparten `finanzas.css` dejaría el archivo compartido fragmentado a mitad de camino. Queda para tratarse junto con el hallazgo #2, probablemente como una "Fase 1.5" o parte de la Fase 2 (grupo de tabla genérica), en vez de página por página dentro de Fase 1.

**Nota para las próximas páginas de Fase 1** (`cheques`, `devoluciones`, `notas`): es muy probable que compartan los mismos hallazgos #2 y #3 (todas cargan `finanzas.css`). El criterio a aplicar va a ser el mismo: migrar solo el patrón de acciones (`.btn-icon` → `.fila-acciones`/`.btn-tabla`), dejar tabla y badges de `finanzas.css` sin tocar hasta decidir la fase transversal.

---

## 10. Cierre del Hallazgo #2 — `.chip` unificado en el componente canónico (2026-08-19)

**Corrección sobre lo dicho en §9:** el hallazgo #2 original apuntaba a `.chip` en `finanzas.css` (la capa base, compartida por 13 páginas vía ese archivo). Al auditar en detalle apareció un problema **distinto y más chico**: 13 páginas `*-gentelella.css` (más `soporte-gentelella.css`, que resultó ser otro caso) **redeclaraban `.chip` y sus variantes de color con `!important`**, cada una con el mismo shape y los mismos tokens `--ge-*` copiados letra por letra — la verdadera duplicación no era `finanzas.css` en sí, sino su reskin repetido 13 veces. Ese es el problema que se cerró en esta pasada. `finanzas.css` como capa base **no se tocó** — sigue siendo la fuente para páginas no-gentelella — y el hallazgo #3 (`table.tabla`/`.tabla-header`/`.tabla-overflow`/`.tabla-footer`, también en `finanzas.css`) **sigue abierto**, sin relación con este cierre.

**Auditoría previa (antes de escribir una sola línea):**
- 14 archivos con el patrón pill + tokens `--ge-*`: `cheques`, `gastos-generales`, `reglas-precio`, `rutas`, `devoluciones`, `cobranzas`, `notas`, `soporte`, `fidelizacion`, `rentabilidad-producto-vendedor`, `export-contable`, `mercadopago-config`, `facturacion-config`, `vencimientos`.
- **Colisión real de nombres detectada y preservada a propósito:** `.chip-pendiente` es gris (ruta sin asignar) en `rutas.html` y amarillo (regla pendiente de aplicar) en `fidelizacion.html`. No se puede unificar sin cambiar el color de una de las dos páginas — queda definida localmente en ambos archivos, cada uno con un comentario que remite acá, hasta que se decida desambiguar el nombre.
- `pedidos-gentelella.css` quedó **fuera de alcance a propósito**: usa tokens `--color-*` (no `--ge-*`) y conserva el borde doble en vez del pill sólido — es un tercer patrón distinto, no una simple duplicación, y forzar el cambio ahí habría alterado un color real sin confirmarlo antes.
- Dos micro-normalizaciones de píxel, documentadas explícitamente en el CSS canónico (no es regresión silenciosa): peso de fuente 700→600 (`cheques`/`cobranzas` tenían 700, el resto 600) y alpha de rojo .10→.12 (`vencimientos` tenía .10, el resto .12 — diferencia de 2% de opacidad).

**Trabajo realizado — las 14 páginas:**
1. Se agregó la sección `.chip` completa (con todas sus variantes de color y los casos especiales `chip-ok`/`chip-no`/`chip-homo`/`chip-origen-*`) a `frontend/shared/componentes-admin.css`.
2. En cada una de las 14 páginas: se quitó la redeclaración local con `!important` del `*-gentelella.css` correspondiente y se agregó `<link rel="stylesheet" href="/frontend/shared/componentes-admin.css?v=1" />` en el `<head>` del HTML, en la misma posición relativa que ya usaba `facturacion.html` (después de `filtro-tabs.css` cuando la página lo carga; si no, inmediatamente antes del `<link>` a su propio `*-gentelella.css`).
3. **`soporte.html`/`soporte-gentelella.css` — caso aparte:** `.chip-nivel`/`.chip-critico`/`.chip-alto`/`.chip-normal` no se usaban en ningún HTML/JS del proyecto — CSS muerto de una tabla que ya no existe. No se migró: se borró directamente de `soporte-gentelella.css` (y esas clases no entraron al canónico, porque no las usa nadie). Por eso `soporte.html` no tiene el `<link>` nuevo — no le hacía falta.
4. **Hallazgo secundario, encontrado y corregido en el camino — `<style>` inline con colores viejos:** siete páginas (`fidelizacion`, `reglas-precio`, `rentabilidad-producto-vendedor`, `gastos-generales`, `export-contable`, `mercadopago-config`, `facturacion-config`) tienen, además del `*-gentelella.css`, un tercer lugar donde `.chip` estaba definido: un `<style>` inline en el propio HTML (capa pre-reskin), con los mismos nombres de clase pero colores distintos. Antes quedaba tapado por el `!important` de la página; al sacar ese `!important`, si no se limpiaba también el inline, esos colores viejos volvían a ganar (misma especificidad, cargan después en el documento). Se detectó a tiempo y se corrigió en las siete, quitando del inline solo las reglas de `.chip`/variantes (se conservó cualquier propiedad de layout puramente local, como `margin-bottom`/`margin-left` en `mercadopago-config`/`facturacion-config`, que no es parte del componente canónico).
5. **`fidelizacion-gentelella.css` y `rutas-gentelella.css`:** por la colisión de `.chip-pendiente` (punto anterior), estos dos archivos son los únicos de los 14 que conservan una regla `.chip` local — solo esa, todo el resto del set de colores se migró igual que en las otras 12.

**Estado final:** las 14 páginas migradas y verificadas por revisión de código (sin regresión de color: cada variante se comparó contra su valor original antes de moverla). Hallazgo #2 cerrado. Hallazgo #3 (`table.tabla` compartida vía `finanzas.css`) sigue pendiente, sin tocar, para tratarse junto con la Fase 2 del plan original (grupo de tabla genérica) — no se abrió en esta pasada.

---

## 11. Cierre del Hallazgo #3 — `table.tabla` unificada a `.tabla-admin` en Familia B (2026-08-19)

**Alcance de esta pasada:** solo las 4 páginas de Familia B que habían quedado con la migración de tabla/badges pendiente — `auditoria.html`, `cheques.html`, `devoluciones.html`, `notas.html`. Las demás páginas que cargan `finanzas.css` y usan `table.tabla` (`cobranzas`, `notif-log`, `riesgo-cheques`, `vencimientos`, `whatsapp-conversaciones`) **no se tocaron** — quedan para la Fase 2 (grupo de tabla genérica), tal como estaba previsto. `finanzas.css` como archivo tampoco se tocó: sigue siendo la base para esas páginas que aún no migraron.

**Auditoría previa (antes de tocar código):**
- Confirmé que ninguna de las 4 páginas depende de la clase `.tabla` en JS (los `document.querySelector` que aparecían eran sobre `.tabla-wrap`, que no se renombra, o sobre `#vista-notas`/ids, no sobre la clase de la tabla).
- `cheques-gentelella.css` no selecciona nada vía `.tabla`/`table.tabla` — usa `.tabla-wrap thead th` y `#tbody-cheques td`, scoping que no depende del nombre de clase de la tabla. Por eso `cheques.html` fue la migración de menor riesgo del grupo.
- `auditoria-gentelella.css`, `devoluciones-gentelella.css` y `notas-gentelella.css`, en cambio, sí seleccionan directamente vía `.tabla th` / `.tabla td` / `.tabla tbody tr:hover td` — estas SÍ había que renombrar en paralelo al cambio de clase en el HTML, o el estilo gentelella (colores, hover, padding) se habría dejado de aplicar.
- Encontré una dependencia no obvia: `table.tabla .monto`/`.monto-rojo`/`.monto-verde` en `finanzas.css` le daba a los montos `font-family: monospace` y `font-size: 13px` **scopeado a `table.tabla`** — `cheques-gentelella.css` y `notas-gentelella.css` ya pisan color/peso de `.monto` con `!important`, pero no font-family ni tamaño, así que sin este ajuste los montos hubieran perdido la tipografía monoespaciada al dejar de estar dentro de una `table.tabla`.
- `.tabla-footer`/`.tabla-footer-paginacion` de `auditoria.html` **no** viene de `finanzas.css` (a diferencia de lo que decía el hallazgo original) — está definido inline en el propio HTML, igual que en `whatsapp-conversaciones.html` y `notif-log.html`. No es parte de este cierre; queda anotado como una posible cuarta duplicación menor a mirar en otra pasada, sin urgencia (`cheques`/`devoluciones`/`notas` no paginan, no lo necesitan).

**Trabajo realizado:**
1. Se agregó `.monto`/`.monto-rojo`/`.monto-verde` (base, sin scope de tabla) a `frontend/shared/componentes-admin.css`, con los mismos valores que tenía `table.tabla .monto` en `finanzas.css`.
2. `auditoria.html`: las dos `<table class="tabla">` (Registro de cambios, Eventos de negocio) → `<table class="tabla-admin">`. Se agregó el `<link>` a `componentes-admin.css` (era la única de las 4 que todavía no lo tenía, porque en el Hallazgo #2 no le tocaba ningún `.chip`). En `auditoria-gentelella.css` se renombraron los 5 selectores `.tabla th/td/tbody tr:last-child td/tbody tr:hover td/tbody tr:hover .col-sticky-end` → `.tabla-admin ...`.
3. `cheques.html`: `<table class="tabla table-compact">` → `<table class="tabla-admin table-compact">`. Sin cambios en `cheques-gentelella.css` (no tenía selectores `.tabla` que renombrar, ver auditoría previa).
4. `devoluciones.html`: `<table class="tabla">` → `<table class="tabla-admin">`. En `devoluciones-gentelella.css` se renombraron los 7 selectores `.tabla th/td/...` (incluye un segundo bloque de densidad más abajo en el archivo) → `.tabla-admin ...`.
5. `notas.html`: `<table class="tabla">` → `<table class="tabla-admin">`. En `notas-gentelella.css` se renombraron los 5 selectores `.tabla th/td/...` → `.tabla-admin ...`.
6. En los tres archivos CSS de página se tuvo cuidado de **no tocar** `.tabla-wrap`, `.tabla-header` ni `.tabla-footer` (son clases distintas, ninguna se renombra) — solo los selectores donde `.tabla` era la tabla misma.

**Estado final:** Familia B (`facturacion`, `auditoria`, `cheques`, `devoluciones`, `notas`, `notas-credito`) queda **100% migrada** — tabla, badges y patrón de acciones, las tres capas del plan original. Hallazgo #3 cerrado **para estas 4 páginas puntualmente**; como componente compartido en `finanzas.css` para el resto de sus consumidoras (`cobranzas`, `notif-log`, `riesgo-cheques`, `vencimientos`, `whatsapp-conversaciones`), sigue abierto y se aborda en la Fase 2.

**Próximo paso sugerido (histórico, ya en curso):** con Familia B cerrada del todo, lo que sigue según el plan original es la **Fase 2** (14 páginas con `<table class="tabla">` sin estructura compartida real: `comparador-precios`, `compras`, `conciliacion-bancaria`, `export-contable`, `gastos-generales`, `notif-log`, `puntos`, `reglas-precio`, `rentabilidad-producto-vendedor`, `rentabilidad-zona`, `riesgo-cheques`, `vencimientos`, `whatsapp-conversaciones`, `fidelizacion`) — varias de estas ya tienen el `.chip` migrado (Hallazgo #2) pero no la tabla.

---

## 12. Avance de Fase 2 (grupo de tabla genérica `tabla`) — orden de menor a mayor riesgo

Orden elegido: (1) `comparador-precios`, `conciliacion-bancaria`, `rentabilidad-zona` — 1 tabla simple, sin `componentes-admin.css` todavía; (2) `notif-log`, `riesgo-cheques` — sobre `finanzas.css`; (3) `export-contable`, `reglas-precio`, `rentabilidad-producto-vendedor`, `gastos-generales` — ya con el link parcial (chip); (4) `whatsapp-conversaciones`, `fidelizacion`, `vencimientos`, `puntos` — múltiples tablas; (5) `compras` — tablas anidadas, último por ser el más riesgoso.

**Hallazgo #4 — `table.tabla th, table.tabla td` en `reportes.css`:** este archivo base (compartido por 11 páginas: las 3 de `reportes-*`, que usan `ranking-table` y no les aplica, más `comparador-precios`, `conciliacion-bancaria`, `export-contable`, `fidelizacion`, `gastos-generales`, `reglas-precio`, `rentabilidad-producto-vendedor`, `rentabilidad-zona`, que sí usan/usaban `table.tabla`) define un padding/font-size compacto (`9px 12px`/`12.5px`) scopeado a `table.tabla`. Es la misma situación que los Hallazgos #2/#3 (componente compartido en un CSS base, no exclusivo de una página). **No se toca todavía** — al migrar cada página el selector queda simplemente huérfano/sin efecto (no genera regresión, solo CSS muerto), y se decide en bloque si conviene mover ese ajuste de densidad a `componentes-admin.css` (como modificador) recién cuando se termine el grupo de páginas que comparten `reportes.css`, para no fragmentar el archivo a mitad de camino.

| Página | Estado |
|---|---|
| `comparador-precios.html` | ✅ **Migrada** (2026-08-19): ambas tablas (`vista-ranking`, `vista-detalle`) `table.tabla` → `table.tabla-admin`. Agregado `<link>` a `componentes-admin.css` (no lo tenía, no le tocó ningún `.chip` en el Hallazgo #2 porque esta página no usa badges). En `comparador-precios-gentelella.css` se renombraron los 5 selectores `.tabla th/td/tbody tr:last-child td/tbody tr:hover td/tbody tr.clickable` → `.tabla-admin ...` (con `!important`, se mantiene el patrón de reskin). Confirmado por auditoría de JS que nada depende de la clase `.tabla` (solo usa `#tbody-ranking`/`#tbody-detalle` por id). Se encontró y limpió un tercer lugar con la definición vieja: un `<style>` inline pre-reskin en el propio HTML que redeclaraba `.tabla`/`.tabla th`/`.tabla td` completo — se borró, preservando la única propiedad genuinamente distinta que tenía (`white-space:nowrap` en los `th`, para que los encabezados largos no rompan línea), migrada a `comparador-precios-gentelella.css` con comentario explicando su origen. Hallazgo #4 (`reportes.css`) detectado en el camino, documentado arriba, no resuelto todavía (queda huérfano sin causar regresión). |
| `conciliacion-bancaria.html` | ⏳ Sin tocar — siguiente |
| `rentabilidad-zona.html` | ✅ **Migrada** (2026-08-19): ambas tablas (`vista-zona`, `vista-ruta`) `table.tabla` → `table.tabla-admin`. Agregado `<link>` a `componentes-admin.css`. En `rentabilidad-zona-gentelella.css` se renombraron los 6 selectores (`th`/`td`/`tbody tr:last-child`/`tbody tr:hover`/`tr.zona-mejor`/`tr.zona-peor`) → `.tabla-admin ...`. `white-space:nowrap` del thead preservado igual que en las 2 anteriores. JS confirmado sin dependencia de `.tabla` (solo agrega clases `zona-mejor`/`zona-peor` al `<tr>` por lógica de negocio). **Falsa alarma descartada:** el `<style>` inline tenía `.zona-mejor`/`.zona-peor` sueltas (sin `.tabla`) pintando el `<tr>`, que en un primer vistazo parecía duplicar la regla ya renombrada en el gentelella — pero apuntan a elementos distintos (`tr` vs `tr td`), no compiten, y el `td` (que pinta encima) es el que ya se veía. No requirió cambio; documentado para no reabrirlo. |
| `notif-log.html` | ✅ **Migrada** (2026-08-19): `table.tabla` → `table.tabla-admin`. Agregado `<link>` a `componentes-admin.css` (no lo tenía). Esta página carga `finanzas.css` (no `reportes.css`), así que aplica el Hallazgo #3 real: `table.tabla th/td` de `finanzas.css` (padding `10px 16px`/`11px 16px`, `white-space:nowrap` en `th`) quedaba huérfano al renombrar — se preservaron esos 3 valores explícitamente en `notif-log-gentelella.css` (mismo criterio que se usó en auditoria/cheques/devoluciones/notas). Confirmé que `notif-log` **no** está en la lista de páginas con scoping por id (`#vista-riesgo-cheques table.tabla`, etc.) de `finanzas.css` — esa lista es para Fase 2 más adelante (`riesgo-cheques`, `vencimientos`). JS confirmado sin dependencia de `.tabla`. Se encontró un tercer lugar con reglas viejas: `<style>` inline con `.tabla td{font-size}` (redundante, se quitó) y `.tabla tr.fila-notif:hover td` (redundante con el gentelella, se quitó) — se conservó solo `cursor:pointer` en `.tabla-admin tr.fila-notif`, que no forma parte del componente canónico. La regla mobile compacta de `finanzas.css` (`@media 600px: table.tabla th/td{padding:9px 12px}`) queda huérfana sin compensar, mismo criterio ya aceptado en Familia B (auditoria tampoco la compensó). |
| `riesgo-cheques.html` | ⏳ Sin tocar — siguiente (tiene scoping por id en `finanzas.css`: `#vista-riesgo-cheques table.tabla`, hay que migrar ese bloque también) | |
| `riesgo-cheques.html` | ✅ **Migrada** (2026-08-19): `table.tabla` → `table.tabla-admin`. Agregado `<link>` a `componentes-admin.css`. A diferencia de `notif-log`, acá `riesgo-cheques-gentelella.css` **ya** traía `padding`/`white-space:nowrap` explícitos con `!important` en `th`/`td` — eso ya ganaba por sobre el `table.tabla`/`#vista-riesgo-cheques table.tabla` (sin `!important`) de `finanzas.css` desde antes de esta migración (un `!important` siempre gana sobre uno sin `!important`, sin importar especificidad), así que renombrar la clase no cambió ningún valor visual, solo dejó huérfano el bloque de `finanzas.css` (que ya era inactivo en la práctica). Se detectó `.modal-box .tabla` en `riesgo-cheques-gentelella.css` (líneas 446-454): **CSS ya muerto de antes**, no hay ningún `<table class="tabla">` dentro de un modal en el HTML — no se tocó, no lo generó esta migración, queda anotado para la limpieza de Fase 5. JS confirmado sin dependencia de `.tabla`, sin `<style>` inline con `.tabla`. |
| `export-contable.html` | ⏳ Sin tocar (tabla) — chip ya migrado |
| `reglas-precio.html` | ⏳ Sin tocar (tabla) — chip ya migrado |
| `rentabilidad-producto-vendedor.html` | ⏳ Sin tocar (tabla) — chip ya migrado |
| `gastos-generales.html` | ⏳ Sin tocar (tabla) — chip ya migrado |
| `whatsapp-conversaciones.html` | ⏳ Sin tocar |
| `fidelizacion.html` | ⏳ Sin tocar |
| `vencimientos.html` | ⏳ Sin tocar |
| `puntos.html` | ⏳ Sin tocar |
| `compras.html` | ⏳ Sin tocar — última, tablas anidadas |

---

## 13. Avance de Fase 3 (páginas con nombre de clase propio) — piloto `usuarios.html`

**Por qué `usuarios.html` primero:** de las páginas de Fase 3, es la de menor riesgo — una sola tabla, sin paginación, sin columnas de negocio realmente únicas (nombre/email/rol/teléfono/estado/acciones), y a diferencia de `cc-proveedores` (piloto de Fase 0), acá ni `componentes-admin.css` ni `componentes-admin.js` estaban cargados todavía. Sirve para probar el patrón antes de encarar `cajas` (`tabla-historial`), `rutas`/`proveedores` (`tabla-main` compartida con `compras.css`, no aisladas) y la colisión de nombres en `tabla-main`.

**Auditoría previa (antes de tocar código):**
- `usuarios.html` carga `compras.css` (igual que `cc-proveedores` en Fase 0) y por eso hereda dos cosas "por casualidad": el estilo de `.tabla-main` y la regla `@media (max-width:768px)` de `table-responsive-cards` **scopeada a `.tabla-main`** en ese mismo archivo — un componente compartido más, mismo patrón que los Hallazgos #1/#3/#4, acá numerado **Hallazgo #5**.
- Confirmé qué otras páginas siguen usando `.tabla-main` (`compras`, `proveedores`, `rutas`, `vencimientos`) — ninguna de las cuatro se toca en esta pasada, así que la regla de `compras.css` no se puede tocar ni renombrar, solo generalizar en paralelo en el componente canónico.
- `usuarios-gentelella.css` traía **su propia redeclaración local de `.badge-estado`/`.badge-ok`/`.badge-inactivo`** (con `!important`) y de un botón de acción propio (`.btn-fila-accion`, sin kebab) — no listada en el diagnóstico original de "11 archivos con `.badge-estado`" del §0, pero es exactamente el mismo problema: esta pantalla no cargaba ningún CSS que definiera esas clases, así que se había inventado las suyas.
- Revisé `usuarios.js`: la única dependencia de nombre de clase para lógica (no solo estilo) era el delegado de clicks (`ev.target.closest('.btn-fila-accion')`) y el filtro de test (`data-testid="usuario-fila"`, `data-accion`) — este último no se toca, es independiente del nombre de clase visual.
- Revisé `tests/e2e/page-objects/admin/usuarios.page.js`: selecciona filas por `data-testid`/`data-id` y acciones por `data-accion` — ninguno de los dos depende de `.btn-fila-accion` ni de `.tabla-main`, así que el cambio de clases no rompe los tests e2e existentes.
- La tabla no tenía atributos `data-label` en ningún `<td>` pese a ya usar `table-responsive-cards` — el mobile-card view ya estaba roto de antes (los `<td>` colapsaban sin etiqueta). Se corrige como parte de esta migración, no es un cambio fuera de alcance: es justamente lo que el checklist de riesgos (§6) pide "preservar", solo que acá no había nada que preservar todavía.

**Trabajo realizado:**
1. `usuarios.html`: `<table class="tabla-main">` → `<table class="tabla-admin">`. Agregado `<link>` a `componentes-admin.css` (antes de `usuarios-gentelella.css`) y `<script>` a `componentes-admin.js` (antes de `usuarios.js`, orden requerido porque `usuarios.js` ahora llama a `ComponentesAdmin.*`).
2. `usuarios.js`: badge de Estado → `ComponentesAdmin.renderBadgeEstado(...)`; celda de Acciones → `ComponentesAdmin.renderFilaAcciones([...])` (sin kebab — máximo 2 acciones primarias, "Editar" + "Desactivar/Reactivar", no necesita menú); el caso especial "Solo el dueño" (fila no editable por permisos) se preservó tal cual, fuera del helper. Se agregó `data-label` a las 6 celdas (`Nombre`/`Email`/`Rol`/`Teléfono`/`Estado`/`Acciones`) para que las cards mobile funcionen. Delegado de clicks actualizado de `.btn-fila-accion` a `.btn-tabla` (los `data-accion`/`data-id` que usan los tests no cambiaron).
3. `usuarios-gentelella.css`: renombrados los 5 selectores `.tabla-main ...` → `.tabla-admin ...`. Eliminado el bloque local de `.badge-estado`/`.badge-ok`/`.badge-inactivo` y el de `.btn-fila-accion` (reemplazados por el canónico). `.col-sticky-end` con color de fondo propio se conservó (es ajuste legítimo de esta página, ya cubierto por la regla general de `reskin-patch.css`).
4. **Hallazgo #5 cerrado para esta página:** se agregó a `componentes-admin.css` la versión generalizada de la regla `table-responsive-cards` (antes solo existía para `.tabla-main` en `compras.css`), con la primera columna y `td[data-label="Acciones"]` a ancho completo sin etiqueta — igual que el caso "Proveedor"/"Acciones" de `compras.css`, pero resuelto de forma genérica (por posición, no por texto literal) para que sirva a cualquier página futura sin tener que listar el nombre de su primera columna. La regla de `compras.css` scopeada a `.tabla-main` **no se tocó** — sigue siendo necesaria para `compras`/`proveedores`/`rutas`/`vencimientos`.

**Verificación:** `node --check` sobre `usuarios.js` sin errores. Sin referencias residuales a `.tabla-main`/`.btn-fila-accion` en HTML/JS/CSS de la página (solo queda mencionado en un comentario explicativo). Confirmado que `tests/e2e/page-objects/admin/usuarios.page.js` no depende de ninguna clase renombrada (usa `data-testid`/`data-id`/`data-accion`).

**Nota de color:** el badge canónico usa tokens genéricos (`--color-success`/`--color-bg`) en vez de los tokens teal de gentelella que usaba la redeclaración local — mismo criterio de normalización ya aceptado y documentado en el cierre del Hallazgo #2 (§10): es una diferencia de paleta menor y a propósito, no una regresión.

**Estado:** `usuarios.html` migrada completa (tabla + badges + acciones + responsive cards). Próxima página sugerida de Fase 3: definir si seguir con `cajas.html` (`tabla-historial`, sin compartir CSS con otras) o con el grupo `tabla-main` real (`proveedores`/`rutas`/`vencimientos`/`compras`, que ahora sí pueden aprovechar el Hallazgo #5 recién generalizado al migrar).

---

## 14. Avance de Fase 3 — `proveedores.html` (grupo `tabla-main` real, 2026-08-19)

**Decisión del usuario:** `cajas.html` queda afuera por ahora. Se sigue con el grupo que de verdad comparte `.tabla-main` vía `compras.css` — arrancando por `proveedores.html`.

**Diferencia clave con `usuarios.html`:** acá `.tabla-main` (y `.badge`/`.acciones-td`/`.btn-tabla`) **no** son una invención aislada de esta página — están definidos en `compras.css`, el mismo archivo base que cargan `compras.html` y `vencimientos.html` (y que ya cargaba `cc-proveedores.html`, migrada en Fase 0). Tocar esas clases acá sin coordinar afectaría a páginas que todavía no migraron. El precedente ya existe: `cc-proveedores` (Fase 0) migró **solo la tabla** a `.tabla-admin` y dejó su sistema de badges propio (`.badge-fx`/`.badge-pagada`) sin tocar. Se repite exactamente ese criterio acá.

**Auditoría previa:**
- `proveedores.html` tiene **dos tablas reales**, no una: el listado principal (`tabla-wrap table-responsive-cards`, con `data-label` ya presentes en el JS — a diferencia de `usuarios.html`, acá el mobile-card view ya funcionaba) y un panel secundario "Links de acceso activos — Portal proveedor" (`#tabla-links-activos`, sin `table-responsive-cards`, solo `overflow-x:auto`, sin `data-label` — no usa el patrón de cards, y no se le agrega: no estaba roto, es una decisión de diseño existente para una tabla ancha de solo-lectura).
- El botón de acciones de `proveedores.js` **ya usa `.btn-tabla`** (no `.btn-fila-accion` como usuarios) — no hizo falta tocar nada ahí. Las 4 acciones por fila (Editar/Compras/Portal/Dar de baja-Activar) están envueltas en `.acciones-td`, definido en `compras.css`, compartido con `compras.html` — **no se renombra a `.fila-acciones`** en esta pasada por la misma razón que no se toca `.badge`.
- El badge de Estado usa `.badge`/`.badge-activo`/`.badge-inactivo` (no `.badge-estado`) — es un **tercer sistema de badge** distinto de `.chip` (Hallazgo #2, en `finanzas.css`) y del `.badge-estado` canónico, definido en `compras.css` y compartido por `compras.html`/`vencimientos.html` además de `proveedores.html`. **Nuevo hallazgo transversal — Hallazgo #6** (documentado abajo), no se resuelve en esta pasada.
- `compras.css` tenía un bloque `#vista-compras .tabla-main th/td/tbody tr:hover, #vista-proveedores .tabla-main th/td/tbody tr:hover { ... }` con selectores combinados por coma — hubo que **separarlo**: se sacó `#vista-proveedores` del selector combinado (ya no aplica, la tabla dejó de ser `.tabla-main`) y se dejó `#vista-compras` solo, con un comentario explicando la migración — mismo patrón textual que el comentario que ya existía para `#vista-cc-proveedores` en el mismo archivo.
- Confirmé que `proveedores.js` no depende de `.tabla-main` para lógica (el único `querySelector` relevante es sobre `.tabla-wrap`, que no cambia de nombre) y que `tests/e2e/page-objects/admin/proveedores.page.js` selecciona filas por `data-testid="proveedores-fila"`/`data-id`, no por clase de tabla.

**Trabajo realizado:**
1. `proveedores.html`: las dos `<table class="tabla-main">` → `<table class="tabla-admin">`. Agregado `<link>` a `componentes-admin.css` (no se agregó `componentes-admin.js`: esta pasada no usa `ComponentesAdmin.render*`, porque badge/acciones quedan deferidos al Hallazgo #6).
2. `proveedores-gentelella.css`: renombrados los 5 selectores `.tabla-main ...` → `.tabla-admin ...`. El selector por id `#tabla-links-activos { margin-top: 4px }` no se tocó (no depende del nombre de la clase de tabla). `.badge`/`.badge-activo`/`.badge-inactivo`/`.acciones-td`/`.btn-tabla` **no se tocaron**, mismo criterio que compras.css.
3. `compras.css`: separado el bloque combinado `#vista-compras`/`#vista-proveedores` de `.tabla-main th/td/tbody tr:hover` — queda solo `#vista-compras` (compras.html sigue sin migrar), con comentario documentando la migración de `#vista-proveedores` al canónico. La regla `table-responsive-cards .tabla-main` (necesaria para `compras`/`rutas`/`vencimientos`) queda intacta — `proveedores.html` ahora usa la versión generalizada para `.tabla-admin` agregada a `componentes-admin.css` en el cierre del Hallazgo #5 (§13).
4. No se tocó `.badge`, `.acciones-td`, `.btn-tabla` (ya canónico de nombre, sin cambios) ni el panel de links activos (tabla ancha de solo lectura, sin card-view, fuera de alcance del Hallazgo #5).

**Verificación:** `node --check` sobre `proveedores.js` sin errores (no se modificó). Cero ocurrencias de `tabla-main` en `proveedores.html` tras la migración. `tabla-agrupada.css` (cargado por esta página, para otro componente) no referencia `.tabla-main`/`.tabla-admin`, sin conflicto. `tests/e2e/page-objects/admin/proveedores.page.js` no depende de clases renombradas.

**Hallazgo #6 — `.badge`/`.badge-activo`/`.badge-inactivo` (+ variantes de compras: `.badge-borrador`, `.badge-enviada`, etc.) y `.acciones-td`, definidos en `compras.css`:** sistema de badge y de wrapper de acciones compartido por `compras.html`, `proveedores.html` y parcialmente `vencimientos.html` (que además define sus propias `.badge-warn`/`.badge-muted` encima). Misma clase de problema que los Hallazgos #2 (`.chip`) y #3 (`table.tabla`): un componente reutilizado vía un CSS base compartido, no exclusivo de una página. A diferencia de `.chip`, acá no hay `!important` duplicado 13 veces — es una sola fuente, ya razonablemente ordenada — así que no es urgente, pero requiere coordinar `compras.html`/`vencimientos.html` a la vez para migrarlo a `.badge-estado`/`.fila-acciones`. Candidato a tratarse junto con `compras.html` (última del grupo, la más riesgosa) o como fase aparte — a decidir cuando se llegue ahí.

**Estado:** `proveedores.html` — tabla migrada a `.tabla-admin` en ambas tablas. Badges y acciones quedan con su nombre actual (`.badge`/`.acciones-td`), documentado como Hallazgo #6, no resuelto todavía.

---

## 15. Avance de Fase 3 — `rutas.html` (pestaña Zonas, 2026-08-19)

**Alcance acotado, y por qué:** `rutas.html` tiene **5 tablas**, pero solo una es del grupo que se está migrando: la pestaña "Zonas" (`tabla-main`, listado simple de zonas con Editar/Dar de baja — mismo patrón que `usuarios`/`proveedores`). Las otras 4 usan `.rutas-table`, un componente propio del workspace de "Armar ruta" (selección/armado de reparto, no un listado genérico) — **no se toca**, mismo criterio que `pos.html` en el plan original (§4, Fase 4): no se fuerza el patrón canónico donde no corresponde funcionalmente. Es un caso a evaluar aparte si en algún momento se decide unificarlo, no en esta pasada.

**Auditoría previa:**
- El render de la tabla de Zonas vive en `zonas.js` (no en `rutas.js` — son dos archivos distintos que rutas.html carga juntos), y ya usa exactamente el mismo patrón que `proveedores.js`: `.badge`/`.badge-activo`/`.badge-inactivo`, `.acciones-td`, `.btn-tabla`, `data-label` ya presentes. Mismo Hallazgo #6, mismo criterio: se deja sin tocar en esta pasada.
- `rutas.html` **ya cargaba `componentes-admin.css`** (quedó linkeado desde antes, probablemente por trabajo previo de Fase 1/2 en otra página de esta familia) — no hizo falta agregar el `<link>`.
- `rutas-gentelella.css` no tiene ninguna regla de `.tabla-main` — la pestaña Zonas nunca tuvo reskin propio para su tabla, corría con el `.tabla-main` "pelado" de `compras.css`. Al pasar a `.tabla-admin` pasa a heredar la base canónica en vez de la de `compras.css`, que es exactamente el comportamiento esperado (antes esta tabla ni siquiera tenía el tema gentelella aplicado).
- Sí aparecían referencias a `.tabla-main` en **dos archivos que no había tocado antes**: `rutas-compact.css` (2 reglas, dentro de un media query mobile que agrupa `.tabla-main`/`.rutas-table` para densidad y header sticky — se renombró solo el token `.tabla-main`, `.rutas-table` se dejó intacto) y `rutas-professional.css` (1 regla, un selector combinado que le da `border-color`/`box-shadow` junto a otras tarjetas del route builder — mismo tratamiento).
- No hay ningún `#vista-zonas`/`#vista-rutas .tabla-main` scoping en `compras.css` que hubiera que separar (a diferencia de `proveedores`) — la pestaña Zonas no tiene un bloque dedicado ahí.
- Confirmé que `zonas.js`/`rutas.js` no tienen sintaxis rota (`node --check` OK) y que `tests/e2e/page-objects/admin/rutas.page.js` no referencia `.tabla-main`/`.acciones-td`/`.btn-tabla`.

**Trabajo realizado:**
1. `rutas.html`: la única `<table class="tabla-main">` (pestaña Zonas) → `<table class="tabla-admin">`. Comentario del `<head>` actualizado para no seguir mencionando `.tabla-main` como parte de lo que aporta `compras.css` a esta página.
2. `rutas-compact.css`: renombradas las 2 apariciones de `.tabla-main` → `.tabla-admin` (sticky header + padding compacto en mobile), sin tocar las reglas hermanas de `.rutas-table`.
3. `rutas-professional.css`: renombrada la aparición de `.tabla-main` → `.tabla-admin` en el selector combinado de `border-color`/`box-shadow`.
4. No se tocó `zonas.js` (badge/acciones quedan en Hallazgo #6, igual que `proveedores.js`) ni ninguna de las 4 `.rutas-table`.

**Verificación:** cero ocurrencias de `.tabla-main` en `rutas.html`/`rutas-compact.css`/`rutas-professional.css`/`zonas.js`/`rutas.js` (solo quedaba, y se corrigió, un comentario). `node --check` OK en ambos JS (sin modificar). `tests/e2e/page-objects/admin/rutas.page.js` no depende de las clases tocadas.

**Estado:** `rutas.html` — pestaña Zonas migrada a `.tabla-admin`. Las 4 tablas `.rutas-table` del workspace de armado de rutas quedan fuera de alcance a propósito (componente propio, no listado genérico — ver nota arriba). Badge/acciones de Zonas quedan en Hallazgo #6, sin resolver, igual que `proveedores.html`.

---

## 16. Cierre del Hallazgo #6 (parte 1) — `vencimientos.html` (Lotes) y `zonas.js` (2026-08-19)

**Alcance:** las dos páginas más simples del Hallazgo #6 — tabla de Lotes en `vencimientos.html` y la pestaña Zonas de `rutas.html` (`zonas.js`, ver §15). Ninguna de las dos necesita menú "⋮": Lotes tiene como máximo 3 acciones por fila pero se resuelven condicionalmente (nunca más de 2 visibles a la vez — Editar + Dar de baja *o* Eliminar, según `cantidad`), y Zonas tiene solo 2 acciones fijas. Se migran directo a `ComponentesAdmin.renderBadgeEstado`/`renderFilaAcciones` sin segundo parámetro de kebab.

**Trabajo realizado:**
1. `vencimientos.html`: tabla de Lotes `.tabla-main` → `.tabla-admin`, scopeada por panel (`#vista-vencimientos`) para no colisionar con la tabla de Ofertas del mismo documento (que no forma parte de este Hallazgo — la renderiza `liquidacion.js`, sin badge ni `.acciones-td`, queda intacta).
2. `lotes.js`: `badgeEstado()` reescrito sobre `ComponentesAdmin.renderBadgeEstado` (mapeo `activo→ok`, `por_vencer→warning`, `vencido→critico`, `agotado→inactivo`) y la celda de acciones sobre `ComponentesAdmin.renderFilaAcciones([...].filter(Boolean))`, preservando las condiciones de permiso (`esEscritor`) y de negocio (`cantidad > 0` vs `== 0`) que ya tenía.
3. `zonas.js`: mismo patrón — `renderBadgeEstado('Activa'/'Inactiva', ...)` + `renderFilaAcciones([Editar, Dar de baja | Activar])`, sin kebab.

**Verificación:** `node --check` limpio en ambos JS. Cero referencias activas a `.badge`/`.badge-activo`/`.badge-inactivo`/`.badge-warn`/`.badge-muted`/`.btn-acc`/`.acciones-td` fuera de comentarios en las dos páginas migradas. `tests/e2e/page-objects/admin/vencimientos.page.js` y `rutas.page.js` no dependen de ninguna clase tocada (cero coincidencias).

**Nota de deuda encontrada y corregida en esta pasada:** los bloques `#vista-vencimientos .tabla-main`/`.badge`/`.badge-warn`/`.badge-muted` de `compras.css` habían quedado sin comentar en un pase anterior — se cerraron recién en §18, junto con el resto del CSS huérfano del Hallazgo #6 (ver abajo).

---

## 17. Cierre del Hallazgo #6 (parte 2) — `proveedores.html`/`proveedores.js` (badge canónico + menú "⋮", 2026-08-19)

**Diferencia con el punto anterior:** acá sí hacen falta más de 2 acciones por fila (Editar / Compras / Portal / Dar de baja-Activar), así que se usa el mismo patrón "2 primarias + kebab" ya validado en Cheques/Notas de crédito: **Editar** queda visible siempre, la segunda acción visible es **Dar de baja**/**Activar** según estado, y **Compras**/**Portal** se mueven a un menú flotante `#menu-acciones-proveedor` (compartido por todas las filas, reposicionado por JS al abrir — mismo mecanismo que Cheques).

**Trabajo realizado:**
1. `proveedores.js`: badge de Estado → `ComponentesAdmin.renderBadgeEstado('Activo'/'Inactivo', 'ok'/'inactivo')`. Celda de acciones armada **a mano** (`<span class="fila-acciones">...</span>`), no con el segundo parámetro (`kebab`) de `renderFilaAcciones` — ver nota de implementación abajo. Agregado el manejador del menú flotante (abrir/cerrar, click-fuera, reposicionamiento) siguiendo el mismo código que ya tenía Cheques.
2. `proveedores.html`: agregado el contenedor `<div class="dropdown-menu" id="menu-acciones-proveedor" role="menu" hidden>` (mismo patrón que `#menu-acciones-cheque`).
3. `proveedores-gentelella.css`: retirado el bloque local `.badge`/`.badge-activo`/`.badge-inactivo` (huérfano, ya no matchea nada en esta pantalla — el badge canónico no trae override de color acá, mismo criterio aceptado en `usuarios-gentelella.css`, §13). `.btn-tabla` se conserva con su reskin teal. `.btn-kebab`/`.dropdown-menu`/`.dropdown-item` no llevan override local — el estilo neutro de `componentes-admin.css` alcanza.
4. `tests/e2e/page-objects/admin/proveedores.page.js`: actualizado — `botonMenuCompras()`/`botonMenuPortal()` + `abrirMenuAcciones(id)` nuevos; `irAComprasFila()`/`abrirPortalFila()` ahora abren el kebab primero. Se corrige así la regresión e2e que había quedado pendiente de una sesión anterior (los métodos viejos `botonPortal()`/`botonCompras()` ya no existen en ningún spec).

**Nota de implementación (por qué no se usa el parámetro `kebab` de `renderFilaAcciones`):** ese segundo parámetro genera un botón con `class="btn-kebab"` fijo; como esta página necesita una segunda clase propia (`btn-kebab-prov`, para scopear el delegado de clicks del menú sin pisar el de Cheques) y `renderFilaAcciones` no soporta agregar una clase extra al kebab sin duplicar el atributo `class` en el HTML resultante, se arma la fila a mano — mismo criterio que ya usaban Cheques/Notas de crédito antes de que existiera el helper.

**Verificación:** `node --check` limpio en `proveedores.js`. Cero referencias activas a `.badge`/`.badge-activo`/`.badge-inactivo`/`.acciones-td` fuera de comentarios en `proveedores.html`/`proveedores.js`/`proveedores-gentelella.css`. `proveedores.spec.js` solo usa `abrirPortalFila()` (ya actualizado). Confirmado contra `compras.css`: `.acciones-td`/`.badge` seguían siendo necesarios ahí porque `compras.html` (§18) todavía no había migrado en el momento de este cierre.

**Estado del Hallazgo #6 tras §16+§17:** resuelto en `vencimientos.html`, `zonas.js` y `proveedores.html`. Queda solo `compras.html` — la última página del grupo, y la más riesgosa por las tablas anidadas de sus modales (ítems de OC, detalle, diff OCR, recepción). Se cierra en §18.

---

## 18. Cierre del Hallazgo #6 (parte 3, final) — `compras.html` (2026-08-19)

**Auditoría previa:**
- Una sola tabla real a migrar: el listado de OC (`.tabla-main`, listado principal). Las 4 `.inner-tabla` dentro de modales (ítems de OC, detalle, diff OCR, recepción) son tablas editables de formulario, no listados — mismo criterio ya aplicado a `.rutas-table` (§15): quedan fuera de alcance.
- Badge de estado con 7 variantes propias (`badge-borrador`/`pendiente_aprobacion`/`enviada`/`confirmada`/`recibida_parcial`/`recibida`/`cancelada`), con reskin gentelella propio. **Decisión: queda local, sin unificar al canónico** — `VARIANTES_VALIDAS` no tiene una variante violeta para `pendiente_aprobacion`, y mapear `recibida_parcial` al canónico le cambiaría el color de naranja a azul (regresión real de color). Mismo tipo de colisión que `.chip-pendiente` (Hallazgo #2) y que `.badge-fx` de `cc-proveedores` (Fase 0).
- Acciones de fila: hasta 3 botones simultáneos, nunca más — mapean a "2 primarias + kebab" (Ver + acción principal según estado, con Eliminar/Cancelar al menú "⋮").
- Sin riesgo e2e: `compras.page.js`/`compras.spec.js` no testean ningún botón de fila (documentado explícitamente como fuera de cobertura: "NO cubre Recepcionar/Aprobar").
- `.btn-tabla`/`.primario`/`.peligro` de `compras.css` son la base compartida activa (Proveedores/Vencimientos/Zonas ya la consumen) — no se tocan.

**Trabajo realizado:**
1. `compras.html`: `<link>` a `componentes-admin.css` + `<script>` a `componentes-admin.js`; tabla → `.tabla-admin`; agregado contenedor `#menu-acciones-oc` del kebab.
2. `compras.js`: nueva `renderAccionesOC()` armada a mano (mismo motivo que proveedores.js en §17 — el kebab de `renderFilaAcciones` no soporta una segunda clase, y acá hace falta `btn-kebab-oc` para scopear el delegado de clicks) + `iniciarMenuAccionesOC()` para el menú flotante. Badge queda intacto (sistema local, decisión documentada arriba).
3. `compras.css` / `compras-gentelella.css`: renombrados los selectores de tabla activos a `.tabla-admin`. Comentados (sin borrar) todos los bloques que quedan huérfanos tras el cierre de este Hallazgo:
   - Bloque base `.tabla-main`/`.acciones-td` (único consumidor real que quedaba: `compras.html`).
   - Bloque responsive `.table-responsive-cards .tabla-main` (el equivalente para `.tabla-admin` ya está generalizado en `componentes-admin.css` desde el cierre del Hallazgo #5, §13).
   - `#vista-compras .tabla-main` (el `#vista-proveedores` hermano ya se había comentado en §14). Separado de `#vista-compras .badge`, que sigue activo — compras.js mantiene su badge local de 7 variantes.
   - `#vista-vencimientos .tabla-main`/`.badge`/`.badge-warn`/`.badge-muted`, que habían quedado sin comentar en un pase anterior (§16) pese a que ya no tenían consumidor — corregido acá.
4. `tabla-agrupada.css`/`.tabla-main` en otras páginas no se toca (fuera de alcance del Hallazgo #6, no comparten `compras.css`).

**Hallazgo colateral (fuera de alcance, no se toca):** `productos.js` (modal ABM de categorías) arma un `div.acciones-td` con botones `.btn-tabla`, pero `productos.html` **nunca cargó `compras.css`** — ese consumidor ya estaba huérfano de estilos antes de esta migración; comentar `.acciones-td` en `compras.css` no genera ninguna regresión ahí porque nunca estuvo activo. Página distinta, no forma parte de este plan — queda documentado por si se decide adoptar el patrón canónico en `productos.html` en una fase futura.

**Verificación final:**
- `node --check` limpio en `compras.js` (y en el resto de JS tocados en §16/§17: `lotes.js`, `zonas.js`, `proveedores.js`, `proveedores.page.js`).
- Balance de llaves verificado en `compras.css`/`compras-gentelella.css`/`proveedores-gentelella.css`/`vencimientos-gentelella.css` (parser que descarta contenido de comentarios, no solo conteo de caracteres — se corrigió un comentario CSS anidado que había quedado mal formado al comentar el bloque responsive de §18.3, ver nota técnica abajo).
- Grep de residuales `.tabla-main`/`.acciones-td`/`#vista-vencimientos .badge`/`#vista-proveedores .badge` en `compras.css`: cero ocurrencias activas fuera de comentarios.
- `compras.page.js`/`vencimientos.page.js`/`rutas.page.js` (e2e) no dependen de ninguna clase tocada en este cierre.

**Nota técnica (CSS no soporta comentarios anidados):** al comentar el bloque responsive completo de `compras.css` (§18.3), ese bloque contenía a su vez un comentario de una sola línea (`/* Acciones y la primera celda... */`). Un `/* ... */` dentro de otro `/* ... */` cierra el comentario exterior en el primer `*/` que encuentra, dejando el resto del CSS comentado como código "vivo" — con las llaves de cierre residuales generando un archivo roto. Se detectó con un parser que recorre el archivo carácter a carácter llevando la cuenta de profundidad de `{}` **ignorando el contenido dentro de `/* */`** (un conteo simple de `{` vs `}` con `grep -c` no lo detecta, porque los caracteres siguen estando ahí). Se corrigió quitando los delimitadores del comentario interno, dejando el texto como anotación simple dentro del bloque ya comentado por fuera.

**Estado del Hallazgo #6:** **cerrado.** Las 5 páginas que compartían `.badge`/`.acciones-td`/`.tabla-main` vía `compras.css` (`compras`, `proveedores`, `vencimientos`, `rutas`/Zonas, y el ya cerrado `cc-proveedores` de Fase 0) migraron su tabla a `.tabla-admin` y su celda de acciones al patrón canónico (`renderFilaAcciones`, con o sin kebab según necesidad). Los sistemas de badge locales que colisionan de color con el canónico (`compras` de 7 variantes, `cc-proveedores` con `.badge-fx`) quedan documentados como decisión consciente de no unificar, no como deuda pendiente.

**Próximo paso sugerido:** no queda ninguna página pendiente del grupo `tabla-main` real. Si se retoma Fase 3, el siguiente candidato natural es evaluar `cajas.html` (`tabla-historial`, dejado afuera en §15 por decisión del usuario) o abrir una fase nueva para el hallazgo colateral de `productos.html` encontrado en esta pasada.

---

## 19. Avance de Fase 3 — `cajas.html` (`tabla-historial`, 2026-08-19)

**Alcance acotado, y por qué:** `cajas.html` tiene **una sola tabla real**: el historial de cierres de turno (`.tabla-historial`, panel lateral). El listado de cajas en sí (columna principal) **no es una tabla** — es una grilla de tarjetas (`.caja-card`), con su propio badge (`.caja-badge`/`.badge-activa`/`.badge-inactiva`) y sus propios botones (`.btn-caja.editar`/`.toggle-activa`/`.toggle-inactiva`). Mismo criterio que `pos.html` (§4, Fase 4): no se fuerza el patrón canónico (`.tabla-admin`/`.badge-estado`/`.fila-acciones`) donde no corresponde funcionalmente — una tarjeta no es una fila de tabla. Se deja la grilla de cajas intacta, sin tocar.

**Auditoría previa:**
- Toda la lógica de esta página está **inline en `cajas.html`** (`<script>` en el `<body>`, sin un `cajas.js` separado) — a diferencia del resto de páginas de Fase 3. No hay ninguna referencia a `.tabla-historial` por selector de clase en el JS (el render usa exclusivamente ids: `hist-tbody`, `hist-vacio`, `hist-pagina-txt`, etc.), así que renombrar la clase no tiene ningún riesgo de romper lógica.
- La tabla de historial es de **solo lectura** — no tiene badge de estado ni celda de acciones por fila (la diferencia de arqueo se pinta con color inline vía JS, no con una clase `.badge-*`; el click en la fila entera abre un modal de detalle, no hay botones `.btn-tabla`). Por eso esta migración es más simple que las anteriores: no hace falta tocar `renderBadgeEstado`/`renderFilaAcciones`, solo el nombre de la clase de tabla y su reskin.
- `cajas.html` **no cargaba `componentes-admin.css`** — es la única página del grupo de Fase 3 migrado hasta ahora que no lo tenía. Se agregó el `<link>` (no `componentes-admin.js`: no se usa ningún `ComponentesAdmin.render*` acá).
- El header de la tabla usa `position: sticky` y padding compacto (7–10px) vía `style=""` inline, porque esta tabla vive dentro de un layout de 2 columnas con scroll interno recortado a la altura del viewport (`.col-lateral`/`.hist-tabla-wrap`, ver comentario en el `<style>` del `<head>`) — el canónico no define `position: sticky` por defecto (ninguna otra página migrada lo necesita, todas scrollean la página completa). Sacar ese inline hubiera sido una **regresión funcional** (se pierde el header pegajoso al scrollear), no una limpieza — se dejó tal cual, documentado.
- Sin colisión de nombres: se verificó que `puntos.html` también tiene una clase `.tabla-historial`, pero es 100% propia y aislada (definida en un `<style>` inline de esa página, sin relación con `cajas-gentelella.css`) — el rename de acá no la afecta. Los demás usos de la cadena "tabla-historial" en el proyecto son **ids** de otras páginas (`rutas.js`, `fidelizacion.js`), no clases, sin relación.
- Sin e2e: no existe `cajas.page.js`/`cajas.spec.js` en el proyecto — cero riesgo de regresión de tests.

**Trabajo realizado:**
1. `cajas.html`: agregado `<link>` a `componentes-admin.css` (antes de `cajas-gentelella.css`, mismo orden de carga que el resto de páginas del grupo). La `<table class="tabla-historial" style="width:100%;border-collapse:collapse;font-size:12px">` pasa a `<table class="tabla-admin" style="font-size:12px">` — se retiran `width`/`border-collapse` del inline por ser redundantes con la base del canónico; se conserva `font-size:12px` (más compacto que los 13px del canónico, necesario por lo angosta que es la columna lateral). El `position:sticky`/padding compacto de los `<th>` se deja igual, ver nota arriba.
2. `cajas-gentelella.css`: renombrados los 5 selectores `.tabla-historial ...` → `.tabla-admin ...` (todos ya scopeados bajo `body.dash-cajas-gentelella`, sin riesgo de fuga a otra página). `.caja-badge`/`.badge-activa`/`.badge-inactiva`/`.btn-caja` no se tocan — no son parte de esta migración (ver nota de alcance arriba).

**Verificación:** balance de llaves OK (parser que ignora comentarios). Cero referencias activas a `.tabla-historial` en `cajas.html`/`cajas-gentelella.css` fuera del comentario explicativo. El JS inline de `cajas.html` (extraído y validado con `node --check`) sigue siendo sintácticamente válido — no se tocó ninguna línea de `<script>`. Sin page-object ni spec e2e para esta página, sin riesgo de regresión de tests.

**Estado:** `cajas.html` migrada — única tabla real (`tabla-historial` → `.tabla-admin`). Grilla de cajas (`.caja-card`) queda fuera de alcance a propósito, documentado igual que `pos.html`.

**Estado de Fase 3 tras §19:** quedan pendientes `clientes` (`tabla-clientes`), `automatizacion` (`tabla-card`), `puntos` (`tabla-historial`, propia y aislada — no se toca acá, no es la misma de `cajas`), `saas-billing` (`saas-table`), `reportes-*` (`ranking-table`) y `observabilidad` (`obs-tabla`) antes de poder cerrar la Fase 3 completa.

## 20. Avance de Fase 3 — `clientes.html` (`tabla-clientes`, EN CURSO, 2026-08-19)

**Por qué es distinta al resto del grupo:** es la página más grande de Fase 3 (860 líneas de HTML, 2160 de JS, 3 CSS propios: `clientes.css` 1187 líneas, `clientes-gentelella.css` 692, `clientes-ciclos.css` 180) y tiene **4 tablas reales** (`#vista-clientes` listado principal, `#vista-precios` precios especiales, `#vista-direcciones` direcciones de entrega, `#vista-listas` listas de precio), todas con la clase `tabla-clientes`.

**Hecho en esta pasada (tabla + badges — bajo riesgo, mismo patrón que §13-§19):**
1. `clientes.html`: agregado `<link>` a `componentes-admin.css` (antes de `clientes.css`, mismo orden que el resto del grupo). Las 4 `<table class="tabla-clientes">` → `<table class="tabla-admin">`.
2. `clientes.css`: 13 selectores `.tabla-clientes` → `.tabla-admin`. Además, esta página tenía **el `.badge-estado` redeclarado dos veces** dentro del mismo archivo (línea 317, estilo "sello" con borde doble — casi idéntico al canónico de `componentes-admin.css`, que de hecho cita a `clientes` en su comentario como una de las redefiniciones a reemplazar; y línea 949, un parche posterior que lo pisaba en cascada con estilo "pastilla redondeada"). Antes de tocar nada hice el álgebra de cascada: el override scoped `#vista-clientes .badge-estado` (solo padding/font-size, sin tocar) y el reskin `body.dash-clientes-gentelella .badge-estado` (radius pill + colores, con `!important`, siempre activo porque esa clase está en el `<body>`) ya ganaban por especificidad sobre ambas redeclaraciones — así que retirarlas **no cambia nada visualmente**, solo centraliza en el canónico. Se dejaron comentarios explicando el porqué en vez de borrar en silencio. `.badge-bajo`/`.badge-neutro` no se tocaron (no se usan en esta página, verificado contra `clientes.js`).
3. `clientes-gentelella.css`: mismos 6 selectores `.tabla-clientes` → `.tabla-admin`.
4. `reskin-patch.css` (archivo **compartido**, no exclusivo de esta página): tenía una regla `.tabla-clientes thead .col-sticky-end` que resultó redundante desde antes de esta migración — la regla genérica `thead .col-sticky-end` sin scope, dos líneas arriba, ya cubría el mismo caso. Se sacó el selector específico (no había que renombrarlo a `.tabla-admin`, eso hubiera sido un cambio global nuevo afectando a todas las páginas ya migradas) y se dejó un comentario explicando por qué.

**Verificación:** balance de llaves OK (parser que ignora comentarios) en los 3 archivos CSS tocados. Cero referencias a `.tabla-clientes` como clase en todo el proyecto (los 3 matches restantes son `id="tabla-clientes"`/`tabla-clientes-puntos` en `cobranzas.html`/`fidelizacion.js`, ids no relacionados de otras páginas, sin colisión).

**Pendiente, a decidir antes de seguir — patrón de acciones por fila:** a diferencia de todas las páginas migradas hasta ahora, `clientes.html` no usa `.acciones-td`/`.btn-icon` sino clases propias por tabla y sin un patrón único:
- Tabla clientes: `.btn-editar` ("Ver / Editar") + `.btn-portal` (botón toggle con ícono, dos estados).
- Tabla precios: una sola acción, `.btn-secundario` ("Eliminar").
- Tabla direcciones: `.btn-secundario` × 2 ("Editar" / "Eliminar").
- Tabla listas: `.btn-secundario` ("Editar") + `.btn-secundario` o `.btn-primario` mutuamente excluyentes ("Dar de baja" / "Activar") — mismo caso que Lotes en §16.

Migrar esto a `.fila-acciones`/`.btn-tabla` (canónico) es viable y consistente con el resto de Fase 3, pero acá hay un riesgo concreto que no estaba en `usuarios`/`cajas`: **`tests/e2e/page-objects/admin/clientes.page.js` usa `page.locator('button.btn-editar')` directamente** para abrir el modal de detalle (`abrirDetallePorId()`). Si se renombra esa clase hay que actualizar el page-object en el mismo cambio (como se hizo con `proveedores.page.js` en §17), o mantener `.btn-editar` como clase adicional junto a `.btn-tabla` para no romper el selector. Falta decidir el criterio antes de tocar el JS.

**Decisión del usuario:** igual que `cajas.html` en §19 (que quedó afuera de Fase 3 hasta que se retomó explícitamente), las acciones por fila de `clientes.html` quedan **fuera de alcance por ahora**. Se prioriza no tocar `.btn-editar`/`.btn-portal`/`.btn-secundario`/`.btn-primario` ni `clientes.page.js` en esta pasada.

**Estado:** `clientes.html` migrada en su alcance acotado — tabla (`tabla-clientes` → `.tabla-admin`, 4 tablas) y badges (`.badge-estado` centralizado al canónico, sin cambio visual) cerrados y verificados. Acciones por fila quedan pendientes como ítem propio, a retomar cuando se decida el criterio con `clientes.page.js`.

**Estado de Fase 3 tras §20:** quedan pendientes `automatizacion` (`tabla-card`), `puntos` (`tabla-historial`, propia y aislada), `saas-billing` (`saas-table`), `reportes-*` (`ranking-table`) y `observabilidad` (`obs-tabla`), más el ítem de acciones pendiente en `cajas.html` y `clientes.html`, antes de poder cerrar la Fase 3 completa.

## 21. `automatizacion.html` — auditada, migración pospuesta (2026-08-19)

**No se tocó ningún archivo.** Al auditar antes de migrar aparecieron dos cosas que no coinciden con el resto de Fase 3 y ameritan una decisión propia, no un simple rename:

1. **`tabla-card`/`tabla-base` son compartidas fuera de esta página.** El wrapper real es `.tabla-card` (no la tabla en sí) y la `<table>` usa `.tabla-base` — ambas definidas en `frontend/shared/adminlte-components.css` (compartido). `.tabla-base` también la usa `productos.html`, que **no está en el alcance de la Fase 3** (no aparece en la línea 103 del plan). Es la misma clase de colisión que tuvo `tabla-main` en su momento (§14-18), pero acá con una página fuera de plan.
2. **El sistema de badges/acciones de esta página no es el que se viene migrando en el resto de Fase 3.** Usa `.badge`/`.badge--success` (naming AdminLTE, distinto a `.badge-estado`/`.badge-ok` del resto) y `.btn.btn--ghost.btn--icon.btn--sm` para acciones de fila (distinto a `.acciones-td`/`.btn-tabla`/`.fila-acciones`). Migrarlo no es un rename — es adoptar el sistema canónico donde hoy hay uno completamente distinto.

**Decisión del usuario:** dejar `automatizacion.html` documentada con estos hallazgos y pasar directo a `puntos`, sin decidir el criterio todavía (mismo tipo de pausa que `clientes.html` en §20 con las acciones, o que `cajas.html` en §15 antes de retomarse).

## 22. Avance de Fase 3 — `puntos.html` (`tabla-historial`, EN CURSO)

**Alcance:** dos tablas propias, sin colisión con nadie — la `.tabla-historial` de esta página es 100% aislada (ya lo habíamos verificado en §19 al migrar `cajas.html`, que tiene su propia `.tabla-historial` sin relación). Ninguna de las dos tablas tiene acciones por fila: la tabla principal (`.tabla-puntos`, listado de clientes) abre un modal con toda la fila clickeable (`<tr onclick="abrirModal(...)">`, sin botones), y el historial de movimientos dentro del modal es de solo lectura (fecha/tipo/puntos/saldo). Por eso el alcance queda acotado a tabla — no hay nada de acciones que migrar en esta página, a diferencia de `clientes`/`automatizacion`.

**Hecho:**
1. `puntos.html`: agregado `<link>` a `componentes-admin.css` (junto a los demás links tempranos del `<head>`).
2. Tabla principal: `<table class="tabla-puntos">` → `<table class="tabla-admin tabla-puntos">` — se **conservó** `tabla-puntos` como clase adicional a propósito: `puntos-gentelella.css` la sigue usando con `!important` para el reskin completo (fondo, color, padding). Sacarla del todo hubiera dejado ese bloque de reskin muerto y la página sin su estilo real. El único CSS local que quedó fue el fondo del `<th>` (`var(--color-bg)`, que el canónico deja transparente), scopeado como `.tabla-admin.tabla-puntos thead th` — el resto de reglas locales (padding, tipografía, hover) eran redundantes con lo que ya trae `.tabla-admin` y se sacaron.
3. Tabla de historial (dentro del modal): `<table class="tabla-historial">` → `<table class="tabla-admin table-compact">` (usa el modificador de densidad ya existente en el canónico — la Fase 2 lo había generalizado). El compact modifier solo ajusta el padding vertical del `<tbody>`, así que se dejó un override scoped a `#modal-panel-historial` para el padding del `<th>` y del `<td>` (el panel del modal es angosto, necesita más compacto que el canónico por defecto) — sin `.tabla-historial` como clase remanente, porque acá no hay reskin ni ningún otro consumidor que dependa del nombre viejo (verificado: cero referencias a `.tabla-historial` fuera de esta página).
4. Badges de saldo (`.badge`/`.badge-low`/`.badge-mid`/`.badge-high`) **no se tocaron** — son un sistema de 3 niveles de saldo de puntos, no el patrón activo/inactivo de `.badge-estado`. Mismo criterio que `score-badge` en `clientes.html` (§20): es un componente de dominio propio, no corresponde forzar el canónico ahí.

**Verificación:** balance de llaves OK en el `<style>` inline (parser que ignora comentarios). `node --check` limpio en `puntos.js` (no se tocó ninguna línea, pero se verificó igual por las dudas ya que el render usa las clases por nombre en el HTML, no en el JS). Cero referencias colgantes a `.tabla-historial` como selector en el resto del proyecto. Sin e2e para esta página (no existe `puntos.page.js`/`puntos.spec.js`), sin riesgo de regresión de tests.

**Estado:** `puntos.html` migrada completa — única página de Fase 3 hasta ahora sin ningún punto pendiente (no tiene acciones por fila que decidir).

**Estado de Fase 3 tras §22:** quedan `saas-billing` (`saas-table`), `reportes-*` (`ranking-table`) y `observabilidad` (`obs-tabla`), más los ítems pospuestos: acciones de `cajas.html` y `clientes.html`, y `automatizacion.html` completa (tabla compartida con `productos.html` + sistema de badges/acciones distinto, ver §21).

## 23. Cierre de `reportes-*` (`ranking-table`) y `observabilidad` (`obs-tabla`) — 2026-08-19

**`reportes-*`:** grupo real — `.ranking-table` compartida entre `reportes-ventas.html`/`reportes-financieros.html`/`reportes-stock.html` vía `reportes.css` (12 tablas en total: 4+3+5). Sin e2e para las 3 páginas, sin colisión con otras pantallas. Migración: `.ranking-table` → `.tabla-admin` en las 12 tablas (HTML), en `reportes.css` (se retiran ancho/borde/tipografía/padding/hover base ya cubiertos por el canónico; se conservan las 3 cosas que no trae: fondo del `<thead>`, zebra striping y el compactado en mobile) y en los 3 CSS `*-gentelella.css` (7 selectores idénticos cada uno). `<link>` a `componentes-admin.css` agregado en las 3 páginas. Badges (`.status-badge`, usado en 2 de las 3 páginas) y un botón que reusa la clase de badge como acción ("Reabastecer" en stock) quedan **fuera de alcance**, mismo criterio que `automatizacion`/`saas-billing`. Único resto de `ranking-table` en el proyecto: 3 selectores huérfanos en `frontend/shared/reskin-patch.css` (parte de una lista genérica compartida por muchas páginas, `.ranking-table` ya no matchea nada) — no se tocó, queda documentado.

**`observabilidad`:** una sola página, `.obs-tabla` en 2 tablas (`#tabla-por-tipo`, `#tabla-error`) definida en un `<style>` inline propio de `observabilidad.html` más un reskin en `observabilidad-gentelella.css` (scopeado a `body.dash-anomalias-gentelella`, compartido con `anomalias.html`/`avisos.html` pero sin colisión real: cada página carga su propio CSS de reskin). Sin referencias en `observabilidad.js`. Migración: `.obs-tabla` → `.tabla-admin` + modificador `.table-compact` (mismo padding vertical de 8px que tenía la tabla original) en las 2 tablas; base inline recortada a solo lo que el canónico no cubre (`margin-bottom` de la sección, alineación de `td.num`); reskin renombrado (5 selectores). `<link>` a `componentes-admin.css` agregado antes del reskin propio.

**Verificación (ambos grupos):** balance de llaves OK en los 6 archivos CSS tocados y en el `<style>` inline de `observabilidad.html`. Cero `class="ranking-table"`/`class="obs-tabla"` activo en el proyecto.

**Estado de Fase 3 tras §23:** quedan `saas-billing` (`saas-table`) y los ítems pospuestos: acciones de `cajas.html`/`clientes.html`, y `automatizacion.html` completa.

## 24. Acciones por fila de `clientes.html` — 2026-08-19

**Retomado con el criterio que quedó pendiente en §20.** Auditoría previa: `.btn-tabla` no se usaba en ningún archivo de `clientes` (verificado), sin riesgo de colisión. Único punto de fricción real: `tests/e2e/page-objects/admin/clientes.page.js` usaba `page.locator('button.btn-editar')` en `abrirDetallePorId()`. **Decisión:** mismo criterio que `proveedores.page.js` en §17 — renombrar la clase y actualizar el page-object en el mismo cambio (se agregó `hasText: 'Ver / Editar'` porque `.btn-tabla` deja de ser exclusiva de ese botón dentro de la fila). El spec `clientes.spec.js` usa el método del page-object, no la clase directamente — sin más referencias que actualizar.

**Trabajo realizado (las 4 tablas de `clientes.html`):**
1. **Tabla clientes** (listado principal): `.btn-editar` ("Ver / Editar") → `.btn-tabla`, envuelto en `<span class="fila-acciones">`. `.btn-portal` (toggle de 2 estados con ícono SVG inline) **no se toca** — mismo criterio que `.btn-portal`/`.toggle-activa` en `cajas.html` y el botón "Reabastecer" en stock: componente de dominio propio, no una acción de texto simple.
2. **Tabla precios**: `.btn-secundario` ("Eliminar") → `.btn-tabla.peligro`.
3. **Tabla direcciones**: 2× `.btn-secundario` ("Editar"/"Eliminar") → `.btn-tabla` / `.btn-tabla.peligro`.
4. **Tabla listas**: `.btn-secundario` ("Editar") + par mutuamente excluyente ("Dar de baja"/"Activar") → `.btn-tabla` / `.btn-tabla.peligro` / `.btn-tabla.primario`, mismo patrón exacto que `proveedores.js`. Se reemplazó el `<div style="display:flex;gap:6px;...">` manual por `<span class="fila-acciones">` canónico.

**Hallazgo colateral:** `.btn-secundario`/`.btn-primario` son las clases genéricas de botón de modal (Cancelar/Guardar) de toda la página — las 3 tablas secundarias las reusaban para acciones de fila, con el tamaño de un botón de modal (padding 9px 18px, 14px) en vez del compacto `.btn-tabla` canónico (padding 5px 12px, 12px). Se migraron solo los usos dentro de las filas de tabla; los botones de modal siguen usando `.btn-secundario`/`.btn-primario` sin cambios.

**CSS:** `clientes-gentelella.css` — el bloque `.btn-editar` (acento teal, distinto del gris neutro del resto) se renombró a `.btn-tabla`, scopeado a `#vista-clientes` para no pisar el `.btn-tabla` gris de las otras 3 tablas; se agregó el reskin genérico `.btn-tabla`/`.btn-tabla.primario`/`.btn-tabla.peligro` (mismo patrón que `proveedores-gentelella.css`, mismos tokens `--ge-*`) para precios/direcciones/listas. `clientes.css` (base, no-gentelella) tenía **tres redeclaraciones más de `.btn-editar`** (base, un override "REDISEÑO AVANZADO", y una píldora sólida en `#vista-clientes`) que ya eran huérfanas en la práctica antes de este cambio — `body.dash-clientes-gentelella` siempre está en el `<body>` y el reskin ya ganaba la cascada por especificidad — se retiraron las tres con comentario explicativo, mismo criterio que la retirada de las dos redeclaraciones de `.badge-estado` en §20. También se retiró el override responsive `.table-responsive-cards .btn-editar` (ya cubierto por el modificador homónimo del canónico).

**`cajas.html` — cierre del ítem:** revisado de nuevo: la única tabla real (`.tabla-historial`, ya migrada en §19) es de **solo lectura**, sin badge de estado ni celda de acciones por fila. La grilla de cajas (`.caja-card`, con `.btn-caja`/`.toggle-activa`/`.toggle-inactiva`) queda fuera de alcance a propósito (no es una tabla). No queda ningún ítem de acciones pendiente en `cajas.html` — se cierra sin cambios adicionales.

**Verificación:** balance de llaves OK en `clientes.css`/`clientes-gentelella.css`. `node --check` limpio en `clientes.js`. Cero `class="btn-editar"` activo en el proyecto (solo comentarios explicativos). `clientes.page.js` actualizado y consistente con el nuevo selector.

**Estado de Fase 3 tras §24:** queda únicamente `saas-billing` (`saas-table`) y `automatizacion.html` completa (tabla compartida con `productos.html` + sistema de badges/acciones distinto, ver §21) antes de poder cerrar la Fase 3 completa.

## 25. Cierre de `saas-billing.html` (`saas-table`) — 2026-08-19

**Único ítem real que quedaba pendiente de la Fase 3** (`automatizacion.html` sigue pospuesto por decisión de §21, no forma parte de este cierre). Auditoría: 4 tablas (`Empresas`, `Migraciones`, `Eventos de negocio`, `Historial de facturas`), todas con `class="saas-table"` definida en un `<style>` inline propio (la página no comparte base con `finanzas.css`/`compras.css`). Sin selectores `.saas-table` en JS — todo el uso era CSS (`<style>` inline) y `class=""` en las 4 tablas; ningún riesgo de colisión con page-objects/specs (`smoke-universal.spec.js` solo referencia la ruta `saas-billing`, no clases).

**Migración:**
1. **HTML:** las 4 `<table class="saas-table">` → `<table class="tabla-admin">`. Se agregó `<link rel="stylesheet" href="/frontend/shared/componentes-admin.css?v=1" />` en el `<head>` (mismo patrón que `reportes-*`).
2. **Estilos inline de `saas-billing.html`:** el bloque `.saas-table` (ancho/borde/tipografía/padding/hover base, ya cubiertos por `.tabla-admin`) se retiró casi entero. Se conservaron solo dos cosas que el canónico no trae y acá eran a propósito: el fondo del `thead` (el canónico lo deja transparente) y el resaltado de fila que necesita atención (`.saas-row--alerta`, usado en la tabla "Empresas" para filas con pago pendiente/vencido) — reescritos como overrides `.tabla-admin thead th` / `.tabla-admin tbody tr.saas-row--alerta`.
3. **`saas-billing-gentelella.css`:** los 6 selectores `.saas-table*` renombrados a `.tabla-admin*`, mismo patrón exacto que `reportes-*-gentelella.css` (`thead`, `th`, `td`, `tbody tr`, `tbody tr:hover`, `tbody tr.saas-row--alerta`). Comentario de cabecera del archivo (lista de componentes que cubre) actualizado de `.saas-table` a `.tabla-admin`.

**Fuera de alcance a propósito, mismo criterio que `reportes-*`/`automatizacion` (§21/§23):** badges (`.badge`/`.badge--*`, 8 variantes de plan/factura) y el botón de acción `.btn-confirmar` ("Confirmar pago") — sistema de acciones propio de esta pantalla, no una acción de texto simple de `.fila-acciones`/`.btn-tabla`. Tampoco se tocó `saas-billing.html` de la raíz del repo (huérfano, no ruteado por `vercel.json` — solo `/admin/saas-billing` → `frontend/admin/saas-billing.html` existe en producción).

**Verificación:** llaves balanceadas en `saas-billing-gentelella.css` (66/66). Cero `class="saas-table"` activo en el proyecto — únicas menciones restantes son comentarios explicativos.

**Estado de Fase 3 tras §25: CERRADA.** Único ítem fuera de la fase es `automatizacion.html` completa, pospuesto por decisión explícita en §21 (tabla compartida con `productos.html` + sistema de badges/acciones distinto — se trata como un proyecto aparte, no como saldo de la Fase 3).

## 26. Avance de Fase 4 — `stock.html` y `pedidos.html` (2026-08-19)

**Nota sobre el ZIP de esta pasada:** `frontend/admin/js/pedidos.js` venía con el contenido del handler de backend (`api/pedidos/index.js`), no el JS de frontend real — se re-subió el mismo ZIP sin corregirlo. Se auditó igual apoyándose en `tests/e2e/page-objects/admin/pedidos.page.js` (documenta explícitamente que el contrato de selectores es `#tabla-body`/`tr.fila-pedido[data-id]`/`#modal-*`, no la clase de la `<table>`) y en `presupuestos.js` (sí presente y legítimo, confirmado no depender de `.tabla-pedidos`). Sigue pendiente para una próxima pasada conseguir el archivo real y revisar si tiene alguna dependencia adicional no visible desde CSS/e2e.

### `stock.html` (2 tablas: listado principal `#vista-stock` + depósitos en modal)
- HTML: ambas `<table class="tabla-stock...">` → `.tabla-admin`. Agregado `<link>` a `componentes-admin.css`.
- `stock.css`: retirado el bloque base `.tabla-stock` (ancho/borde/tipografía/padding/thead, redundante con el canónico) y el bloque mobile completo `.table-responsive-cards .tabla-stock` — resultó **idéntico valor por valor** al genérico que ya existe en `componentes-admin.css` (el canónico se había generalizado justamente a partir de este archivo, Hallazgo #5). Se conservó, renombrado, el único override realmente intencional: `#vista-stock .tabla-admin th { color: var(--color-text-light); padding: 14px; }` (tema propio de la vista, tokens `--nav-deposito`).
- `.fila-stock`/`.fila-stock--actualizada` (clase de fila, con dependencia JS real — animación al guardar un ajuste) **no se tocaron**: no dependen del nombre de clase de la tabla.
- `stock-gentelella.css` (6 selectores) y `stock-overview.css` (1 selector, `.td-producto`) renombrados.
- Verificado: cero `.tabla-stock` activo, llaves balanceadas, `node --check` limpio en `stock.js`.

### `pedidos.html` (2 tablas: pedidos `.tabla-lista-pedidos` + presupuestos)
- HTML: ambas `<table class="tabla-pedidos...">` → `.tabla-admin` (se preservó `.tabla-lista-pedidos`, modificador propio de ancho de columnas vía `<colgroup>`, sin relación con el nombre base). Agregado `<link>` a `componentes-admin.css`.
- `pedidos.css`: a diferencia de `stock.css`, el bloque mobile **no era redundante** — usa una técnica de tarjeta distinta (flexbox con label a la izquierda) en vez de la del canónico (absolute-position) y tiene reglas propias extensas (`.td-id`, `.td-cliente`, `.td-acciones`, botones de estado) — se conservó completo, solo renombrado el selector base.
- Detectado y resuelto: `.tabla-pedidos thead` tenía **dos declaraciones** con el mismo fondo real (`var(--color-bg)` en la primera, pisada por `var(--color-surface-2, var(--color-bg))` en una segunda declaración posterior de la sección "Refresco visual", misma especificidad) — consolidado en una sola regla `.tabla-admin thead` con el valor que efectivamente ganaba.
- `.fila-pedido`/`.fila-pedido::before` (barra de color a la izquierda al hover) — clase de fila, sin relación con el nombre de la tabla, no se tocó.
- **Tercera capa encontrada y corregida:** `tema-claro-shipp.css` (reskin "SHIPP UI" exclusivo de `pedidos.html`, cargado el último de todos los CSS de la página) también seleccionaba `.tabla-pedidos thead` dos veces — renombrado a `.tabla-admin thead`, mismo valor final (`var(--color-surface-2)`), sin cambio visual.
- `pedidos-gentelella.css` (5 selectores) renombrado.
- Verificado: cero `.tabla-pedidos` activo, llaves balanceadas en los 3 CSS tocados, page-object/spec de e2e no dependen de la clase de tabla, `presupuestos.js` confirmado sin dependencia.

**Estado de Fase 4:** `stock.html`/`pedidos.html` cerrados (el ítem más simple de la fase, confirmado). Quedan: `pos.html` (decisión caso por caso, probablemente no se fuerza el canónico) y las páginas sin tabla (`dashboard`, `empresa-config`, `facturacion-config`, `mercadopago-config`, `migracion`, `avisos`, `anomalias`) para revisión de header/filtros.

## 27. Cierre de Fase 4 — `pos.html` y páginas sin tabla (2026-08-19)

### `pos.html` — decisión: no se toca
Auditada la única `<table class="pos-tabla-atajos">` del archivo: vive dentro del modal de ayuda (F1), es una tabla de 2 columnas (tecla/acción) para la lista de atajos de teclado — no es un listado de entidades, no tiene thead con columnas de negocio, badges, acciones por fila ni paginación. No aplica el patrón `.tabla-admin`. Confirmado el criterio del plan: **queda fuera de alcance, sin cambios**.

### Páginas sin tabla (`dashboard`, `empresa-config`, `facturacion-config`, `mercadopago-config`, `migracion`, `avisos`, `anomalias`)
- **`dashboard.html`**: es la "Torre de Control" (rediseño crypto-dark propio, grid de cards), un lenguaje visual completamente distinto al resto del admin por decisión de diseño explícita de sesiones anteriores. No tiene `topbar-title`/`page-intro` — tiene su propio `.topbar` minimal + `.dash-quick-nav`. **No aplica** la unificación de header de las demás páginas; se deja como está, es un caso especial ya asumido.
- **`empresa-config` / `facturacion-config` / `mercadopago-config` / `migracion` / `avisos` / `anomalias`**: las 6 ya comparten **el mismo patrón exacto** de header — `<header class="topbar"><div class="topbar-left"><h1 class="topbar-title">…</h1></div><div class="topbar-right"><span class="topbar-usuario">…</span></div></header>`, seguido de `<div class="page-intro">`. Confirmado también por comentario propio en `migracion-gentelella.css` ("Reusa los patrones ya establecidos... `.topbar`/`.breadcrumb-bar`/`.page-intro`"). **Nada para unificar acá: ya están unificadas.**
- Nota: `avisos.html` carga a propósito `anomalias-gentelella.css` y usa `body.dash-anomalias-gentelella` (mismo reskin que `anomalias.html`, ambas bajo "Alertas automáticas") — verificado que no es un bug, es un archivo CSS compartido intencional entre las dos pantallas.

### Hallazgo transversal nuevo (#7) — dos sistemas de botón en paralelo
Al revisar los botones de estas páginas encontré que **conviven dos convenciones de `.btn` en todo el proyecto**, no solo en las páginas de esta fase:
- **Legacy** (sin BEM): `.btn-primary` / `.btn-secondary` / `.btn-danger` / `.btn-ghost` / `.btn-sm` / `.btn-icon`, definidas en `finanzas.css` (y variante en `reportes.css`). La usan `empresa-config.html`, `facturacion-config.html` y `mercadopago-config.html` (y probablemente otras pantallas de finanzas no auditadas en esta pasada).
- **Canónica** (BEM): `.btn.btn--primary` / `.btn.btn--secondary` / `.btn.btn--ghost`, definida en `tokens.css`, ya adoptada explícitamente por ~20 archivos `*-gentelella.css` (incluidos `migracion` y `anomalias`, ya migradas).
- No es un bug funcional (ambas están bien definidas y estilizadas, cada `-gentelella.css` de estas 3 páginas ya les agrega sus propios ajustes de `border-radius`/`font-weight` encima). Es una duplicación de sistema de diseño con blast radius grande: no se limita a estas 3 páginas, sino a toda página que cargue `finanzas.css` para sus botones.
- **Queda fuera del alcance liviano de Fase 4** (que es sobre header/topbar, ya resuelto arriba) — por tamaño y riesgo se documenta como hallazgo para decidir si se aborda como su propia fase (al estilo Fase 1/2, con relevamiento previo de qué páginas usan cada convención) o se deja para Fase 5.

**Estado de Fase 4: CERRADA.** `stock.html`/`pedidos.html` (§26), `pos.html` (sin cambios, decisión documentada) y las 7 páginas sin tabla (headers ya unificados, sin cambios necesarios) — todo revisado. Único pendiente real es el Hallazgo #7 (botones), a decidir con Cristian antes de tocar código.

## 28. Hallazgo #7 (botones) — relevamiento completo + primer lote migrado (2026-08-19)

**Corrección sobre §27:** la fuente real de la convención legacy no es `finanzas.css` — es `/shared/reskin-patch.css` (sección propia "8. BOTONES LEGACY — azul corporativo", con `!important` en todo, cargado en ~50 páginas del admin) más `/shared/reskin-patch-v2-shadcn.css` encima. `finanzas.css`/`reportes.css`/`nav.css` tienen sus propias variantes locales de `.btn-primary` pero no son la fuente que afecta a las páginas de Fase 4. El archivo mismo se autodenomina "legacy", lo que confirma que la dirección correcta es migrar hacia `.btn.btn--primary` (BEM, `tokens.css`), no al revés.

### Relevamiento (HTML que usa la convención legacy sin BEM, fuera de `pos.html`/`dashboard.html`)
| Página | Clases legacy en el HTML | Dependencia JS (selector funcional) |
|---|---|---|
| `empresa-config` | btn-primary, btn-secondary | No |
| `facturacion-config` | btn-primary | No |
| `mercadopago-config` | btn-primary, btn-danger | No |
| `compras` | btn-cancelar | No |
| `pedidos` | btn-danger, btn-nuevo-pres | No (el `.btn-danger` de `rutas.js` es un archivo distinto, no afecta acá) |
| `cajas` | btn-guardar, btn-secondary | Sin confirmar — `cajas.js` no apareció en el grep de `.btn-guardar`, pero no se revisó si inyecta la clase dinámicamente |
| `vencimientos` | btn-cancelar, btn-guardar | Sin confirmar (mismo caso) |
| `usuarios` | btn-cancelar | `usuarios.js` sí depende de `.btn-guardar` (no de `.btn-cancelar`) — revisar igual antes de tocar |
| `stock` | btn-exportar | `stock.js` depende de `.btn-guardar` en otro punto de la pantalla (no visible en el grep de HTML → probablemente inyectado por JS, a confirmar) |
| `proveedores` | btn-cancelar | `proveedores.js` depende de `.btn-guardar` (mismo caso que stock) |
| `clientes` | btn-exportar, btn-secondary | `clientes.js` depende de `.btn-guardar` (mismo caso) |
| `rutas` | btn-cancelar | `rutas.js` depende de `.btn-secondary` y `.btn-danger` — **no tocar sin revisar el JS primero** |
| `export-contable` | btn-primary | No |
| `saas-billing` | btn-confirmar | `migracion.js` depende de `.btn-confirmar`, pero es un archivo distinto — a confirmar que `saas-billing.js` no tenga su propia dependencia |
| `suspendida` | btn-primary, btn-secondary | No (página de error/bloqueo, sin JS de negocio) |

**Alerta metodológica:** el grep es sobre HTML estático. Varias páginas (`stock`, `proveedores`, `clientes`, `usuarios`) tienen su JS referenciando `.btn-guardar` sin que la clase aparezca en el HTML fuente — probablemente porque el botón se arma dinámicamente en JS (modal generado por template string). Antes de migrar esas páginas hay que rastrear dónde se inyecta esa clase, no alcanza con `sed` sobre el `.html`.

### Migrado en esta pasada (bajo riesgo, cero dependencia JS confirmada)
`empresa-config.html`, `facturacion-config.html`, `mercadopago-config.html`:
- HTML: `btn-primary`→`btn btn--primary`, `btn-secondary`→`btn btn--secondary`, `btn-danger`→`btn btn--danger`. Los hooks de JS de estas 3 pantallas son todos por `id`, ninguno por clase — confirmado antes de migrar.
- Sus `*-gentelella.css`: selectores renombrados a `.btn--primary`/`.btn--secondary`/`.btn--danger` (mismo valor, sin cambio visual).
- `empresa-config.html` tenía además un bloque `<style>` inline con `.btn-secondary` completo (background/border/padding propios) — resultó **redundante** con el canónico salvo `align-self:flex-start` (necesario por el layout en columna de `.logo-actions`) y un ajuste de altura táctil en mobile; se retuvieron solo esas dos reglas, reescopeadas a `.logo-actions .btn--secondary` y `.btn--secondary` respectivamente, y se borró el resto.
- `facturacion-config.html` y `mercadopago-config.html` tenían el mismo patrón (bloque `<style>` inline duplicando el look del canónico) — se conservó únicamente el fix de altura táctil en mobile (`min-height:40px`), retargeteado a `.btn--primary`/`.btn--danger`; se borró el resto por redundante. `.btn-test` (facturacion-config) y `.acciones` no se tocaron, son ajenos a este hallazgo.
- Verificado: cero referencias a `btn-primary`/`btn-secondary`/`btn-danger` (sin BEM) en los 3 HTML ni en sus CSS; llaves balanceadas en los 6 archivos tocados. No se pudo correr Playwright en este entorno (no hay servidor/Supabase disponible acá) — verificación fue por lectura de cascada CSS, no captura visual real; recomendado un vistazo rápido en el deploy antes de dar por bueno.

### Pendiente
El resto de la tabla (11 páginas) — algunas de riesgo bajo (`compras`, `export-contable`, `pedidos`, `suspendida`, sin dependencia JS confirmada) y otras que requieren primero rastrear inyección dinámica de clase en JS (`stock`, `proveedores`, `clientes`, `usuarios`, `cajas`, `vencimientos`, `rutas`, `saas-billing`) antes de tocar el HTML.

## 29. Cierre del Hallazgo #7 (parte 2) — `stock`, `clientes`, `cajas`, `vencimientos`, `suspendida` (2026-08-19)

**Alerta metodológica del §28 resuelta:** no hay inyección dinámica de clase por JS en ninguna de las 4 páginas sospechadas. `stock.js`, `clientes.js`, `cajas.html` (inline) y `usuarios.js` enganchan sus botones siempre por `getElementById` (texto/disabled/estilo inline), nunca por selector de clase — confirmado con grep dirigido sobre los 4 archivos antes de tocar HTML. La clase la fija siempre el HTML estático (o un template string que arma el HTML, no que la inyecta sobre un nodo ya creado). Migración segura sin riesgo de romper handlers.

**Migrado:**
- `stock.html`: `btn-transferir-stock` y `btn-exportar-excel-stock` → `btn btn--secondary`.
- `clientes.html`: `btn-mas-acciones` → `btn btn--secondary`; `btn-geocodificar` tenía ya `btn btn-secondary btn-sm` (BEM a medias, con guión simple) → corregido a `btn btn--secondary btn-sm`.
- `cajas.html`: botón `btn-guardar` (guardar caja) → `btn btn--primary`; los dos botones "Marcar como resuelto" (armados por template string en `marcarDiferenciaResuelta`, dos puntos del archivo) → `btn btn--secondary btn-xs`.
- `vencimientos.html`: `Cancelar`/`Guardar lote` del modal de lotes → `btn btn--secondary` / `btn btn--primary`.
- CSS muerto eliminado (reimplementaciones sin `!important` que ya perdían contra el `!important` legacy de `reskin-patch.css`, sin efecto visual real): bloque `<style>` inline `.btn-guardar` en `cajas.html`; los dos bloques duplicados `.btn-exportar`/`.btn-importar` en `stock.css` y en `clientes.css`.
- Overrides de tema por página **retargeteados** (no borrados, tienen efecto visual real — acento teal de Gentelella) para seguir aplicando sobre las clases nuevas: `.btn-guardar`→`.btn.btn--primary` en `cajas-gentelella.css` (idéntico valor a valor al bloque `.btn.btn--primary` que ya existía ahí, quedó unificado en uno solo); `.btn-cancelar`/`.btn-guardar`→`.btn.btn--secondary`/`.btn.btn--primary` en `vencimientos-gentelella.css` (mismo caso, ya existía el bloque BEM equivalente, se unificó); `.btn-exportar`→`.btn.btn--secondary` en `stock-gentelella.css` y en `clientes-gentelella.css` (acá no existía bloque BEM previo, se renombró el selector manteniendo los mismos valores — cero cambio visual).

**Hallazgo nuevo, no estaba en el relevamiento de §28 — `suspendida.html` queda fuera de este hallazgo:** no se migró a BEM. Es una pantalla de bloqueo por cuenta suspendida con diseño propio deliberado (CTA full-width, no el mismo patrón `inline-flex` de `.btn--primary`/`.btn--secondary` de `tokens.css`) — mismo criterio de exclusión que el punto 1 del plan para páginas públicas/marketing, aunque viva dentro de `frontend/admin/`. Al auditarla se encontró que sus botones **ya estaban rotos en la práctica**: al reusar los nombres `.btn-primary`/`.btn-secondary`, quedaban pisados por el bloque `!important` de `reskin-patch.css` (que fuerza `inline-flex` y padding chico), rompiendo el diseño full-width pensado para esta pantalla. Fix aplicado: renombradas a `.susp-btn-primary`/`.susp-btn-secondary` (nombre propio, sin colisión con ningún sistema compartido), restaurando el diseño original. Esto es una corrección de bug real, no una migración — no cuenta como pendiente cerrado de la tabla de §28, pero la saca de la lista (no debe migrarse a BEM en una pasada futura).

**Sin verificación visual real (Playwright no disponible en este entorno):** verificado por lectura de cascada CSS y balance de llaves en los 6 archivos CSS tocados, igual que en el lote de §28. Recomendado un vistazo rápido en el deploy.

### Pendiente actualizado
`compras`, `export-contable`, `pedidos` (riesgo bajo, sin dependencia JS confirmada) y `proveedores`, `usuarios`, `rutas`, `saas-billing` (requieren el mismo rastreo de inyección dinámica que se acaba de cerrar para stock/clientes/cajas/vencimientos, antes de tocar HTML).

## 30. Cierre del Hallazgo #7 (parte 3, final) — `compras`, `export-contable`, `pedidos`, `proveedores`, `usuarios`, `rutas`, `saas-billing` (2026-08-19)

**La tabla de relevamiento de §28 estaba desactualizada en 4 de las 7 filas** — al abrir cada archivo, ya no tenían la clase legacy que la tabla decía:
- `compras`: la tabla decía `btn-cancelar` — no existe ese literal en el HTML actual (los botones de cancelar son `.btn-accion-modal`, un componente propio). Nada que migrar acá.
- `export-contable`: la tabla decía `btn-primary` — el HTML actual ya usa `btn--primary` en el único botón. Nada que migrar.
- `proveedores` y `usuarios`: la tabla decía `btn-cancelar` para ambas — ninguna de las dos tiene ya esa clase; todos sus botones ya son `btn btn--primary` / `btn btn--secondary`. Nada que migrar.
- `saas-billing`: la tabla decía `btn-confirmar` (mezclado con la dependencia real de `migracion.js`, que es de otro archivo) — no existe `.btn-confirmar` en `saas-billing.html`. **Corrección real, no eran solo clases legacy sin migrar**: esta pantalla usa su propio sistema autocontenido `.btn-prim`/`.btn-sec`, documentado explícitamente en el encabezado de `saas-billing-gentelella.css` como "sin base compartida" — ni siquiera pasa por `reskin-patch.css` (esos nombres no están en su lista de selectores legacy) ni por `tokens.css`. Es una tercera convención deliberada, con su propio `display`/`padding`/`border-radius` autocontenidos en el archivo gentelella. **Queda fuera de alcance de Hallazgo #7**, mismo criterio que `pos.html` (decisión ya documentada en §27): no se toca.

**Investigado y confirmado sin riesgo (la alerta de "revisar JS antes de tocar" del §28 no aplicaba)**:
- `rutas.js`: se rastreó todo el archivo (no solo grep de `.btn-danger`/`.btn-secondary`) — no hay un solo `querySelector`/`getElementsByClassName` sobre esas clases, y `rutas.html` ni siquiera tiene `.btn-secondary`/`.btn-danger` hoy (deben haber sido migradas en una pasada previa no reflejada en la tabla). Solo quedaba `.btn-cancelar` en el modal de zonas → migrado a `btn btn--secondary`. Sin override propio en ningún CSS de rutas (`rutas.css`, `-compact`, `-professional`, `-resumen`, `-gentelella`) — se estilizaba únicamente por el legacy de `reskin-patch.css`.
- `pedidos.html`: `.btn-danger` (botón "Sí, cancelar pedido" del modal de confirmación) → migrado a `btn btn--danger`. Nota aparte: `.btn-acc.btn-danger` (acción chica por fila, componente `.btn-acc` propio) y `.btn-secundario` (nombre en español, sistema separado ya definido en `tokens.css`) **no se tocaron** — no son parte de este hallazgo.

**Bug real encontrado y corregido de paso en `pedidos.html`**: el `.btn-danger` legacy de `reskin-patch.css` pinta texto rojo sobre fondo transparente (`!important`), pero `pedidos-gentelella.css` sumaba `background: var(--ge-red) !important` sin tocar el color de texto — la combinación probablemente rendía **texto rojo sobre fondo rojo** en el botón de confirmar cancelación. Al migrar a `.btn.btn--danger` (que en `tokens.css` ya trae `color:#fff` sin colisión) el problema se resuelve como efecto colateral de la migración. También se borró el bloque local de `pedidos.css` que reimplementaba `.btn-danger` en rojo sólido con texto claro (sin `!important`, ya perdía contra el legacy — muerto en la práctica, coincidía con lo que la migración a BEM ya deja andando) y se retargeteó el override de `pedidos-gentelella.css` a `.btn.btn--danger`.

**Hallazgo nuevo, no relacionado a Hallazgo #7, corregido de paso en `compras.html`**: 6 botones (`Cancelar`/`Cerrar` de varios modales) usaban `class="btn--secondary"` **sin la clase base `.btn`** — como `tokens.css` separa la estructura (`display`, `padding`, `border-radius`, `border`) en `.btn` y el color en `.btn--secondary`, estos botones no tenían ningún selector local ni de `reskin-patch.css` que les diera esa estructura (confirmado por grep: `.btn--secondary`/`.btn--primary`/`.btn--danger` bare no aparecen en ningún otro CSS del proyecto). Se les agregó la clase `btn` faltante en los 6 casos.

**Sin verificación visual real** (mismo motivo que en §28/§29 — no hay Playwright disponible acá): verificado por lectura de cascada CSS y balance de llaves en los archivos tocados.

### Estado de Hallazgo #7: CERRADO
Las 15 páginas de la tabla original de §28 quedaron resueltas: 4 migradas en el primer lote (§28), 5 en el segundo (§29, incluida la corrección de `suspendida`), y de las 7 de esta tercera tanda, 3 se migraron de verdad (`rutas`, `pedidos`, y de paso el bug de `compras`) y 4 ya estaban limpias o quedan explícitamente fuera de alcance (`compras`, `export-contable`, `proveedores`, `usuarios` sin cambio de clase; `saas-billing` fuera de alcance por diseño propio). No queda ninguna página con `.btn-primary`/`.btn-secondary`/`.btn-danger`/`.btn-guardar`/`.btn-cancelar`/`.btn-exportar`/`.btn-confirmar` sin BEM, salvo `suspendida.html` (decisión explícita, fuera de alcance) y `saas-billing.html` (decisión explícita, fuera de alcance).

## 31. Auditoría retroactiva de Fase 1 (Familia B) + `cobranzas.html` recuperada para Fase 2 (2026-08-19)

**Punto de partida:** con el Hallazgo #7 cerrado (§30) y la Fase 4 cerrada (§27), lo único que el plan todavía marcaba como no confirmado era la Fase 1 (Familia B: `facturacion`, `auditoria`, `cheques`, `devoluciones`, `notas`, `notas-credito`). Antes de arrancarla de cero se auditó el estado real de las 6 páginas y de `facturacion.js`.

**Resultado: Fase 1 ya estaba 100% migrada, solo que sin quedar registrada como tal en el resumen de estado.** `facturacion.js` ya usa el patrón canónico de acciones y badges, y las 6 páginas de Familia B confirman tabla `.tabla-admin`, badge canónico y `.fila-acciones` — esto coincide exactamente con el cierre que ya documenta el §11 (Hallazgo #3, Familia B 100% migrada). No hay migración pendiente acá; el trabajo de esta sección fue de verificación, no de código.

**Censo completo de clases de tabla en todo `frontend/admin/`** (disparado por la duda de si quedaba algo más suelto, no solo en Familia B): se inventariaron todas las clases de tabla vigentes y se ubicaron los matches restantes de la clase legacy `tabla` sin sufijo.

**Hallazgo real de esta pasada — `cobranzas.html` se había escapado por completo de la Fase 2 (§ "Cierre de Fase 2"):** las 2 tablas de `cobranzas.html` (`class="tabla table-compact"`, la principal y `#tabla-clientes`) seguían con el patrón legacy exacto que la Fase 2 debía cubrir, y la página **no está** en la lista de las 12 páginas cerradas ahí. Verificado antes de tocar:
- `cobranzas.html` ya carga `componentes-admin.css`.
- `cobranzas.js` no depende de la clase `.tabla` (el único hit de grep es `.tabla-wrap`, que no cambia).
- `cobranzas.css` / `cobranzas-gentelella.css` no definen reglas propias sobre `.tabla` — el estilo venía del legacy `table.tabla` de `reskin-patch.css`.
- El e2e (`cobranzas.page.js`, `cobranzas.spec.js`) selecciona todo por `id`/`data-testid`, cero dependencia de la clase.

**Migrado:** las 2 tablas de `cobranzas.html` → `class="tabla-admin table-compact"` (una de ellas conserva además `id="tabla-clientes"`). Sin cambios de badges/acciones — `cobranzas.js` no usa `badge`/`acciones-td`/`btn-tabla`/`fila-acciones`, no aplica.

**Confirmado tras el fix:** censo repetido sobre todo `frontend/` — el único resto de `class="tabla ...` (sin `-admin`) que queda es la excepción ya documentada en el cierre de Fase 2 (tabla de detalle generada dinámicamente por `riesgo-cheques.js` dentro del modal de embargos/rechazos, distinta de la tabla-lista principal). No queda ninguna otra página con la clase legacy suelta.

**Corrección al recuento de Fase 2:** el cierre de Fase 2 quedó documentado como "12 páginas migradas" sin incluir `cobranzas`; con este hallazgo son **13** las páginas de tabla genérica migradas a `.tabla-admin` bajo ese criterio (las 12 originales + `cobranzas`).

**Sin verificación visual real** (mismo motivo que §27–§30 — no hay Playwright disponible en este entorno): verificado por lectura de HTML/CSS/JS y grep dirigido, mismo criterio que el resto del cierre del Hallazgo #7.

### Estado general del plan tras §31
- **Fase 0, 1, 2 (13 páginas), 3, 4:** cerradas.
- **Hallazgos #1–#7:** cerrados.
- **Pendiente real:** `automatizacion.html` (migración pospuesta por decisión explícita en §21, falta decidir criterio de tabla compartida con `productos.html` — fuera del plan hasta esa decisión) y la **Fase 5** (limpieza final: quitar reglas redundantes de cada CSS por página, auditoría final de las ~47 páginas, actualizar `docs/GENTELELLA_RESKIN_TRACKING.md`).

## 32. Fase 5 — Limpieza final (2026-08-19)

**1. Reglas de `.badge-estado` redundantes retiradas (el diagnóstico original del §0 hablaba de "11 archivos con redeclaración local"):**
- `stock.css` y `stock-overview.css`: cada uno tenía el bloque **completo** (`.badge-estado`, `.badge-dot`, `.badge-critico`, `.badge-bajo`, `.badge-ok`, `.badge-inactivo`) copiado **byte-idéntico** al canónico de `componentes-admin.css` (mismo padding, `border-width`/`style`, radius, colores por variante). Ambos cargan después del canónico, así que ganaban por orden de cascada sin aportar ningún valor distinto — se retiraron enteros, dejando un comentario que referencia este cierre. Sin cambio visual.
- `compras.css`: `.badge-inactivo` (idéntico al canónico) y `.badge-pendiente` (con una diferencia real — le faltaba `opacity: .85` — pero como este archivo carga *antes* que `componentes-admin.css`, la variante canónica ya le ganaba la cascada; la diferencia nunca se vio en pantalla). Se retiraron ambas líneas, con comentario. El resto de `compras.css` (`.badge-activo`, `.badge-borrador`, `.badge-enviada`, `.badge-confirmada`, `.badge-recibida*`, `.badge-cancelada`, `.badge-emitida`, `.badge-aplicada`, `.badge-anulada`, `.badge-error_afip`) son estados de negocio propios de Compras/Notas de crédito sin equivalente canónico — **no se tocaron**, son la parte "verdaderamente específica" que el criterio de Fase 5 permite conservar.

**2. `.tabla-wrap` "duplicado" en varias páginas (`facturacion.css`, `finanzas.css`, `pedidos.css`, `stock.css`, y con matices `clientes.css`/`compras.css`): auditado y descartado como redundante.** A diferencia del caso de `.badge-estado`, estas redeclaraciones **no son copias muertas**: todas agregan `border: 1px solid rgba(0,0,0,.07)` y `overflow-x: auto` (o, en el caso de `clientes.css`, un `font-size` distinto y un `box-shadow` propio en un segundo bloque), ninguno de los cuales está en la regla canónica (`background`/`border-radius`/`overflow: hidden` solamente). Es un patrón repetido con intención (borde sutil + scroll horizontal en mobile) que **candidatea a subirse al canónico en una futura pasada**, pero eso es una decisión de diseño (cambiaría el aspecto de todas las páginas que hoy no lo tienen), no una limpieza de código muerto — queda fuera de esta Fase 5 y anotado para quien decida si conviene promoverlo.

**3. Auditoría final de las 56 páginas de `frontend/admin/` (script de censo de clases de tabla + link a `componentes-admin.css`), resultado:**
- **Todas las páginas en alcance del plan usan `.tabla-admin`.** Sin excepciones nuevas encontradas.
- Confirmado que las excepciones ya documentadas siguen siendo exactamente esas y ninguna más: `pos.html` (`pos-tabla-atajos`, grilla de atajos no listado), las 4 `.rutas-table` del workspace de armado de `rutas.html` (la 5ta tabla, "Zonas", sí es `.tabla-admin`), `productos.html` (`prod-tabla`/`tabla-base`, es la página de referencia original, nunca migrada a su propio componente derivado — no carga `componentes-admin.css` a propósito), `automatizacion.html` (`tabla-base`, pospuesta), `migracion.html` (`mig-preview-tabla`, grilla de previsualización de columnas de un CSV importado, no un listado — misma categoría funcional que `.rutas-table`/`.inner-tabla`, fuera de alcance por naturaleza), y los 5 stubs de redirect + páginas sin tabla (`dashboard`, `*-config`, `avisos`, `anomalias`, login/setup/utilidad) ya resueltas para header/topbar en el cierre de Fase 4 (§27).
- **`saas-billing.html` confirmado correctamente migrado** (las 4 tablas ya son `.tabla-admin`, con comentario propio referenciando su cierre en Fase 3) — no hay contradicción con que sus *botones* sigan con sistema propio (`.btn-prim`/`.btn-sec`, decisión de Hallazgo #7 en §30): son dos componentes distintos con decisiones independientes.
- Barrido de JS de las páginas con `.tabla-admin` en busca del patrón legacy de "solo íconos" (`acciones-td`, `btn-icon`): un solo hit, `btn-icon` en `devoluciones.js` — inspeccionado y descartado como falso positivo: es el botón "Quitar" de una fila dentro del formulario del modal de nota de devolución, no una acción de fila de la tabla principal (que ya usa `fila-acciones`/`btn-tabla` correctamente).
- Confirmado (no es hallazgo nuevo, ya documentado más arriba en el plan) que el sistema paralelo de badges `.chip`/`.chip-verde`/`.chip-rojo`/`.chip-amarillo`/`.chip-gris`/`.chip-azul` de `finanzas.css` sigue sin tocar en `cheques`, `cobranzas`, `auditoria`, `devoluciones`, `notas`, `vencimientos`, `riesgo-cheques` y otras — es la razón por la que muchas páginas con `.tabla-admin` no tienen ningún `.badge-estado` en su HTML/JS. Decisión ya tomada: se trata como fase propia futura, no como deuda de esta Fase 5.

**4. `docs/GENTELELLA_RESKIN_TRACKING.md` actualizado** con una nota de cierre que referencia este plan (esa doc trackea el reskin de paleta/color, un esfuerzo paralelo y ya completo por su cuenta — no duplica el detalle acá, solo cruza referencia y aclara que son dos proyectos distintos).

### Estado de Fase 5: CERRADA (con dos ítems explícitamente fuera de alcance, no pendientes de esta fase)
- **Fuera de alcance, decisión ya tomada:** promover `border`+`overflow-x` de `.tabla-wrap` al canónico (mejora de diseño opcional, no limpieza) y el sistema `.chip` de `finanzas.css` (fase propia futura).
- **Único pendiente real de todo `PLAN_UNIFICACION_UX_ADMIN.md`:** `automatizacion.html`, pospuesta desde §21 por falta de decisión de criterio (tabla compartida con `productos.html`).
