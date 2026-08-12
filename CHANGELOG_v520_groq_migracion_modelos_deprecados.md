# v520 — Migración de los 2 modelos Groq deprecados (visión + texto)

## Contexto

Al probar el fallback de visión del v519 en producción, Groq devolvió
`404 model_not_found` para `meta-llama/llama-4-scout-17b-16e-instruct`.
Revisando el changelog oficial de Groq se confirmó que el 17/06/2026
deprecaron en el mismo anuncio **tres** modelos: `llama-4-scout`,
`qwen3-32b` y, más importante, `llama-3.3-70b-versatile` — que es el
modelo de TEXTO que usa este proyecto para prácticamente todo (no solo
para el fallback de imagen del v519).

Groq avisa que `llama-3.3-70b-versatile` deja de responder "en agosto
2026". Al momento de este fix estamos a 30/07/2026 — es decir, a días de
que se rompiera solo y se repitiera el mismo problema que ya pasó con
Scout (404 en producción, sin aviso previo dentro del código).

## Diagnóstico

1. **Visión (bug activo)**: `meta-llama/llama-4-scout-17b-16e-instruct`
   (configurado en el v519) ya no existe en la cuenta — 404 confirmado en
   logs reales de Vercel.
2. **Texto (riesgo inminente, todavía no roto)**: `llama-3.3-70b-versatile`
   sigue respondiendo hoy (los 429 vistos en logs son de cuota, no de
   modelo inexistente), pero está en la misma tanda de deprecación y
   Groq fija su corte para agosto 2026 — days away.

## Cambios

### `lib/asistente-providers.js`

- `CONFIG.groq.modeloVision`: `meta-llama/llama-4-scout-17b-16e-instruct`
  → `qwen/qwen3.6-27b` (default; override sigue siendo `GROQ_VISION_MODEL`).
  Es el modelo con visión vigente según la documentación actual de Groq
  (`console.groq.com/docs/vision`) — multimodal, tool calling, JSON mode.
  Sigue marcado "Preview" del lado de Groq, así que el riesgo de rotación
  futura sigue latente; por eso se mantiene como SEGUNDO intento, nunca
  reemplazando a Gemini (sin cambios en `PROVEEDORES_CON_VISION`).
- `CONFIG.groq.modelo`: `llama-3.3-70b-versatile` → `openai/gpt-oss-120b`
  (default; override sigue siendo `GROQ_MODEL`). Es el reemplazo que la
  propia Groq recomienda en su página de deprecaciones, y a diferencia de
  `qwen/qwen3.6-27b` NO está en estado Preview del lado de Groq — se buscó
  a propósito un modelo estable para el rol de texto principal, que es el
  que sostiene casi todo el tráfico del asistente.
- Comentarios actualizados en los dos bloques (`PROVEEDORES_CON_VISION` y
  el header de `CONFIG.groq`) para que no quede ninguna referencia viva a
  los nombres de modelo deprecados.

### `lib/asistente-tools.js`

- Comentario del FIX v514 actualizado: mencionaba
  `llama-3.3-70b-versatile` por nombre; ahora remite a `GROQ_MODEL` /
  `asistente-providers.js` para no volver a quedar desactualizado la
  próxima vez que Groq rote el modelo.

## Riesgo conocido, sin resolver acá

- `qwen/qwen3.6-27b` sigue en Preview — mismo riesgo de rotación que tuvo
  `llama-4-scout`. Si vuelve a pasar, el patrón de diagnóstico es el mismo:
  404 en logs de Vercel → revisar changelog de Groq → actualizar acá.
- `openai/gpt-oss-120b` tiene 8.000 TPM en el free tier (antes 12.000 con
  `llama-3.3-70b-versatile`). La selección dinámica de tools del v518
  (tope de 20 tools, ~4.000-5.000 tokens en la práctica) sigue entrando
  cómoda, pero el margen se achicó — si en el futuro reaparece un 413 de
  Groq, revisar el límite de TPM acá primero antes de asumir que es el
  mismo bug del v518.

## Archivos modificados

- `lib/asistente-providers.js`
- `lib/asistente-tools.js`
