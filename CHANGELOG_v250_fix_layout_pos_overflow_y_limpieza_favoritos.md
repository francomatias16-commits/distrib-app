# CHANGELOG v250 — Fix layout POS (overflow horizontal) + limpieza de favoritos

## Problema reportado
En la pantalla de venta del POS (`pos-grid--facil`) la columna derecha
(Subtotal / Descuento / TOTAL / botón Cobrar) quedaba cortada por el borde
derecho de la ventana en resoluciones de escritorio comunes. La causa era
una suma de anchos fijos que superaba el ancho disponible real, y como
`body` usa `overflow-x: hidden` (para evitar scroll horizontal por paneles
off-canvas), el excedente se recortaba en silencio en vez de generar
scroll o achicarse.

## Causa raíz
1. La tabla del ticket (`.pos-ticket-tabla-head` / `.pos-item-fila` dentro
   de `.pos-ticket-tabla-body`) usaba columnas fijas que sumaban **436px**
   más gaps (42px) = **478px mínimos**, y la columna de descripción era
   `1fr` simple (sin `minmax(0, 1fr)`), lo que en ciertos navegadores
   permite que el contenido empuje el track en vez de achicarse a cero.
2. La columna derecha del grid (`.pos-grid--facil`) estaba fijada en
   `260px` y el gap en `10px`.
3. El contenedor principal (`.pos-main`) heredaba el padding genérico de
   `.main` (`24px 28px`), sin una versión más angosta para el POS.
4. La grilla de favoritos (`#pos-grilla-favoritos`) no tenía tope de
   altura ni límite de cantidad: con varios favoritos configurados crecía
   verticalmente sin límite, agregando ruido visual ("muchos botones de
   más vendidos") y compitiendo por espacio con el resto de la columna.

Sumando estos puntos, en anchos de pantalla habituales (1366–1920px con
sidebar de 264px) el contenido total superaba el viewport visible por
~100–150px, y ese excedente se recortaba en el borde derecho.

## Cambios aplicados (`frontend/admin/css/pos.css`)
- **Tabla del ticket**: columnas reducidas y descripción forzada a
  `minmax(0, 1fr)` para que siempre pueda achicarse en vez de desbordar:
  `20px 58px minmax(0,1fr) 72px 46px 66px 74px 20px` (antes `26px 74px 1fr
  96px 56px 76px 84px 24px`), gap `4px` (antes `6px`).
- Input de "% Desc." ajustado a `width: 100%` (antes `56px` fijo, ya no
  coincidía con la columna reducida).
- **Columna derecha del grid**: de `260px` a `232px`, gap del grid de
  `10px` a `8px`.
- **Padding general del POS** (`.pos-main`): `18px 16px` (antes heredaba
  `24px 28px` de `.main`).
- **Grilla de favoritos**: pasa de 2 a 3 columnas más compactas, con
  `max-height: 176px` y scroll interno propio, para que una lista larga
  de favoritos no empuje el resto de la columna (cliente, cerrar caja)
  fuera de pantalla. Botones y tipografía levemente más chicos para
  mantener consistencia con el resto del panel oscuro.

## Resultado esperado
- Toda la pantalla de venta (ticket + panel de totales/cobro + favoritos
  + datos de cliente + cerrar caja) entra en pantalla sin recortes en los
  anchos de escritorio habituales, sin necesidad de scroll horizontal.
- La grilla de "más vendidos" queda contenida y prolija, sin crecer sin
  límite ni generar sensación de desorden.
- No se tocó ningún ID ni lógica de `pos.js` — el cambio es
  exclusivamente visual/CSS.

## Archivos modificados
- `frontend/admin/css/pos.css`
