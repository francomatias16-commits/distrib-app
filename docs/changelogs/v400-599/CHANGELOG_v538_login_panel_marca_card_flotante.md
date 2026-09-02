# v538 — Panel de marca del login: card flotante + texto legible + ícono Fluxo

## Problema
El panel derecho del login (`login-col-brand`) ponía el título/descripción
directamente sobre la nube SVG en blanco. Con la curva de amplitud grande,
el texto blanco caía a veces sobre zonas claras de la nube → texto blanco
sobre fondo claro, ilegible.

## Fix
- El contenido (eyebrow, logo del cliente, nombre, descripción) pasó a vivir
  en `.login-brand-card`: una tarjeta blanca (`var(--color-surface)`) que
  flota centrada sobre la nube, con `box-shadow` propio.
- Título y descripción en `var(--color-text)` (#16181D, casi negro),
  garantizado legible sobre el blanco de la card.
- Curva del SVG (`login-cloud-bg`) simplificada, queda como fondo decorativo
  detrás de la card.
- Se agregó el ícono real de Fluxo (`logo-fluxo.png`) en la línea de marca
  al pie del login ("Sistema de distribución con tecnología de [Fluxo]").
- Copy de la descripción reescrito a un tono profesional/comercial
  orientado a distribuidoras.

## Nota
Superado por v539: este panel dependía de una RPC de tenant que podía
quedar en "Cargando..." indefinido en dominios sin empresa resuelta.
v539 lo reemplaza por un panel de marca Fluxo estático.

## Archivos modificados
- `frontend/admin/css/login.css`
- `frontend/admin/login.html` (bump cache-bust `login.css?v=198`)
