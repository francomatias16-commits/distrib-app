# v492 — Migración de colores en JS: lote 3 (tokens categóricos + resto del frente)

Continúa el trabajo de `v491` (lote 2, mecánico) cerrando el resto de los ~22
archivos identificados como pendientes, más la definición de tokens
categóricos nuevos en `tokens.css` para los casos que no encajaban en
success/warning/danger/info.

## tokens.css — nuevos tokens de pill/badge categóricos

Se agregó una familia `--pill-*` para etiquetas de tipo/categoría que no son
semánticas (ok/alerta/error/info), evitando duplicar valores hex sueltos en
cada archivo JS:

```
--pill-neutral-bg / --pill-neutral-text
--pill-purple-bg  / --pill-purple-text
--pill-pink-bg    / --pill-pink-text
--pill-orange-bg  / --pill-orange-text
```

## Resuelto en este lote

- **`busqueda-global.js`** (45→0) — 6 colores de ícono por tipo de entidad
  mapeados a `--color-info/success/warning` + los 3 pills nuevos
  (`purple`/`pink`/`orange`); badges verde/amarillo/rojo/gris a los tokens
  semánticos existentes.
- **`cc-proveedores.js`, `compras.js`** — mismo patrón de badges de estado
  (confirmada/borrador/descartada, diferencias OC vs factura) tokenizado.
  `PROV_PALETTE` (paleta categórica del gráfico por proveedor) se dejó
  intacta a propósito.
- **`reportes-financieros.js`, `reportes-stock.js`, `reportes-ventas.js`** —
  bloque idéntico del menú de exportación (Excel/CSV/PDF) tokenizado;
  fallbacks stale de `tokens.teal/red/blue` actualizados a los valores
  vigentes de `gentelella-tokens.css` (`--ge-teal/-red/-blue`).
- **`automatizacion.js`** — mapa de colores de toast tokenizado (incluye
  Electric Blue heredado). Queda el rgba violeta de la línea 357 a propósito
  (mismo criterio que `migracion-badge.js`).
- **`notas-internas.js`** — fallbacks stale (`#9ca3af`, `#f9fafb`, `#e5e7eb`,
  `#111827`, `#ef4444`, `#fff`, `#3b82f6`) actualizados a los valores
  vigentes. `AVATAR_COLORS` (paleta categórica por usuario) se dejó intacta.
- **`dashboard-optimizado.js`** — donut de progreso de pedidos y gráfico de
  barras de ventas por día (ambos monocromáticos verde/neutro) migrados a
  `--color-success` / `--color-success-mid` / `--color-surface-2`. Tooltip
  oscuro migrado a `--nav-dark-bg`/`--nav-dark-text`. 3 fallbacks stale de
  `--color-danger`/`--color-warning`/`--color-primary` en las tarjetas de
  tareas pendientes actualizados.
- **`productos.js`** — donut de indicador (margen/stock) tokenizado a
  `--color-info-mid`/`--color-warning-mid`/`--color-danger-mid`; grises de
  ícono y texto tokenizados; chip de "auto-completado" (azul stale) y chip
  verde stale tokenizados a `--color-primary-bg`/`--color-success`.
  `PALETA` (12 colores rotativos por categoría de producto, sin entidad fija
  detrás) se dejó intacta — mismo criterio que `PROV_PALETTE`.
- **`pedidos.js`** — loader, estado de error de carga, chip "Factura con
  error" y el banner de "datos auto-completados" (antes Electric Blue crudo)
  migrados a `--color-text*`/`--color-danger*`/`--color-info*`.
  `_PALETA_AVATAR` se dejó intacta (categórica).
- **`rutas.js`** — mapas de color por estado de entrega (`entregado` /
  `no_entregado` / `pendiente` / `en_camino`, 2 lugares) migrados a las
  mismas variantes `--color-box-*` que ya se usaron en `rutas-resumen.js`;
  texto "confirmado" (verde stale) y marcador de posición del chofer (azul
  stale) tokenizados. `CHOFER_PALETTE` se dejó intacta (categórica).
- **`stock.js`** — fallbacks stale `tokens.teal/orange` corregidos a
  `--ge-teal/--ge-orange` vigentes; mini-gráfico de proyección (widget
  oscuro intencional, fondo `#111` sin tocar) con sus 3 colores de acento
  (pronóstico/alerta/llegada) migrados a los tokens de marca. `colores`
  (paleta por depósito) y `_AVATAR_COLORES` se dejaron intactas.
- **`pos.js`** — colores de egreso/ingreso de caja, descuento, aviso de venta
  offline y varios `status.style.color` con nombre de token roto
  (`--color-exito` no existe → `--color-success`) o fallback stale
  (`--border` no existe → `--color-border-soft`) corregidos.
- **`pos-offline.js`** — 3 variantes de badge de estado de sincronización
  (pendiente/error/sincronizado) tokenizadas a warning/danger/success.
- **`presupuestos.js`** — único fallback stale restante (`--color-primary-bg`
  con rgba azul Electric Blue) corregido al valor vigente.

## Dejado como está (con razón, sin cambios)

- **`migracion-badge.js`** — paleta violeta de 3 tonos sin token equivalente
  definido (ver v491, pendiente de decisión de diseño).
- **`remito.js`** — es el remito imprimible (documento para imprimir en
  papel: negro/blanco/grises puros son intencionales, no deben seguir el
  tema de la app).
