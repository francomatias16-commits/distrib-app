# CHANGELOG v229 — Fase 1 auditoría responsive: escala de breakpoints + consolidación de `.filtros-bar`

**Fecha:** 2026-08-25
**Contexto:** Continuación de la Fase 1 de `PLAN_RESPONSIVE_MOBILE_COMPLETO.md`. El punto de
z-index ya se había resuelto en v938 (2026-08-22); quedaban pendientes la escala de
breakpoints y la consolidación de `.filtros-bar`, que tenía 4 definiciones compitiendo
sin ganador predecible entre archivos shared, más 25 redeclaraciones adicionales en
archivos `-gentelella.css` de página (detalle en `AUDITORIA_FILTROS_v280.md`).

## Qué se hizo

### 1) Escala de breakpoints en `frontend/shared/tokens.css`
`--bp-sm:480px`, `--bp-md:640px`, `--bp-lg:900px`, `--bp-xl:1200px`. Documentada como
convención (CSS plano no permite `var()` dentro de `@media`, así que son la fuente de
verdad en texto). Los 20 valores de `max-width` sueltos que hay hoy en el código NO se
migraron en este paso — se migran de forma incremental en Fase 2, archivo por archivo,
no de golpe.

### 2) Consolidación de `.filtros-bar` en `frontend/shared/componentes-admin.css`
Única definición, mobile-first (columna en la base, fila desde `--bp-md`/641px), sin
`!important`. Incluye layout, superficie visual (fondo/borde/sombra) e inputs/selects
hijos (con `font-size:16px` en mobile para evitar el zoom automático de iOS Safari).
Se neutralizaron —dejando comentario puntero, no borrado silencioso— las 3
redeclaraciones que competían: `adminlte-components.css` (bloque base + media query
mobile), `responsive-mobile.css` (bloque mobile con `!important`).

**Explícitamente fuera de este paso:** las 25 redeclaraciones `body.dash-<pagina>
.filtros-bar` en archivos `-gentelella.css` de página. Tienen mayor especificidad y
van a seguir ganando donde existan — tocarlas a ciegas en 25 archivos sin poder
verificar visualmente (Playwright bloqueado por red en este entorno) es un riesgo
innecesario. Queda para Fase 2, guiado por auditoría visual real.

### 3) Orden de carga en las 57 páginas de `frontend/admin/`
`componentes-admin.css` solo ganaba la cascada en 31/57 páginas: 22 páginas no lo
cargaban en absoluto, y en 4 se cargaba *antes* que `adminlte-components.css` /
`reskin-patch.css` / `responsive-mobile.css` (y por lo tanto perdía la pulseada pese a
tener la definición "correcta"). Se agregó el `<link>` faltante en las 22, y se movió
a la posición correcta (después de las 3 hojas que antes competían) en las 4
desordenadas. Las 31 restantes ya estaban bien.

### 4) Cache-busting
Bump de `?v=` para los 4 archivos tocados: `tokens.css` → 229, `adminlte-components.css`
→ 228, `responsive-mobile.css` → 700, `componentes-admin.css` → 2 (nuevo).

## Verificación
- Balance de llaves `{`/`}` OK en los 4 archivos CSS tocados.
- 0 páginas con `<link>` de `componentes-admin.css` duplicado (chequeo real, solo
  etiquetas `<link>`, no menciones en comentarios).
- 57/57 páginas cargan `componentes-admin.css` después de las 3 hojas con las que
  antes competía.

## Pendiente (Fase 2)
- Migrar los ~20 valores de `max-width` sueltos a `--bp-sm/md/lg/xl`, incremental.
- Revisar y, donde corresponda, retirar las 25 redeclaraciones `body.dash-<pagina>
  .filtros-bar` de los archivos `-gentelella.css`, con QA visual real (bloqueado acá
  por falta de acceso de red a `cdn.playwright.dev` para Chromium).
- Consolidar el resto de los ~6 selectores mencionados en el plan (`.tabla-wrap`,
  `.modal`, `.chip`, `.badge-estado`, `.btn-exportar/importar`) — no se tocaron en
  este paso, que se limitó a `.filtros-bar` por ser el origen puntual del bug
  reportado.
