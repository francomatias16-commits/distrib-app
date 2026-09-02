# v825 — confirmación de 5 casos sueltos + offline-core.js migrado

## Confirmación de los 5 casos de 1 hit sin auditar (dejados pendientes en v824)

- **`topbar-widgets.js`**: `var(--color-border,#d1d5db)` — fallback
  desincronizado, corregido a `#DDE1DC`.
- **`productos-scanner-remoto.js`**: `color:#d97706` — hex crudo real
  (texto del link "reportar imagen incorrecta"), migrado a
  `var(--color-warning, #8A5F13)`.
- **`presupuestos.js`**, **`notas.js`**, **`conciliacion-bancaria.js`**:
  confirmados, ya tenían el fallback correcto — sin cambios.

## frontend/shared/offline-core.js — migrado completo

Los 21 casos de color de los badges de estado de sincronización
(conflicto/cuarentena/sync/offline/pendientes/online) ya tenían el
fallback correcto. El resto del archivo (modal de resolución de
conflictos):

- **Token falso `--color-bg-elevated`**: nunca se definió en ningún
  `.css` del proyecto — el navegador siempre renderizó el fallback
  `#fff` (mismo bug real que el punto 1 de la auditoría de HTML v489,
  no cosmético). Remapeado a `var(--color-surface, #FFFFFF)`.
- **2 fallbacks desincronizados**: `--color-text-muted,#666` → `#5B6660`;
  `--color-border` en dos lugares (`#ddd`/`#ccc`) → `#DDE1DC`.
- **2 overlays/shadows crudos** (`rgba(0,0,0,0.5)` del overlay,
  `rgba(0,0,0,0.3)` de la sombra del modal) → tinta `rgba(22,24,29,X)`.

Verificado con `node --check` en ambos archivos. Sin cambios visuales
esperados.

## Siguiente en la cola

`pedidos.js` (29 casos) — ver `audit_table.md`.
