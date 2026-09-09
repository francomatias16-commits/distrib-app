# Plan multi-proveedor de IA (asistente WhatsApp) — listo para activar plan pago

Este documento deja registrado todo lo diagnosticado y armado en esta sesión sobre
`lib/asistente-providers.js`, para que activar el plan pago (cuando se decida) sea
un trámite de 10 minutos y no haya que reconstruir el contexto de nuevo.

## 1. Diagnóstico de la situación (2026-09-09)

- El asistente de pedidos por WhatsApp (`lib/handlers/notif.js`) usa
  `responderConFallback()` (`lib/asistente-providers.js`) para hablar con 3
  proveedores de IA gratuitos: **Gemini, Groq y OpenRouter**, en cadena.
- Corriendo `scripts/eval-asistente-whatsapp.js` contra los 3, se detectaron
  fallas por cuota agotada en los tres, cada uno por un motivo distinto:
  - **Gemini**: cuota diaria (RPD) por proyecto de Google Cloud, se agota rápido
    en el free tier.
  - **Groq**: límite de **8.000 TPM (tokens por minuto) para
    `openai/gpt-oss-120b`**, aplicado **a nivel organización**, no por API key
    — tener 7 keys de la misma cuenta de Groq NO multiplica la cuota (los logs
    mostraron el mismo `org_id` en los 429 de distintas keys).
  - **OpenRouter**: sin key configurada en el entorno de prueba (pendiente,
    ver sección 3).
- Se confirmó que el sistema **ya tenía** el mecanismo correcto de rotación de
  keys para Gemini (`GEMINI_API_KEYS`, separadas por coma, funciona porque el
  límite de Gemini es por *proyecto* de Google Cloud, así que proyectos
  distintos sí dan cuota distinta).
- Se agregó el mismo mecanismo para Groq (`GROQ_API_KEYS`) — sirve para no
  perder una key si se revoca, pero **no aumenta la cuota real** al ser límite
  de organización.
- Se intentó activar el **Developer tier de Groq** (10x límites, $0 mínimo,
  solo tarjeta) — **actualmente pausado por Groq por falta de capacidad de
  cómputo**, sin ETA pública de reapertura. Ver
  `community.groq.com` (hilo "When is developer tier coming back?").

## 2. Decisión tomada

En vez de perseguir más proveedores gratis (se evaluó y descartó sumar
Cerebras por ahora: contexto capado a 8K y catálogo de modelos gratis inestable,
mismo problema que ya tuvimos con Groq deprecando modelos sin aviso),
**se decidió pagar**. Orden de prioridad:

1. **Gemini con billing activado** — es la opción disponible *ahora* (a
   diferencia de Groq, que está bloqueado), da el salto de límite más grande
   (de 5-15 RPM a 1.000-4.000 RPM en `gemini-2.5-flash`), y ya es el proveedor
   de mejor calidad de los tres para tool-calling.
2. **Groq Developer tier** — activar apenas Groq reabra las altas. Con 1-2
   keys de la cuenta ya usada alcanza (no hacen falta las 7).
3. **OpenRouter con crédito cargado** ($10 alcanza para pasar de ~50 a ~1000
   req/día) — se puede usar como puente mientras tanto, opcional.

## 3. Checklist para activar el plan pago (cuando se decida)

### Gemini (hacer esto primero)

- [ ] Confirmar en qué proyecto de Google Cloud están las `GEMINI_API_KEYS` de
      producción (Vercel → Environment Variables).
- [ ] Ir a [Google AI Studio](https://aistudio.google.com) → ese proyecto →
      **Set up Billing** → vincular tarjeta.
- [ ] Poner un tope de gasto mensual (Google Cloud → Billing → Budgets &
      alerts) — recomendado: empezar bajo (ej. $10-15/mes) y subir si hace
      falta, dado el estimado de costo real (sección 4).
- [ ] Verificar en `console.cloud.google.com` que el proyecto quedó en Tier 1.
- [ ] Re-correr `npm run eval:asistente-whatsapp` y confirmar que Gemini deja
      de mostrar `cuota realmente agotada` en la corrida completa.

### Groq (cuando reabran el Developer tier)

- [ ] Revisar `community.groq.com` o `console.groq.com/settings/billing`
      cada tanto.
- [ ] Cuando esté disponible: Settings → Billing → Add payment method →
      **configurar Spend Limit bajo** (ej. $5) como red de seguridad.
- [ ] Simplificar `GROQ_API_KEYS` a 1-2 keys de la cuenta principal (ya no
      hacen falta las 7 — el límite sigue siendo por organización, solo que
      ahora 10x más alto).

### OpenRouter (opcional, puente)

- [ ] Cargar $10 de crédito en `openrouter.ai` (sube de ~50 a ~1000 req/día).
- [ ] Confirmar `OPENROUTER_API_KEY` cargada en Vercel.

## 4. Estimación de costo (gemini-2.5-flash, $0,30/M input · $2,50/M output)

Con ~1.700-1.900 tokens de input por llamada (system prompt + esquema de
tools + historial) y tope de 300 tokens de output
(`MAX_TOKENS_RESPUESTA_WHATSAPP` en `lib/handlers/notif.js`), contando ~1.5-2
round-trips promedio por pregunta de cliente (por el tool calling):

| Preguntas/día | Costo/día aprox. | Costo/mes aprox. |
|---|---|---|
| 100  | $0,15-0,20 | $4,50-6 |
| 500  | $0,75-1    | $22-30 |
| 1.000| $1,50-2    | $45-60 |
| 5.000| $7,50-10   | $225-300 |

Estimación, no medición real — ver punto 5 para dejarlo medible de verdad.

## 5. Pendiente (mejora, no bloqueante): medir consumo real

Hoy los tokens reales por request (`resultado.tokens.prompt/completion/total`,
que ya devuelve `responderConFallback()`) solo se loguean por `console.log` en
`lib/handlers/notif.js` y se descartan — no quedan en Supabase. Para tener el
promedio real (no estimado):

- Agregar columnas `tokens_prompt` / `tokens_completion` a
  `whatsapp_mensajes` (mismo criterio que la migración 604, que ya agregó
  `tools_usadas` y `proveedor_usado` a esa misma tabla).
- Persistirlas en el mismo punto donde hoy se hace el `console.log`
  (`lib/handlers/notif.js`, alrededor de la línea 1466-1480).
- Con una semana de datos reales, se puede reemplazar la tabla de la sección 4
  por números reales y ajustar el tope de gasto mensual con precisión.

## 6. Cambios de código ya aplicados en esta sesión

- `lib/asistente-providers.js`: `CONFIG.groq.apiKeys` acepta múltiples keys
  (`GROQ_API_KEYS`), con rotación por cooldown de 60s ante 429 — mismo patrón
  que ya usaba Gemini, adaptado a que Groq no distingue "cuota agotada" de
  "límite transitorio" en el body del error.
- `ORDEN_PROVEEDORES` cambiado a `['groq', 'gemini', 'openrouter']`.
- `estadoProveedores()` expone `keysConfiguradas`/`keysEnCooldown` de Groq
  para el panel de diagnóstico.
- Patch aplicado: `asistente-providers-groq-primario.patch` (ver conversación
  anterior si hace falta reaplicar).

**Nota:** una vez que Gemini tenga billing activo y deje de agotar cuota a
mitad de jornada, tiene sentido volver a poner `ORDEN_PROVEEDORES` como
`['gemini', 'groq', 'openrouter']` — Gemini es el de mejor calidad, y con
billing activo ya no hace falta protegerlo poniéndolo segundo.
