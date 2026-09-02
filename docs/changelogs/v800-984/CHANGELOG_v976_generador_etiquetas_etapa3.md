# CHANGELOG v976 — Generador de etiquetas de precio/código de barras, Etapa 3 (precarga desde Recepción)

**Fecha:** 2026-08-24.

Continuación de `PLAN_ETIQUETAS_PRECIO_CODIGO_BARRAS.md` (sección 6,
Etapa 3: "Integración con Recepción de mercadería. Precarga automática
de productos+cantidades desde una recepción confirmada").

## Punto de partida (antes de tocar nada)

La Etapa 2 (selección real desde el listado de Productos) ya estaba
implementada en el ZIP recibido — funcional, pero **sin CHANGELOG propio**
(no hay `CHANGELOG_v9xx_..._etapa2.md` en el repo, solo quedó documentada
en `checklist_pase_manual.md`). Además, al revisar el código antes de
seguir until:

- Las clases del cuerpo del modal de vista previa (`.etq-preview-lista`,
  `.etq-preview-fila`, etc.) **no tenían ninguna regla CSS en todo el
  proyecto** — ni en `productos.css` ni en ningún `shared/*.css`. La
  Etapa 2 quedó funcional pero sin estilo propio.
- La lógica de esa vista previa (armar el modal, traer config+productos
  reales, imprimir) vivía duplicada solo dentro de `productos.js`, sin
  forma de reutilizarla desde Compras sin copiar y pegar.

Ambas cosas se corrigieron como parte de esta etapa (ver abajo) porque
la Etapa 3 depende directamente de poder reusar esa vista previa desde
una página que no comparte ningún CSS/JS con Productos.

## Qué entra en esta etapa

- **`frontend/admin/js/etiquetas-preview.js`** (nuevo): módulo compartido
  extraído de `productos.js` — arma el modal de vista previa (config +
  productos reales + copias editables por producto) y dispara la
  impresión vía `EtiquetasPrint.imprimir()`. Expone
  `window.EtiquetasPreview.abrir(ids, copiasPorId?, onCerrar?)`:
  - `copiasPorId` (opcional): `{ [producto_id]: copias }` para precargar
    la cantidad de copias en vez del default (1) — lo que usa esta
    etapa para arrancar en la cantidad recibida.
  - `onCerrar` (opcional): callback al cerrar el modal — Productos lo usa
    para limpiar la selección de la grilla; Compras no lo necesita.
- **`frontend/admin/css/etiquetas-preview.css`** (nuevo): estilos propios
  y autocontenidos del módulo (clases `etqp-*`, ver más abajo por qué se
  renombraron) — cargado tanto en `productos.html` como en `compras.html`.
- **`productos.js`**: `abrirVistaPreviaEtiquetas()` ahora es un wrapper de
  3 líneas que llama a `EtiquetasPreview.abrir()`; se borraron las ~130
  líneas duplicadas (`getConfigEtiquetas`, `getProductosParaEtiquetas`,
  `renderVistaPreviaEtiquetas`, `precioPreviaConIva`,
  `actualizarCopiasEtiqueta`, `cerrarVistaPreviaEtiquetas`,
  `imprimirEtiquetasSeleccionadas`). Sin cambio de comportamiento visible
  en la Etapa 2 — ver checklist, punto 5.
- **`compras.js`**: `ofrecerEtiquetasRecepcion(items)` y
  `imprimirEtiquetasDeRecepcion()`, enganchadas en los dos puntos donde
  una recepción termina en éxito:
  - `_enviarRecepcion()` (flujo normal, sin exceso sobre lo pendiente).
  - `confirmarConExcedente()` (flujo con exceso) — acá la cantidad que
    se precarga es la recibida **real** (pendiente + excedente), no la
    capada a lo pendiente que efectivamente se acreditó a la OC.
  Ambas arman `[{producto_id, cantidad_recibida}]` a partir de lo que el
  usuario cargó en la grilla de recepción (no hace falta ningún cambio
  de backend — `recepcionar_orden_compra` ya devolvía lo necesario y el
  detalle de cantidades ya estaba disponible client-side antes de
  mandarlo al servidor).
- **`compras.html`**: nuevo modal "Recepción confirmada" (oferta,
  aparece después de que la recepción ya está confirmada — nunca la
  condiciona ni la bloquea) + el modal de vista previa/copias (mismo
  markup que `productos.html`) + script tags de JsBarcode,
  `etiquetas-print.js` y `etiquetas-preview.js`.
- **`productos.html`**: agrega el script tag de `etiquetas-preview.js` y
  el link al CSS nuevo; el markup del modal de vista previa no cambió.

## Por qué las clases del modal se renombraron a `etqp-*`

Al volverse un módulo compartido con Compras (que ni siquiera carga
`productos.css`), depender de que la página host tuviera por casualidad
las clases correctas ya no era sostenible — y de hecho nunca lo fue: la
Etapa 2 las usaba sin que existieran en ningún lado. Se le dieron
clases propias al módulo (`etqp-spinner`, `etqp-vacio`, `etqp-error`,
`etqp-lista`, `etqp-fila`, `etqp-nombre`, `etqp-precio`,
`etqp-copias-label`, `etqp-copias`, `etqp-iva-toggle`) con su CSS en
`etiquetas-preview.css`, que solo depende de `tokens.css` (variables
`--color-*`/`--radius-*`), ya cargado en ambas páginas. El resto del
modal (`.modal`, `.modal-backdrop`, `.modal-titulo`, `.btn-secundario`,
`.btn--primary`) sí son genuinamente compartidos — están en
`tokens.css`/`adminlte-components.css` — y no se tocaron.

## Fix chico adicional: `.prod-barra-etiquetas` / `.prod-chk-fila` sin CSS

Detectado en la misma revisión que encontró el modal sin estilo: estas
dos clases (la barra flotante "N productos seleccionados" y los
checkboxes de la grilla, ambas propias de la Etapa 2 en Productos) tenían
el mismo problema — usadas en `productos.js` sin ninguna regla CSS en
todo el proyecto. A diferencia del modal (compartido con Compras), estas
son exclusivas de `productos.html`, así que se resolvieron directamente
en `productos.css` (no en el módulo compartido `etiquetas-preview.css`):

- `.prod-chk-fila`: tamaño consistente con el resto de checkboxes de la
  grilla, `accent-color: var(--color-primary)`.
- `.prod-barra-etiquetas`: panel flotante inferior centrado
  (`position: fixed`, `--z-panel` — mismo token que usan los paneles/FAB
  de clientes.css y compras.css), con `--shadow-big`/`--radius-lg` de
  `tokens.css`, igual que el resto de `productos.css`. Responsive: en
  mobile (`≤640px`) pasa a ocupar el ancho con márgenes laterales en vez
  de quedar centrada con `transform`.

## Qué queda afuera (pendiente, no de esta etapa)

- **Etapa 4** (futura, no bloquea nada de esto): precio promocional
  tachado con `reglas_precio` en la etiqueta.

## Checklist de prueba manual

Agregado a `checklist_pase_manual.md`, sección "Etiquetas de precio /
código de barras — Etapa 3 (543)".
