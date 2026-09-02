# CHANGELOG v740 — Bento grid para las stats de /admin/notif-log.html

## Motivo

Las 6 tarjetas de stats (Total, WhatsApp, Email, Push, Enviados, Sin ID) eran
`.stat-chip` genéricas: rectángulos idénticos, mismo tamaño, mismo color de
acento (`--ge-teal` para el número en las seis), sin jerarquía ni relación
visual con el dato que mostraban — pedido del dueño: nada genérico, un
tratamiento realmente distinto, apoyado en el skill de UI/UX Pro Max
provisto (dominio `style`, categoría **Bento Box Grid**: tarjetas modulares
de tamaño variado, esquinas redondeadas grandes, sombras suaves, jerarquía
clara).

Se armó un bento asimétrico con significado, no seis cajas iguales
reacomodadas:

- **Total** — tarjeta 2x2, la más grande. Además del número, suma una mini
  barra de mezcla de canales (WhatsApp/Email/Push) con su leyenda —
  derivada de los mismos conteos que ya calculaba `actualizarStats()`, sin
  pedir nada nuevo al backend.
- **WhatsApp / Email / Push** — 1x1 cada una, ícono en badge sólido del
  color de marca del canal (mismos SVG que ya usa `badgeCanal()` en la
  tabla — no se inventó un ícono nuevo, se reusó el existente).
- **Enviados** — 1x1, verde oscuro de marca, con la tasa de entrega
  (`enviados / total`) como subtítulo — otro dato derivado, mismo criterio.
- **"Sin ID"** — dejó de ser una 7ma tarjeta muda y pasó a un banner de
  atención aparte, con el mismo lenguaje visual que `.push-activar-card`
  (ícono + texto en una fila ancha), porque es el único de los seis
  números que le pide una acción al admin (revisar antes de reintentar),
  no solo informa. Confirmado contra `notif-log.js`: "Sin ID" = filas sin
  `message_id`, el mismo estado que en la tabla se pinta con `.badge-err`
  (rojo) — se usó el mismo `--ge-red`, no un color nuevo.

Entrada escalonada al cargar (`animation-delay` por tarjeta), respetando
`prefers-reduced-motion`. **Cero emojis** — todos los íconos son SVG
lineales, igual que en el resto del panel.

## Cambios

### `frontend/admin/notif-log.html`
- Reemplazado el bloque `<style>` de `.stats-bar`/`.stat-chip` por la
  estructura del bento grid (`.stats-bento`, `.bento-card`, `.bento-total`,
  `.bento-mix`, `.bento-alert`) — solo estructura/layout, sin color de
  marca (eso vive en el reskin, como en el resto de las pantallas).
- Reemplazado el markup de las 6 `.stat-chip` por las 4 `.bento-card` +
  el banner `.bento-alert`. Los 6 `id` que lee `notif-log.js`
  (`stat-total`, `stat-whatsapp`, `stat-email`, `stat-push`,
  `stat-enviados`, `stat-fallidos`) se mantuvieron intactos — cero cambios
  de lógica de negocio, solo el HTML que los envuelve.
- Responsive: 4 columnas → 2 columnas (900px) → 1 columna (560px), con la
  tarjeta Total ajustando su span en cada corte.

### `frontend/admin/css/notif-log-gentelella.css`
- Reemplazadas las reglas de `.stat-chip` por las de `.bento-*`, con los
  mismos criterios de color por canal que ya se usaron en el rediseño de
  `soporte.html` (v739): color pleno de la categoría vía `color-mix()`
  sobre `--ge-panel`, ícono en badge sólido, no un acento sutil en la
  esquina.
- Tokens usados: `--ge-teal`/`--ge-teal-dark`/`--ge-teal-light` (Total,
  Enviados), `--ge-whatsapp` (WhatsApp), `--ge-blue` (Email), `--ge-purple`
  (Push), `--ge-red` (banner Sin ID), `--ge-chip-bg` (fondo de la barra de
  mezcla). **Cero tokens nuevos** — los mismos que ya vivían en
  `frontend/shared/gentelella-tokens.css`.
- Actualizado el comentario de encabezado del archivo (desactualizado
  desde antes de este cambio: seguía describiendo el patrón `.stat-chip`
  como si aplicara a esta pantalla).

### `frontend/admin/js/notif-log.js`
- `actualizarStats()`: se agregaron ~10 líneas al final de la función para
  calcular el ancho (%) de cada segmento de la mezcla de canales y la tasa
  de entrega, y escribirlos en el DOM (`mix-wa`/`mix-email`/`mix-push`/
  `bento-tasa`). **No se tocó ninguna línea existente** — los 6
  `textContent` originales siguen exactamente igual, solo se agregó
  código nuevo debajo. Sin llamadas nuevas al backend: todo se deriva de
  `datos`, que la función ya recibía.

## Ajuste de consistencia (mismo v740) — easing

Al comparar contra el resto del proyecto (pedido del dueño, "¿está acorde
a la estética que viene?"), el hover/la animación de entrada usaban
`ease` genérico. El resto de las pantallas con este mismo tratamiento
(`.soporte-card`/`.canal-card` en soporte.html, y el patrón que reusan
dashboard.html/pedidos.html/puntos.html/setup.html) usa la curva firma del
proyecto `cubic-bezier(.22,1,.36,1)`. Se corrigió en las 3 transiciones/
animación del bento grid (`.bento-card`, `.bento-mix-seg`) para que el
movimiento se sienta igual al resto del panel. Radios (16px), degradé de
la tarjeta Total y el propio patrón de hover-lift + entrada escalonada ya
coincidían con lo ya aprobado en soporte.html — no se tocaron.

## Compatibilidad

- No se tocó ninguna lógica de filtrado, exportación CSV, modal de
  payload, ni el botón "Activar notificaciones push" — todo eso vive en
  otras funciones de `notif-log.js` que no se modificaron.
- Verificado que ninguna otra pantalla depende de `.stat-chip` dentro del
  scope `body.dash-notif-log-gentelella` (el selector `.stat-chip` sigue
  existiendo en `gentelella-fkpi.css` y en `whatsapp-conversaciones.html`,
  pero ambos están scopeados a sus propios `body.dash-*` y no se ven
  afectados).