- Paletas categóricas rotativas sin entidad fija detrás (`PROV_PALETTE`,
  `CHOFER_PALETTE`, `AVATAR_COLORS`, `_PALETA_AVATAR`, `_AVATAR_COLORES`,
  `PALETA` de productos, `colores` de depósito en `stock.js`): mismo
  criterio que la paleta de ECharts — no representan marca, representan
  "índice N del ciclo".
- Sombras/overlays genéricos (`rgba(0,0,0,.xx)` sin color de marca) y el aro
  blanco de contraste en pines de mapa (`border:2px solid #fff`): técnica de
  contraste, no color de marca.

## Lote 4 — resto del proyecto fuera de la lista original de 22

Barrido de los archivos que quedaban con hex/rgba sueltos y no estaban en la
lista de `v491` (la mayoría, fallbacks stale del mismo patrón de siempre):

- **`proveedores.js`** — `--color-text-muted` (fallback `#6b7280`→`#4B4A45`),
  verde "● Activo" (`#16a34a`, sin token → `--color-success`) y
  `--color-danger` (fallback `#dc2626`→`#7A1E19`) del botón "Revocar".
- **`rentabilidad-producto-vendedor.js`, `rentabilidad-zona.js`** — mismo
  `tokens.teal || '#22c55e'` / `tokens.red || '#ef4444'` stale que en
  `stock.js` y los `reportes-*.js`, corregido a `--ge-teal`/`--ge-red`
  vigentes. La `splitLine` del gráfico (`rgba(0,0,0,.05)`) es grilla
  genérica, sin tocar.
- **`ui-utils.js`** — ícono de alerta en `confirmar()`/`confirmarConTexto()`
  (`--color-danger` fallback `#c0392b`→`#7A1E19`) y borde del textarea
  (`--color-border` fallback `#d0d5dd`→`#C7BFA9`). Los overlays de modal
  (`rgba(0,0,0,.45)`) son genéricos, sin tocar.
- **`usuarios.js`** — `--color-text-muted` (fallback `#6b7280`→`#4B4A45`) en
  las etiquetas "vos" / "Solo el dueño".
- **`auth.js`** — botón flotante "Instalar app" tenía Electric Blue
  heredado sin ni un `var()` alrededor (`background:#2563EB` crudo);
  tokenizado a `--color-box-primary`.
- **`cheques.js`** — **bug real, no solo estético**: el aviso de "sin
  denuncia registrada" tenía `var(--color-success-bg,#052e16)` /
  `var(--color-success,#22c55e)` — esos fallbacks son valores de **dark
  mode invertido** colados en un contexto claro (quedó una ocurrencia
  suelta cuando se corrigió el resto del archivo en el lote 1). Corregido a
  los valores claros vigentes (`#DCEDE3`/`#17402F`).

## Dejado como está, revisado y confirmado intencional

- **`clientes.js`** línea ~1715 — `background:#25D366` es el verde de marca
  oficial de WhatsApp en el botón "Ofrecer plan de pago" (ícono de WhatsApp
  al lado). Color de marca de terceros, no del sistema — no se tokeniza.
- **`export-utils.js`** — `printTable()` abre una ventana nueva con su
  propio `<style>` inline (`#4CAF50`, `#ddd`) para imprimir una tabla.
  Mismo criterio que `remito.js`: es un documento para imprimir, no la UI
  de la app — no se tokeniza.

## Lote 5 — migracion-badge.js (violeta) resuelto

Se definieron 3 tokens nuevos en `tokens.css` para cerrar el último archivo
pendiente:

```
--violeta-light: #7A639F;
--violeta-mid:   #5B4A8F; /* = --nav-facturacion */
--violeta-dark:  #453A70;
--violeta-rgb:   91,74,143;
```

**Criterio:** en vez de preservar el violeta Tailwind crudo tal cual
(`#a855f7`/`#7c3aed`/`#6d28d9` — un violeta vívido tipo SaaS, de la misma
familia que el Electric Blue que se viene migrando en todo el resto del
proyecto) o colapsarlo sin más a `--nav-facturacion` perdiendo la
gradación de 3 tonos, se recalibró la gradación completa sobre el único
violeta que ya existe en el sistema de marca (`--nav-facturacion,
#5B4A8F`) como tono medio — un tono más claro para texto sobre fondo tenue
(`--violeta-light`) y uno más oscuro para texto que necesita más contraste,
como el encabezado de tabla sobre fondo casi blanco (`--violeta-dark`).
`--violeta-rgb` expone el mismo RGB de `--nav-facturacion` en formato
"R,G,B" para poder seguir armando los fondos/bordes con alpha variable
(`rgba(var(--violeta-rgb), .15)`, `.28`, `.07`, etc.) que el archivo ya
usaba en 8 lugares distintos, sin tener que definir un token por cada
nivel de opacidad.

`migracion-badge.js` (13→0): badge de "origen de migración" y sección de
"datos extra sin destino" tokenizados por completo — fondos/bordes con
alpha (`--violeta-rgb`), texto del badge (`--violeta-mid`), texto del
toggle/nota (`--violeta-light`) y encabezado de tabla (`--violeta-dark`).

## Estado final

Con esto se cierra el frente completo de tokenización de colores en
`frontend/admin/js/`. No queda ningún archivo con color hardcodeado sin
revisar — lo único que persiste sin tokenizar son los casos ya documentados
como intencionales: paletas categóricas rotativas, el remito imprimible, el
export a impresión, el verde de marca de WhatsApp, y sombras/overlays
genéricos sin color de marca.
