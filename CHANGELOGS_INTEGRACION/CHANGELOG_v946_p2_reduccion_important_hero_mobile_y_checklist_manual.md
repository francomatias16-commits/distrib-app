# CHANGELOG v946 — P2 resto: reducir `!important` de mobile-hero-v935.css + checklist de verificación manual

**Fecha:** 2026-08-22
**Contexto:** últimos dos puntos pendientes de `AUDITORIA_RESPONSIVE_MOBILE.md`
tras cerrar P1, P2 (z-index, v938) y P3 (v945): reducir los `!important` de
`mobile-hero-v935.css` (🟡 P2, quedaba marcado como "requiere QA visual") y el
checklist de verificación manual en dispositivo real (sección 4).

Este punto se había frenado en la sesión anterior por el riesgo real (no
solo teórico) de romper el hero de la landing sin forma de renderizarlo acá
para confirmar. Se decidió avanzar igual, con un análisis de cascada
exhaustivo por propiedad antes de tocar nada, dejando la confirmación visual
final (celular real) del lado del usuario.

## Qué se hizo

### 1) Análisis de cascada antes de tocar nada

`mobile-hero-v935.css` carga en `index.html` DESPUÉS de `styles.css`,
`refinamiento-v1.css`, `feature-visuales-v2.css`, `pricing-section.css` y
`whatsapp-float.css`, y ANTES de `hero-transitions-v937.css` (el único
archivo que carga después de este). Se catalogó cada selector que
`mobile-hero-v935.css` toca (`.hero-sticky`, `.hero-copy`, `.hero-art`,
`.hero-offer`, `.offer-scene`, `.hero-rail`, `.hero-stage`, `.hv2-shell`,
`.hero-actions`, `.hero-note`) y se buscó, propiedad por propiedad, si algún
archivo cargado antes o después declaraba lo mismo con `!important`:

- Los `!important` de `styles.css` sobre estos selectores están casi todos
  fuera del rango mobile (`@media (min-width:761px)`) o apuntan a
  propiedades distintas de las que fija `v935` (ej. `letter-spacing`, que
  `v935` nunca toca) — sin conflicto real.
- `refinamiento-v1.css`, `feature-visuales-v2.css`, `pricing-section.css` y
  `whatsapp-float.css` no tienen ningún `!important` sobre estos selectores
  — irrelevantes para el análisis (cargan antes, y `v935` les gana por
  orden igual).
- Única excepción real: `hero-transitions-v937.css` (carga último) pisa
  `.hero-stage` (`min-height`, `overflow`) y `.hero-sticky` (`position`,
  `top`, `min-height`) con `!important` en el mismo
  `@media (max-width:760px)`, para el scroll-jacking de las diapositivas
  (mecanismo de v939/v943, reafirmado con `min-height` explícito). Como
  ambos archivos usaban `!important` con igual especificidad de selector,
  **ya ganaba `hero-transitions-v937.css` antes de este cambio** (gana el
  que carga último) — sacarle el `!important` a esas dos reglas en `v935`
  no cambia el comportamiento real, porque ya estaban pisadas.

### 2) Se sacaron los 85 `!important` de `mobile-hero-v935.css`

Los otros 3 usos de la palabra en el archivo eran menciones en prosa dentro
del comentario de cabecera (explicando por qué existía el patrón), no
declaraciones CSS reales. Se reescribió ese comentario para reflejar el
nuevo mecanismo (gana por orden de carga + especificidad, no por fuerza
bruta) y se agregó una nota puntual, en el bloque donde corresponde, sobre
el hallazgo de `.hero-stage`/`.hero-sticky` ya pisados por
`hero-transitions-v937.css` — documentado para quien lo lea después, sin
tocar el comportamiento real del scroll-jacking (eso es una decisión de
producto aparte, no parte de este punto).

### 3) Cache-busting

`index.html` es la única página que carga `mobile-hero-v935.css` —
`?v=20260822-03` → `?v=20260822-04`.

## Verificación

- Balance de llaves OK (31/31) en `mobile-hero-v935.css`.
- 0 `!important` restantes fuera de comentarios.
- Diff sistemático: único cambio de contenido en `index.html` es el `?v=` de
  `mobile-hero-v935.css`; en `mobile-hero-v935.css`, comentario de cabecera
  reescrito + remoción mecánica de `!important` en las 85 declaraciones del
  cuerpo, sin cambios de valores.
- **No verificado en navegador real** — no hay forma de renderizar el hero
  acá (el HTML lo inyecta `app.js`, bundle sin fuente `.tsx` en este zip).
  Confirmación visual queda a cargo del usuario en dispositivo real.

## Checklist de verificación manual (sección 4 de la auditoría)

Se creó `checklist_responsive_mobile.md` en la raíz del proyecto, mismo
formato que `checklist_pase_manual.md` ya existente. Sección 0 prioriza
específicamente confirmar el hero tras este cambio (lo más importante de
esta sesión); el resto cubre los ítems de la sección 4 de la auditoría:
anchos mínimos (360×640 / 390×844 / 320×568), rotación landscape en
checkout/remito, teclado virtual abierto en formularios largos, e inputs de
Safari iOS que puedan disparar zoom automático.

## Pendiente

Con esto se cierran todos los puntos de priorización (P0/P1/P2/P3) de
`AUDITORIA_RESPONSIVE_MOBILE.md` a nivel de código. Queda únicamente la
confirmación visual en dispositivo real — no es una tarea de código, es el
paso siguiente natural para el usuario usando `checklist_responsive_mobile.md`.
