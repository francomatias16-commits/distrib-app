# CHANGELOG v498 — dashboard-v3.html: ejecución del plan de mejoras (Fases 0, 1, 2 y 3)

Archivo tocado: `frontend/admin/dashboard-v3.html` (único archivo modificado).
Sin cambios de grid, tokens de color, tipografías base, ni tamaño/posición de tarjetas.

## Fase 0 — Quick wins
- **#1 Fugas de texto de desarrollo**: el tag junto a "Hoy en tu negocio" ya no muestra
  `obtener_kpis_dashboard_v3` (nombre de función RPC) — ahora dice "En vivo", con el detalle
  técnico movido a `title` (tooltip). En la tarjeta de Automatización se sacó la mención a
  `automatizacion.js` del texto visible (queda solo como comentario HTML interno).
- **#4 Bug de mapa de colores (Score · Cheques)**: se verificó contra la constraint real de
  Supabase (`chk_score_categoria`) que los valores válidos son
  `premium | bueno | normal | riesgo | bloqueado`. El mapa tenía `moderado` (que el sistema
  nunca escribe) y le faltaban `premium` y `normal` — corregido. El cliente con categoría
  `normal` ya no cae al color gris por defecto.
- **#6 Score sin escala visible**: se agregó un `card-tag` "Escala 0–100" en el header de
  Score · Cheques, reusando el componente existente.

## Fase 1 — Jerarquía dinámica
- **#2 y #3**: nuevo modificador `.card-alert` (borde superior 3px `--danger`) y nueva
  variante `sp-danger` del `status-pill` (mismo patrón que `sp-green`/`sp-amber`/`sp-wa`).
  La tarjeta "Reportes críticos" y un pill nuevo en el topbar ("Deuda vencida: $X") se activan
  automáticamente cuando `deuda_vencida > 0` o `cheques_rechazados > 0`, leído en vivo de
  `cargarCobranzaTab()` y `cargarScoreCheques()`. Sin tarjetas nuevas, sin cambios de grid.

## Fase 2 — Estados vacíos
- **#5**: el estado vacío de WhatsApp ahora tiene un botón "Conectar WhatsApp" que apunta a
  `whatsapp-onboarding.html` (verificado que existe en el proyecto). Se ajustó el color del
  botón porque `.btn-refresh` está pensado para fondos oscuros y el estado vacío tiene fondo
  claro (`#ECE5DD`) — se sobreescribió `border-color`/`color` inline para que sea visible,
  sin crear una clase nueva.
  - Pendiente (no incluido en este cambio): aplicar el mismo criterio de CTA a los estados
    vacíos de Cheques y POS — falta confirmar cuáles de esas pantallas ya existen como
    destino real antes de cablear un botón.

## Fase 3 — Tipografía
- **#7**: `.card-label` pasa a 11px/800/sentence case (antes 10px/700/uppercase/letter-spacing
  .07em). Todos los textos de `.card-label` en el HTML ya estaban escritos en sentence case,
  así que el cambio de CSS alcanza sin tocar el markup. `.card-tag` y `.inner-tab` no se
  tocaron — mantienen su tratamiento en mayúscula como etiqueta subordinada.

## Verificado en vivo contra Supabase (proyecto `jgiquzjwoedmzwqgzubr`) antes de aplicar
- `score_categoria` real: `normal: 1, null: 4` (sin cambios respecto al plan original).
- Constraint `chk_score_categoria` confirmada: `premium | bueno | normal | riesgo | bloqueado`.

## Validación técnica
- JS inline extraído y validado con `node --check` — sin errores de sintaxis.
- Balance de tags `div`/`span`/`button` verificado — sin tags huérfanos.
