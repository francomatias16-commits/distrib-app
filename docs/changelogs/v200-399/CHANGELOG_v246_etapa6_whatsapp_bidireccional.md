# v246 — Etapa 6: WhatsApp Business API bidireccional

## Contexto
Segunda entrega de la Etapa 6 ("Integraciones externas"), después del export
contable (v245). Hasta acá el WhatsApp del sistema era unidireccional: el
piloto (068_piloto_whatsapp.sql) manda templates aprobados por Meta
(sugerencia de pedido, proximidad de entrega, deuda vencida) y el cliente
solo puede *confirmar* tocando un link al portal — nunca escribir.

Esta entrega agrega el lado que faltaba: **recibir** mensajes de texto libre
por WhatsApp y convertirlos en un pedido real, usando el mismo asistente de
IA (Gemini → Groq → OpenRouter, con function calling) que ya existe para el
asistente de ayuda interno (`lib/asistente-providers.js`), en vez de
construir un motor de IA nuevo desde cero.

Decisión de alcance (importante): el modelo **nunca** crea el pedido en
firme. Arma un borrador con tools acotadas (buscar catálogo real, agregar/
quitar ítems, proponer confirmación), y el pedido solo se crea cuando el
cliente contesta un "SÍ" explícito — eso lo detecta el handler con un regex
determinístico, no el modelo. Mismo criterio de "el modelo nunca decide
acciones irreversibles" que ya se usaba en el asistente de ayuda.

## Qué se agregó

### Backend (Supabase)
- **Migración `246_etapa6_whatsapp_bidireccional.sql`**:
  - `whatsapp_conversaciones` — una fila por número de teléfono con
    conversación en curso (estado, borrador de pedido en jsonb, teléfono →
    empresa/cliente resueltos).
  - `whatsapp_mensajes` — historial in/out. `wa_message_id` UNIQUE (parcial)
    para dedupear reintentos del webhook de Meta.
  - `resolver_cliente_por_telefono(p_telefono)` — matchea el número entrante
    contra `clientes` de TODA la plataforma (el número de WhatsApp del
    piloto es único y global, no por empresa — mismo criterio que
    `WA_PHONE_NUMBER_ID` en notif.js/piloto.js). Caso ambiguo (un mismo
    teléfono cliente de 2 empresas del piloto) documentado como limitación
    conocida, no bloqueante para esta entrega.
  - `v_whatsapp_conversaciones_activas` — vista de monitoreo para un futuro
    panel admin (no se armó pantalla nueva en esta entrega, ver "Pendiente"
    abajo).
  - RLS igual que `asistente_conversaciones` (204): lectura scopeada por
    empresa, escritura solo vía `service_role`.
  - Reutiliza `crear_pedido_cliente` y `resolver_precios_cliente` ya
    existentes (115_fix_canal_portal_real_crear_pedido_cliente.sql) — no se
    duplicó el motor de precios/stock, `canal='whatsapp'` ya era un valor
    aceptado (lo usa `confirmar_pedido_sugerido` del piloto desde el v068).

### Backend (API)
- **`lib/whatsapp-pedido-tools.js`** (nuevo): catálogo de tools del asistente
  de pedidos, mismo patrón que `lib/asistente-tools.js` pero con su propio
  contexto de ejecución (cliente identificado por teléfono, no usuario
  logueado): `buscar_productos`, `agregar_item`, `quitar_item`,
  `proponer_confirmacion`, `derivar_humano`.
- **`lib/handlers/notif.js`**:
  - Nuevo `_svc=whatsapp-webhook`: `GET` responde el `hub.challenge` de
    verificación de Meta (`WA_VERIFY_TOKEN`); `POST` recibe los mensajes.
  - Flujo completo: matchear teléfono → resolver/crear conversación →
    dedupe por `wa_message_id` → según estado (activa / esperando
    confirmación / derivada a humano) decide si llama al asistente, si
    confirma el pedido, si cancela el borrador o si deriva a un vendedor
    (con push a admins/vendedores de la empresa, mismo mecanismo que la
    alerta de token vencido).
  - Corte defensivo: más de 8 mensajes del cliente sin llegar a confirmar
    → deriva automáticamente (evita loops largos de costo de IA).
  - `enviarTextoWhatsApp()` — texto libre (no template), válido dentro de
    la ventana de servicio de 24h de Meta, que siempre aplica acá porque
    solo se usa para responder a algo que el cliente escribió recién.
    Respeta `esEmpresaDemo()` igual que el resto de las integraciones
    reales del proyecto.
- **`vercel.json`**: rewrite `/api/notif/whatsapp-webhook` →
  `/api/index?_mod=notif&_svc=whatsapp-webhook` (mismo Serverless Function
  consolidado, no se sumó una función nueva — seguimos dentro del límite
  de 12 de Vercel Hobby).

## Variables de entorno nuevas
- `WA_VERIFY_TOKEN` — string elegido por vos, se configura igual en Meta
  (App → WhatsApp → Configuration → Webhook) y en Vercel.
- Ya existían (se reutilizan): `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`,
  `GEMINI_API_KEY` (+ `GROQ_API_KEY`/`OPENROUTER_API_KEY` opcionales).

## Pasos para activarlo en Meta (pendiente de hacer manualmente)
1. En Meta for Developers → tu app → WhatsApp → Configuration: cargar la
   URL del webhook (`https://<tu-dominio>/api/notif/whatsapp-webhook`) y el
   `WA_VERIFY_TOKEN`.
2. Suscribir el campo `messages` del webhook.
3. Probar mandando un WhatsApp desde un teléfono que sea `clientes.telefono`
   de alguna empresa activa y no bloqueado.

## Pendiente / no incluido en esta entrega
- Pantalla admin para ver `v_whatsapp_conversaciones_activas` en vivo y
  tomar una conversación derivada manualmente (hoy solo llega el push).
- Envío de imágenes/ubicación del chofer u otros tipos de mensaje entrante
  (se derivan a humano directamente, ver `procesarMensajeNoSoportado`).
- Cola/reintentos propios si Meta reintenta el webhook por timeout del LLM
  (hoy se procesa sincrónico; para el volumen del piloto alcanza).
