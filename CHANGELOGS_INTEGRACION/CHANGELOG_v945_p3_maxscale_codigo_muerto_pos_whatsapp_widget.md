# CHANGELOG v945 — P3: zoom landing + código muerto (pos.css / whatsapp-widget.css)

**Fecha:** 2026-08-22
**Contexto:** Puntos 🟢 P3 de `AUDITORIA_RESPONSIVE_MOBILE.md` (sección 3, priorización),
después de cerrar P1 (breakpoints faltantes en 5 páginas) y P2 (migración de z-index a
variables, v938).

## Qué se hizo

### 1) `maximum-scale=1` en la landing (hallazgo 1.5) — ya estaba resuelto

Se verificó `frontend/landing/index.html`: el meta viewport ya no tiene
`maximum-scale=1` (quedó `width=device-width, initial-scale=1.0`, igual al resto del
sitio). Este punto de P3 se cerró en una sesión anterior a la auditoría — no requirió
cambios en este paquete.

### 2) Código muerto documentado en `frontend/admin/css/pos.css` (hallazgo 1.8)

El propio archivo traía un comentario (`AUDITORIA-RESPONSIVE-ETAPA2`) señalando dos
reglas que nunca se aplican porque el HTML real usa `id="pos-carrito-items"` con
`class="pos-ticket-tabla-body"` (no `class="pos-carrito-items"`), y las filas del
carrito siempre matchean el selector más específico `.pos-ticket-tabla-body
.pos-item-fila`, que gana por especificidad sin importar el orden de aparición.
Verificado contra `pos.html` y `pos.js` antes de tocar nada. Se eliminó:

- La regla `.pos-carrito-items { ... }` (nunca matchea ningún elemento real).
- La regla base `.pos-item-fila { display:grid; grid-template-columns: 1fr 52px 60px
  auto auto; ... }` (siempre pisada por la versión con scope `.pos-ticket-tabla-body
  .pos-item-fila`, que define su propio `grid-template-columns` distinto).
- Su override dentro de `@media (max-width: 480px)` (mismo motivo).
- El comentario que documentaba el problema, ya innecesario.

No se tocó `.pos-caja-kpis` (comparte el mismo bloque `@media (max-width: 480px)`
pero es una regla real y viva — confirmada contra su definición base en la sección
"KPIs de saldo"). Tampoco se tocaron `.pos-item-nombre`, `.pos-item-cant`,
`.pos-item-desc`, etc., que sí están vivas. Balance de llaves verificado (485/485)
tras el borrado. Cache-busting: `pos.html` es la única página que carga `pos.css`,
bump `?v=751` → `?v=752`.

### 3) `frontend/shared/whatsapp-widget.css` sin referenciar (hallazgo 1.9, nota)

Confirmado con grep sobre todo el proyecto: ningún `.html` tiene un `<link>` hacia
`whatsapp-widget.css` (la única coincidencia de texto era un comentario en
`migracion.html` que menciona `whatsapp-widget.js`, no la hoja de estilos). El
archivo `whatsapp-widget.js` sí se carga como `<script>` en `migracion.html`, pero
corre hoy sin su CSS asociado — es decir, la hoja ya estaba desconectada antes de
este cambio, no se rompió nada al borrarla. Se eliminó el archivo
`frontend/shared/whatsapp-widget.css`.

## Verificación

- Balance de llaves OK en `pos.css` tras el borrado.
- Grep de `pos-carrito-items` y `pos-item-fila` (base, sin scope) en todo el
  proyecto: 0 coincidencias restantes en CSS; el HTML/JS nunca los usó como
  selector de clase real.
- Grep de `whatsapp-widget.css` en `.html`/`.js` de todo el proyecto: 0
  coincidencias tras el borrado (antes tampoco había ninguna real).
- Diff sistemático: único cambio de contenido en `pos.html` es el `?v=` de
  `pos.css`; único cambio en `pos.css` es el borrado documentado arriba.

## Pendiente

- 🟡 P2 (resto, ya marcado pendiente desde v938): reducir `!important` de
  `mobile-hero-v935.css`, consolidando con `styles.css` — requiere QA visual.
- Checklist de verificación manual en dispositivo/emulador real (sección 4 de la
  auditoría) — ningún punto de la auditoría de análisis estático lo reemplaza.
