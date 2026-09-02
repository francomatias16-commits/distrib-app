# v491 — Migración de colores en JS: lote 2 (fallbacks stale + hardcodeos mecánicos)

Segundo lote del frente JS. Cierra los 8 archivos identificados como "mecánicos"
en el changelog v490, salvo `migracion-badge.js` (ver más abajo).

## Resuelto en este lote (7 archivos)

**`migracion.js`** — tabla de superadmin sin ningún var() alrededor: grises
(`#9ca3af`→`--color-text-light`, `#6b7280`→`--color-text-muted`), borde de fila
(`#f3f4f6`→`--color-border-soft`), verde de "filas válidas" (`#16a34a`→
`--color-success`), rojo de error (`#dc2626`→`--color-danger`, 3 lugares).

**`push-admin.js`** — toast de notificación: fondo/borde blanco-gris crudo
tokenizados (`--color-surface`, `--color-border-soft`), grises de texto
(`#888`→`--color-text-light`, `#555`→`--color-text-muted`), y dos fallbacks
stale de `--color-primary`/`--color-primary-bg` que apuntaban a Electric Blue
heredado (`#1a56db`, `#e8f0fe`).

**`fidelizacion.js`** — badge de estado activa/inactiva tokenizado
(`--color-success-bg`/`--color-surface-2` según estado), botón toggle
activar/desactivar (`--color-danger`/`--color-success`), y el mapa `CLR` de
tipo de movimiento (ganancia/canje/ajuste/bonus) mapeado a
`--color-success`/`--color-danger`/`--color-warning`/`--nav-facturacion`
(este último es el único "violeta" que ya existe en el sistema de tokens).

**`riesgo-cheques.js`** — fallback stale de `--color-warning` (`#b45309`→
`#7A4A00`, 2 lugares) y el mismo patrón `--color-success-bg`/`--color-success`
con valores dark-mode que ya se corrigió en `cheques.js` en el lote 1.
`CLIENTE_PALETTE` (paleta categórica para el gráfico por cliente) se dejó
intacta a propósito — mismo criterio que la paleta de ECharts.

**`rutas-resumen.js`** — donut de progreso de entregas: Electric Blue heredado
(`#2563EB`→`#B87A00`) y grises viejos (`#E2E8F0`/`#0F172A`) actualizados a los
valores vigentes. Mapa `colores` de estado de reparto (entregado/no_entregado/
pendiente/en_camino) para los pines del mapa, migrado a las variantes
`--color-box-*` del sistema (pensadas justamente para íconos/marcadores con
fondo sólido). El aro blanco del pin (`border:2px solid #fff`) y la sombra se
dejaron igual — es una técnica de contraste del marcador, no un color de marca.

**`dashboard-ejecutivo.js`** — este era el caso más claro: tenía la paleta
ECharts vieja completa hardcodeada en línea (`#AAB7B8`, `#26B99A`, `#d0d5db`,
`#e8ebee`, más el gradiente `rgba(38,185,154,…)`) en vez de usar
`inicializarTemaECharts()` del archivo compartido — exactamente los mismos
valores que tenía `echarts-gentelella-theme.js` antes del fix del lote 1.
Actualizados a los valores vigentes de `gentelella-tokens.css`. El gris
`#C8D0D4` de la serie "mes anterior" se dejó igual: es un gris de comparación
deliberadamente distinto del resto, no coincide con ningún token existente.

**`facturacion.js`** — 3 fallbacks stale de `--color-danger`/`--color-success`/
`--color-warning` con hex viejo, mismo patrón que el resto.

## Dejado como está (con razón)

- **`migracion-badge.js`** (13 ocurrencias) — paleta violeta autocontenida
  (`rgba(168,85,247,…)`, `#a855f7`, `#7c3aed`, `#6d28d9`) para el badge de
  "en migración". No until decidir un criterio: si la colapso a un solo token
  violeta (`--nav-facturacion`, el único violeta que existe hoy) pierdo la
  gradación de 3 tonos que usa para hover/texto/borde, y no hay tokens
  `--violeta-light/-dark` definidos para preservarla. Necesita definirse antes
  de tocarlo — no es un fallback roto, es una paleta que nunca se pensó en
  términos de tokens.

## Pendiente — resto del frente JS (~22 archivos)

Quedan los de mayor volumen (`busqueda-global.js`, `productos.js`, `pedidos.js`,
`remito.js`, `cc-proveedores.js`, `rutas.js`, `stock.js`, `pos.js`,
`notas-internas.js`, `dashboard-optimizado.js`, `compras.js`,
`reportes-financieros.js`, `reportes-stock.js`, `reportes-ventas.js`,
`automatizacion.js`, `pos-offline.js`, `presupuestos.js` restante, etc.) — la
mayoría con la misma paleta categórica por tipo de entidad que se vio en
`busqueda-global.js`, sin token equivalente. Ahí sigue pendiente la decisión de
si se arman tokens categóricos nuevos (`--cat-cliente`, `--cat-producto`, etc.)
o se dejan como diseño deliberado.
