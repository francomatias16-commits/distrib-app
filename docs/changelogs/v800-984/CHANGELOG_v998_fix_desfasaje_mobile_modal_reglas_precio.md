# v998 — Desfasaje mobile en el modal de Reglas de precio (Descuentos automáticos)

## Contexto

Reportado con captura de un celular: en `reglas-precio.html`, al abrir el
modal de alta/edición ("Editar: <producto> - ...", "Nueva regla de precio"),
en mobile el panel aparece con el borde izquierdo fuera de pantalla. Se ve
el botón "×" (cierre) completo, pero el título, los labels ("Nombre de la
regla", "Alcance del producto", "Cantidad mínima", etc.) y los valores de
los campos aparecen cortados por la izquierda, en cantidades de caracteres
distintas según el tamaño de fuente de cada elemento — consistente con que
todo el panel está desplazado hacia la izquierda por un ancho fijo, no con
un problema de wrapping o de contenido individual.

## Causa

`#modal-regla.modal` (agregado en v360 para el patrón "cajón deslizante")
usaba:

```css
right: -600px;   /* cerrado */
width: 580px;
max-width: 95vw; /* única salvaguarda para pantallas angostas */
```
```css
#modal-regla.modal.open { right: 0; }
```

Con el panel anclado por `right`, cualquier excedente de ancho sobre el
viewport real se va hacia la izquierda — y al ser `position: fixed`, ese
excedente no es alcanzable con scroll, queda directamente invisible. La
única protección contra esto era `max-width: 95vw`, que en el dispositivo
de la captura no estaba conteniendo el ancho real del panel (se comporta
como si el modal se hubiera renderizado más cerca de sus 580px "nativos"
que del ~95% del viewport esperado). No se pudo reproducir en un navegador
real dentro de este entorno de trabajo (sin Playwright/Chromium
disponible — ver limitación más abajo), así que el diagnóstico se hizo
por lectura de CSS + medición de la captura, no por reproducción en vivo.

Este mismo patrón (`right` + `width` fijo + `max-width: vw`, sin un
breakpoint mobile explícito) se replica igual en otras páginas gentelella
del admin (`#modal-gasto` en gastos-generales, y la versión "canónica" en
`componentes-admin.css` para clientes/compras/facturación/productos/stock)
— quedan fuera de alcance de este fix (ver más abajo).

## Fix

**`frontend/admin/css/reglas-precio-gentelella.css`**: se agregó un
breakpoint `@media (max-width: 640px)` que reemplaza el mecanismo de
`right` + ancho fijo/`vw` por uno que no depende de calcular el ancho del
viewport en absoluto:

- `left: 0; right: 0; width: auto; max-width: 100%;` — el panel ocupa el
  100% del viewport sin necesitar ningún valor de `vw`.
- La animación de apertura/cierre pasa de animar `right` a animar
  `transform: translateX()` (cerrado: `translateX(100%)`; abierto:
  `translateX(0)`), igual al mecanismo que ya usa `pedidos.css` para su
  propio drawer — un `translateX(100%)` es siempre el 100% del ancho
  *propio* del elemento, nunca depende del viewport, así que es inmune a
  este problema aunque el ancho real del viewport se calcule distinto de
  lo esperado.

**`frontend/admin/reglas-precio.html`**: bump de `?v=` en el `<link>` del
CSS tocado (de `mtavqrle` a `v998fix`) para evitar que quede cacheada la
versión anterior.

## Fuera de alcance

- No se tocó `#modal-gasto` (gastos-generales-gentelella.css) ni el bloque
  canónico de `componentes-admin.css` que comparten clientes/compras/
  facturación/productos/stock — tienen el mismo patrón `right`+`vw` sin
  breakpoint mobile y podrían tener el mismo bug, pero el reporte fue
  puntual sobre reglas-precio y no hay evidencia (captura) de que las
  otras páginas estén afectadas. Si se confirma el mismo síntoma en
  alguna de ellas, aplicar el mismo fix (`left:0; right:0; width:auto;`
  + `transform: translateX()`) sería el mismo patrón.
- No se identificó con certeza *por qué* `max-width: 95vw` no contenía el
  ancho en el dispositivo real (podría ser interacción con overflow
  horizontal de otro elemento de la página, o una particularidad del
  navegador/dispositivo del reporte) — el fix elegido evita depender de
  `vw` en absoluto en vez de intentar corregir esa causa puntual, para
  que sea robusto independientemente de cuál sea.

## Verificación

- Revisado el CSS resultante: el bloque `@media` nuevo queda después del
  bloque base de `#modal-regla.modal`, mismo selector con especificidad
  igual → gana por orden de cascada dentro del breakpoint, sin necesitar
  `!important`.
- No verificable en este entorno: captura real en un dispositivo mobile
  confirmando visualmente el fix (no hay navegador/Playwright disponible
  en este sandbox — mismo problema que ya quedó documentado en
  `docs/auditorias/2026-08_auditoria_mobile_PROGRESO.md`).
