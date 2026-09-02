# Reporte de fusión — 23/08/2026

Este paquete es el resultado de fusionar **dos snapshots divergentes** del
mismo proyecto (`proyecto_catalogo_fluxo_v6_deploy_completo.zip` y
`proyecto_fix_responsive_completo_combos__2_.zip`) más los dos archivos
sueltos de Rutas/Repartos, en un único árbol consistente y validado.

## Diagnóstico

- **`catalogo_fluxo_v6`** era el snapshot más completo y más nuevo en casi
  todo: 675 archivos que el otro paquete no tenía (proveedor, landing,
  video, scan-pos, etc.), el rediseño visual verde ("Fluxo") aplicado a
  cajas/rutas/catálogo, y el módulo de Rutas ya con `rutas-integrated.css`
  enlazado — es decir, **`rutas_repartos_actualizado.html` y
  `rutas-integrated.css` que subiste son idénticos byte a byte** a lo que
  ya traía este paquete. No requirieron ninguna acción adicional.
- **`fix_responsive`** era un snapshot más chico pero tenía una
  funcionalidad completa que al otro le faltaba: **Combos** (productos
  empaquetados) y **Destacados / reglas de volumen** en el catálogo del
  cliente.
- Se usó `catalogo_fluxo_v6` como base y se importó quirúrgicamente la
  funcionalidad de Combos/Destacados desde `fix_responsive`, sin perder
  ninguno de los 675 archivos ni el rediseño visual del primero.

## Archivos nuevos incorporados (de `fix_responsive`, sin conflicto)

- `frontend/admin/combos.html`, `frontend/admin/css/combos.css`,
  `frontend/admin/js/combos.js`
- `lib/repos/combos.js`
- 10 migraciones SQL nuevas en `supabase/migrations/` (526 a 535: reglas de
  volumen, destacados, esquema y RPCs de combos)

## Archivos backend reemplazados (rewrites retrocompatibles, verificados
línea por línea — ninguna función de `catalogo_fluxo_v6` se perdió)

- `lib/handlers/pedidos.js` — validación/armado de pedidos ahora soporta
  renglones de combo además de producto.
- `lib/handlers/stock.js` — soporte de `?destacados=1` y reglas de volumen.
- `lib/repos/stock.js` — agrega `listarReglasVolumenCatalogo`.
- `lib/calc/pedido-totales.js` — soporta IVA mixto de combos (retrocompatible).

## Archivos parcheados a mano (se insertó solo el código nuevo, se
conservó el theme/versión de CSS más nuevo de `catalogo_fluxo_v6`)

- `frontend/admin/js/nav-data.js` — ítem de menú "Combos".
- `vercel.json` — ruta `/admin/combos`.
- `frontend/admin/productos.html` / `js/productos.js` — checkbox y lógica
  de producto "Destacado".
- `frontend/cliente/catalogo.html` — secciones fijas de Destacados y
  Combos, teaser de regla de volumen, alta/baja de combos en el carrito.
- `frontend/cliente/css/catalogo.css` — estilos de `.badge-combo`,
  `.teaser-volumen`, `.seccion-destacados*`, **adaptados a la paleta de
  tokens `--catalog-*`** (verde) en vez de copiar los tokens genéricos
  `--color-*` del snapshot viejo (azul), para que no rompa la identidad
  visual ya aplicada.
- `frontend/cliente/carrito.html` / `css/carrito.css` — badge "Combo" en
  el renglón del carrito, manejo null-safe de `producto_id`/`combo_id`.

## Archivos donde se descartó `fix_responsive` (contenido más viejo)

`frontend/admin/rutas.html`, `css/rutas-integrated.css`,
`frontend/admin/cajas.html`, `css/cajas-gentelella.css`,
`frontend/admin/reglas-precio.html`, `frontend/cliente/{cuenta,inicio,
pedidos}.html` y sus CSS — en todos estos, `fix_responsive` tenía una
versión anterior (theme azul viejo o sin el rediseño), sin ninguna lógica
funcional que valiera la pena rescatar. Se confirmó diff por diff.

## Validaciones realizadas

- Comparación completa de los ~3.800 archivos entre ambos paquetes
  (por nombre y por contenido byte a byte).
- `node --check` sobre **todos** los `.js` del proyecto final (incluidos
  los archivos parcheados y sus bloques `<script>` inline) → sin errores
  de sintaxis.
- `vercel.json` validado como JSON.
- Verificado que no falta ningún archivo de `catalogo_fluxo_v6` en el
  resultado final, y que los 14 archivos exclusivos de Combos están
  presentes.

## Optimización del empaquetado

Se excluyeron del ZIP final `.local/` y `.agents/` (~886 archivos de caché
interna de herramientas de asistentes/agentes de Replit — fingerprints de
skills, no forman parte de la aplicación) para no inflar el paquete. Se
conservó `.replit` (config real de ese entorno) y absolutamente todo el
código, tests, docs y changelogs del proyecto.

## Pendiente de tu lado (no se puede validar sin acceso a la base)

- Correr las 10 migraciones nuevas (526 a 535) contra Supabase, en orden,
  si todavía no se aplicaron.
- QA visual rápido de las secciones "Destacados" y "Combos" en
  `/cliente/catalogo` y del ítem "Combos" en el panel admin — el CSS se
  adaptó a mano a la paleta nueva y conviene un vistazo antes de producción.
- `migraciones_completas.sql` (raíz del proyecto) es un snapshot histórico
  viejo (llega solo hasta "Fase 1") y **no se actualizó** — no forma parte
  del pipeline real de migraciones (que vive en `supabase/migrations/`),
  así que no debería usarse como fuente de verdad.
