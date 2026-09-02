# v737 — Observabilidad: tarjetas genéricas → pills FiltroTabs (mismo estilo que Cheques/Cobranzas)

## Pedido
Las 4 tarjetas KPI de "Salud del sistema" (Eventos totales / Procesados /
Pendientes / En error) usaban el componente genérico `.kpi-card` (ícono
circular + label + valor grande) — no el formato simple de pill/pestaña
que ya tienen Cheques, Riesgo de cheques y Cobranzas ("Deuda total ·
Vencido · Por vencer · Al día").

## Cambio
Se reemplazó `.kpi-card` por **FiltroTabs**, el mismo componente
(`frontend/shared/filtro-tabs.js` + `.css`) que ya usan
riesgo-cheques.js, cheques.js, cta-cte.js (cobranzas), devoluciones.js y
whatsapp-conversaciones.js — no se inventó un componente nuevo.

- `frontend/admin/observabilidad.html`:
  - Sumado `<link>` a `filtro-tabs.css` y `<script>` a `filtro-tabs.js`.
  - `#cards-resumen` pasó de `class="obs-cards"` (grid de kpi-card) a
    `class="barra-filtros"` (contenedor que llena `FiltroTabs.crear()`).
  - Nueva nota chica `#obs-nota-sin-listener` debajo de la barra, para la
    aclaración de "N pendientes son de tipos sin listener" que antes vivía
    dentro de la card "Pendientes" (el pill no tiene lugar para texto
    largo).
  - La sección "Tiempo promedio pedido → facturación" (2 métricas de solo
    lectura, sin tabla que filtrar) pasó de `.obs-cards` a
    `.franja-resumen-sololectura` — la variante sin clic del mismo
    componente, ya usada en riesgo-cheques.html para "Monto en cartera /
    Rechazados históricos / Alertas de score".
  - Removida la grilla CSS `.obs-cards` (ya no se usa en la página).
  - Bump de cache-busting: `observabilidad-gentelella.css` v1→v2,
    `observabilidad.js`.

- `frontend/admin/js/observabilidad.js`:
  - `initFiltroTabsResumen()` (nueva, se llama una vez en `authReady`):
    arma la barra con `FiltroTabs.crear()`.
  - `renderResumen()`: ahora solo llama a
    `FiltroTabs.actualizarContadores()` en vez de generar HTML de cards;
    separado el manejo de la nota "sin listener" a su propio elemento.
  - `renderPorTipo()`: cada pill (`'', 'procesado', 'pendiente', 'error'`)
    ahora **filtra de verdad** la tabla "Por tipo de evento" de abajo —
    ej. clickear "En error" muestra solo los tipos de evento que
    actualmente tienen errores. Mismo criterio que el propio docstring de
    `filtro-tabs.css` describe como el caso de uso del componente
    ("cada indicador es una categoría real y filtrable de la tabla de
    abajo"), y coherente con cómo "En riesgo" filtra la tabla en
    riesgo-cheques.js — evita que el pill se vea clickeable pero no haga
    nada.
  - `renderTiempoFacturacion()`: genera el markup de
    `franja-resumen-sololectura` en vez de `_kpiCard(...)`.
  - Eliminado código muerto: `_kpiCard()`, `_svg()` y las constantes
    `_ICO_LISTA/_ICO_CHECK/_ICO_RELOJ/_ICO_ALERTA` (ya no las usa nada en
    el archivo).

- `frontend/admin/css/observabilidad-gentelella.css`:
  - Removido el bloque `.obs-card-nota` (era la nota dentro de la card
    "Pendientes", ya no existe esa card).
  - Agregado estilo mínimo para `.obs-nota-sin-listener` y un ajuste de
    padding para `.franja-resumen-sololectura` en esta pantalla.

## Por qué no solo un cambio visual
Se pudo haber maquetado el pill "a mano" sin tocar el filtrado de la
tabla, pero el propio componente FiltroTabs ya viene con estado
`activa`/hover/focus que comunica "esto es clickeable". Dejarlo sin
función real hubiera sido peor UX que las cards viejas. El filtro por
columna (`total/procesado/pendiente/error`) es puramente client-side
sobre los datos que ya llegan de `/api/admin/salud-eventos` — no se tocó
el backend.

## Testing manual
1. Entrar a `/admin/observabilidad` → la barra de arriba debe verse igual
   que "Deuda total / Vencido / Por vencer / Al día" en Cobranzas: primer
   pill resaltado en verde, resto blancos, contador dentro de cada uno.
2. Clickear "En error" → la tabla "Por tipo de evento" debe mostrar solo
   filas con `error > 0` (o el estado vacío si ninguna tiene errores).
3. Clickear "Eventos totales" → vuelve a mostrar todas las filas.
4. Si hay pendientes sin listener, la nota debe aparecer debajo de la
   barra (no dentro de ningún pill).
5. Abajo de la página, "Tiempo promedio pedido → facturación" debe verse
   como texto simple en línea (sin tarjetas), estilo franja de resumen.
