# v467 — Fix: colores de estado de pedidos inconsistentes entre pantallas

Tenías razón: el fix anterior solo tocó `dashboard-gentelella.css` en la sesión pasada pero no había quedado guardado, y además había más lugares con el problema de los que se habían detectado. Encontré 4 puntos distintos con esquemas de color diferentes para los mismos estados y los unifiqué todos contra la referencia "buena" (`frontend/cliente/pedidos.html`):

- **confirmado** → verde (success)
- **preparando** → amarillo (warning)
- **despachado** → azul (info)
- **entregado** → gris (muted)
- **cancelado** → rojo (danger)

## Archivos corregidos

1. **`frontend/admin/dashboard-gentelella.css`** — badges `badge-estado--confirmado/despachado/entregado` usaban verde-agua y azul propios de Gentelella en vez del esquema global.
2. **`frontend/admin/pedidos.html`** — los puntos de color del resumen lateral (`estado-dot`) usaban variables `--ge-blue`, `--ge-orange`, `--ge-purple`, `--ge-teal-dark` sueltas, sin relación con el resto del sistema.
3. **`frontend/admin/css/pedidos.css`** — la tabla de pedidos tenía "confirmado" en azul y "entregado" en verde (invertido respecto al resto), y "despachado" en violeta.
4. **`frontend/admin/css/pedidos-gentelella.css`** — este era el problema más importante: tiene overrides con `!important` que pisan a `pedidos.css` cuando la página usa la clase `dash-pedidos-gentelella` (que es el caso de `pedidos.html`). Aunque se corrigiera `pedidos.css`, este archivo seguía mostrando confirmado=azul, despachado=violeta, entregado=verde-agua. Ya corregido.
5. **`frontend/chofer/index.html`** y **`frontend/chofer/remito.html`** — tenían colores Bootstrap clásicos hardcodeados (`#fff3cd`, `#d1ecf1`, `#d4edda`) en vez de las variables de `tokens.css`.

## Por qué no se vio en la primera pasada

El fix en el chat anterior solo llegó a tocar `dashboard-gentelella.css`, y ni siquiera quedó aplicado en este proyecto (la búsqueda mostró los valores viejos todavía presentes). Además nunca se llegó a revisar `pedidos-gentelella.css`, que es justamente el archivo que gana por especificidad (`!important`) en la pantalla de pedidos del admin — por eso el problema persistía a pesar de haber "arreglado" `pedidos.css`.

## Lo que no puedo chequear yo

Igual que la vez pasada: esto lo revisé mirando el código, no abriendo cada pantalla. Te pido que abras:
- Admin → Pedidos (vista de lista y el resumen lateral)
- Admin → Dashboard (tarjetas de pedidos recientes)
- Portal chofer → lista de pedidos y remito

y me confirmes si ahora sí ves los 4 colores iguales en todos lados (verde/amarillo/azul/gris para confirmado/preparando/despachado/entregado).
