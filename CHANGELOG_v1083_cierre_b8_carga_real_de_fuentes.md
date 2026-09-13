# v1083 — Cierre B8: las fuentes del reskin (IBM Plex Sans / Oswald) nunca se cargaban en el navegador

## Contexto

El plan de cierre (`docs/planes/PLAN_CIERRE_DEFINITIVO_2026-09.md`) describía B8 como
"convivencia de dos sistemas tipográficos: Inter (reskin nuevo) vs Source Sans 3 (Gentelella
viejo)" y lo marcaba como decisión de producto, no bug. Esa descripción corresponde a un
problema que ya se había cerrado por completo el 2026-07-26 (`docs/auditorias/AUDITORIA_UX_COMPLETA.md`,
"CERRADO — Tipografía Source Sans 3 → Inter, no reabrir").

Al re-auditar contra el código real de este ZIP apareció un problema distinto, posterior a ese
cierre: la Fase 0 del rediseño (`docs/reportes/DESIGN_SYSTEM_HOJA_DE_RUTA.md`) cambió
`frontend/shared/tokens.css` para que `--font-family`/`--font-family-display` apunten a
**IBM Plex Sans** y **Oswald** en vez de Inter — pero nunca se actualizó el `<link>` de Google
Fonts que las 67 páginas del panel siguen cargando: todas pedían `Inter` (que dejó de estar en
la cadena de fallback de `--font-family`) y ninguna pedía IBM Plex Sans, Oswald ni IBM Plex Mono.

Efecto real en producción: cada carga de página bajaba `Inter` de Google Fonts sin usarlo en
ningún lado, y el texto entero de la plataforma (títulos, KPIs, tablas, montos) renderizaba con
el fallback del sistema operativo (`-apple-system`/`Segoe UI`/`sans-serif`), no con la tipografía
que define la identidad visual actual del producto.

## Fix

Reemplazado el `<link href="…family=Inter…">` por:

```
https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Oswald:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap
```

- **66 páginas** que ya tenían el link de Inter: reemplazo directo de la URL, mismo `<link>`.
- **`frontend/admin/dashboard.html`**: tenía el `preconnect` pero nunca el `<link>` real de la
  fuente (ni Inter ni nada) — se agregó.
- **`frontend/cliente/catalogo.html`**: mismo caso que dashboard.html, sin ningún `<link>` de
  fuente — se agregaron `preconnect` + el `<link>` real.

Pesos elegidos por uso real en el CSS: IBM Plex Sans 400/500/600/700 (los 4
`--font-weight-*` de `tokens.css`), Oswald 500/600/700 (`.titulo-seccion`/`.kpi-valor` usan 600,
los `hero-num` inline de `dashboard.html` usan 700), IBM Plex Mono 400/500/600 (`.dato-mono`,
celdas numéricas de tablas).

**Fuera de alcance a propósito:** `frontend/landing/*` y `frontend/index.html`. Son landings
independientes con sus propios sistemas tipográficos autohospedados (PPMori/ESBuild la primera,
Manrope/Space Grotesk/DM Mono la segunda) — no cargan `shared/tokens.css` y no forman parte de
la dualidad que describía B8.

## Verificación

- `node scripts/check-asset-wiring.js`: 87 páginas revisadas, 1982 referencias, **0 rotas**.
- `npx vitest run`: **145/145 archivos, 2024/2024 tests** verdes (cambio 100% de HTML estático,
  no toca ningún handler/repo).
- Revisado archivo por archivo que el único cambio real por página fue esa línea de `<link>`
  (diff de una línea agregada/quitada por archivo, sin tocar el resto del documento).

## Nota aparte, sin relación con B8

Al hacer el reemplazo se detectó que 8 de los 66 archivos (`auditoria.html`,
`catalogo-meta.html`, `clientes-fuga.html`, `empresa-config.html`, `pedidos.html`, `rutas.html`,
`whatsapp-onboarding.html`, `chofer/remito.html`) usan finales de línea CRLF en el resto del
repo — un primer paso de edición automatizada los había normalizado a LF por un detalle de
manejo de encoding, sin tocar contenido. Se revirtió antes de este commit para que el diff de
cada archivo sea exclusivamente la línea del `<link>`.
