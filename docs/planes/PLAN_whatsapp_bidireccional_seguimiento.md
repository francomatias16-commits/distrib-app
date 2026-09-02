# Plan de integración — WhatsApp bidireccional (Etapa 6)

Documento de seguimiento para dejar operativo el asistente de pedidos por
WhatsApp que ya está construido en el código (`lib/handlers/notif.js` →
`whatsappWebhookHandler`, `lib/whatsapp-pedido-tools.js`, migración
`247_etapa6_whatsapp_bidireccional.sql`) pero que nunca recibió tráfico
real (0 filas en `whatsapp_conversaciones` al día de hoy).

Marcá cada casillero (`- [ ]` → `- [x]`) a medida que avanzás. Los campos
`________` son para completar con tus propios datos (no los compartas
fuera de este documento — son credenciales).

---

## Etapa 0 — Auditoría del estado actual (ya hecha)

- [x] Motor de conversación / tools / dedupe revisado — sólido.
- [x] Migración 246/247 confirmada aplicada en vivo contra Supabase
      (`jgiquzjwoedmzwqgzubr`), 0 conversaciones registradas.
- [x] Ruta ya cableada en `vercel.json`
      (`/api/notif/whatsapp-webhook` → `_mod=notif&_svc=whatsapp-webhook`).
- [x] Hallazgo: el webhook **no valida la firma de Meta**
      (`X-Hub-Signature-256`) → cualquiera que adivine la URL puede
      simular ser un cliente tuyo por teléfono.
- [x] Hallazgo: el webhook **no tiene rate limiting** (la ruta lo saltea
      a propósito porque Meta no manda tu token de usuario, pero eso lo
      deja sin ningún freno ante abuso).
- [x] Hallazgo: **no existe pantalla admin** para ver conversaciones en
      curso ni tomar las derivadas a un vendedor.

---

## Etapa 1 — Configuración en Meta for Developers (manual, la hacés vos)

- [x] Entrar a Meta for Developers → tu app → **WhatsApp → Getting
      Started**. — App "empresa", ID `2765961223784707`.
- [x] Anotar `WA_PHONE_NUMBER_ID`: `1006267522574173`
- [x] Generar token de acceso. Para pruebas alcanza el temporal, pero
      para no cortar en medio del testing conviene un **token de System
      User permanente** (Business Settings → System Users → Generate
      token, permiso `whatsapp_business_messaging`).
  - [x] `WA_ACCESS_TOKEN` generado y guardado en un lugar seguro (no acá).
        Confirmado: token de System User permanente, no se corta durante
        el testing de la Etapa 6.
- [x] Anotar el **App Secret** (App → Settings → Basic → App Secret →
      "Show"). Se usa en la Etapa 3 para validar la firma del webhook.
  - [x] `WA_APP_SECRET` guardado en un lugar seguro (no acá).
- [x] Agregar un **número de prueba** (WhatsApp → API Setup → sección
      "To" → "Manage phone number list") para no arriesgar tu número
      real ni gastar en conversaciones de producción durante el testing.
  - [x] Número de prueba agregado: `+1 (555) 667-8328` (número de prueba
        de Meta, ya asignado).
- [x] **No cargar todavía la URL del webhook en Meta** — se hace en la
      Etapa 4, después de tener el endpoint hardened (Etapa 3).

---

## Etapa 2 — Variables de entorno en Vercel

Proyecto → Settings → Environment Variables. Marcar cuando cada una esté
cargada (Production **y** Preview si probás desde una preview branch):

- [x] `WA_PHONE_NUMBER_ID`
- [x] `WA_ACCESS_TOKEN`
- [x] `WA_VERIFY_TOKEN` — string que inventás vos, ej. un UUID random.
- [x] `WA_APP_SECRET` (nueva — para la validación de firma de la Etapa 3)
- [x] `GEMINI_API_KEY` — confirmado cargado (la reutiliza el asistente de
      ayuda interno).
- [x] `GROQ_API_KEY` / `OPENROUTER_API_KEY` — opcionales, fallback del
      asistente si Gemini falla.
- [x] Redeploy disparado después de cargar las variables (Vercel no las
      aplica a deploys ya existentes).

---

## Etapa 3 — Hardening del webhook *(código — lo hago yo)*

- [x] Validación de `X-Hub-Signature-256` con `WA_APP_SECRET` en
      `whatsappWebhookHandler` — rechazar con 401 cualquier POST que no
      traiga la firma correcta.
      Implementado en `lib/handlers/notif.js` (`firmaValidaDeMeta`,
      HMAC-SHA256 + `crypto.timingSafeEqual`). Requirió también tocar
      `api/index.js`: se desactivó el bodyParser automático de Vercel
      (`config.api.bodyParser = false`) y se agregó parseo manual del
      body para preservar los bytes crudos (`req.rawBody`) — sin eso la
      firma nunca matchea porque HMAC se calcula sobre el JSON parseado,
      no sobre los bytes originales. El cambio es transparente para los
      demás ~25 módulos (`req.body` les llega igual que antes).
- [x] Rate limit propio para la ruta del webhook (más permisivo que el
      de usuarios logueados, pero no cero) para contener abuso aunque
      alguien encuentre la URL.
      `limiterWebhookWhatsApp` (60 req/min por IP) en `notif.js`.
- [x] Sintaxis verificada (`node --check`) y cambios empaquetados.

✅ **Confirmado contra Meta real**: la validación de firma y el rate
limit quedaron probados en la Etapa 4 — el `GET` de verificación
respondió 200 y el webhook quedó "Verified" en Meta.

---

## Etapa 4 — Activar el webhook en Meta

- [x] Meta → tu app → WhatsApp → Configuration → **Webhook**: cargada
      `https://<tu-dominio>/api/notif/whatsapp-webhook` + el
      `WA_VERIFY_TOKEN` de la Etapa 2.
- [x] Confirmado que el `GET` de verificación responde `200` (Meta lo
      marca como "Verified" en la UI).
- [x] **Subscribe** al campo `messages` del webhook.

---

## Etapa 5 — Pantalla admin de conversaciones *(código — lo hago yo)*

- [x] Panel nuevo sobre la vista `v_whatsapp_conversaciones_activas` ya
      existente: lista de conversaciones activas/derivadas (cliente,
      estado, borrador actual, motivo de derivación).
      `frontend/admin/whatsapp-conversaciones.html` + `.js`, ruta
      `/admin/whatsapp-conversaciones` (rewrite en `vercel.json`), nav
      nueva en la sección "Ventas" (`dueno`, `admin`, `vendedor`).
      Listado y detalle se leen directo por Supabase client (RLS ya
      scopea por empresa — misma lógica que `notif-log.js`); poll cada
      30s para refrescar el listado sin interrumpir un modal abierto.
- [x] Detalle con historial de mensajes de una conversación (burbujas
      in/out, tipos no soportados por el panel se marcan aparte) y el
      borrador de pedido en curso si lo hay.
- [x] Acción para que un vendedor marque una conversación derivada como
      "tomada" (o la libere). No se agregó policy de UPDATE a propósito
      — pasa por `/api/notif/whatsapp-conversacion-accion`
      (`whatsappConversacionAccionHandler` en `notif.js`, service_role +
      validación manual de empresa/rol). Columnas nuevas `tomada_por` /
      `tomada_en` en migración `271_etapa6_whatsapp_conversacion_tomada.sql`,
      ortogonales a `estado` (no se tocó el CHECK ni el ruteo del
      webhook). Un vendedor no libera lo que tomó otro vendedor; dueño
      y admin sí.
- [ ] *(Fuera del alcance del primer test, para una segunda vuelta)*:
      responder directamente desde el panel en vez de desde el WhatsApp
      Business del celu.

  ✅ Migración 271 aplicada contra Supabase — panel operativo.

---

## Etapa 6 — Plan de pruebas guiado

Con el número de prueba de la Etapa 1, desde otro teléfono mandale un WA
al número de negocio y tildá cada caso:

- [ ] **Pedido simple**: pedís 1-2 productos por nombre, el bot los
      encuentra en el catálogo real, arma el resumen, confirmás con
      "sí" → se crea el pedido (verificar en `/admin/pedidos`).
- [ ] **Arrepentirse a mitad de camino**: en el paso de confirmación,
      contestar "no"/"cancelar" → vuelve a estado activo, borrador
      vacío, no se crea ningún pedido.
- [ ] **Mensaje no soportado**: mandar una foto o ubicación → debe
      derivar a humano automáticamente y avisar por push.
- [ ] **Corte por exceso de turnos**: mandar más de 8 mensajes sin
      llegar a confirmar → debe derivar solo, sin loop infinito.
- [ ] **Stock insuficiente**: pedir una cantidad mayor a la disponible y
      confirmar → debe avisar el motivo sin romper la conversación.
- [ ] **Reintento de Meta / mensaje duplicado**: si es posible forzarlo
      (o probar mandando el mismo texto dos veces rápido), confirmar que
      no se duplica el pedido ni la respuesta.
- [ ] **Cliente no identificado**: escribir desde un número que no es
      `clientes.telefono` de ninguna empresa → el sistema no debe
      responder nada automático (evita costo de conversación de Meta).
- [ ] **Derivación manual pedida por el cliente** ("quiero hablar con
      alguien") → debe derivar y notificar por push a admin/vendedores.

---

## Etapa 7 — Antes de pasar a producción real

Objetivo: que cada empresa cliente pueda salir del sandbox sin depender
de que su dueño haga trámites pesados de Meta a mano. La vía elegida es
**Embedded Signup**, no la verificación de negocio completa (esa última
solo hace falta para subir límites de volumen — 250 → 100.000 mensajes/
día — no para poder mandar el primer mensaje).

### 7.1 — Integrar Embedded Signup en tu propia app *(código — lo hago yo)*

- [x] Registrar tu app como **Business-type app** en Meta for Developers.
      Confirmado — `frontend/env-config.js` trae `WA_APP_ID:
      '2765961223784707'` con la nota "app 'empresa' (Business-type,
      confirmada Etapa 7.1)".
- [x] Facebook Login for Business → Settings → Client OAuth Settings:
      dominio cargado en **Allowed Domains** y **Valid OAuth Redirect
      URIs** — el flujo de Embedded Signup ya completa correctamente
      (ver v287, fix de layout de la pantalla de onboarding, y v288
      más abajo).
- [x] Crear una **Configuration** de Embedded Signup → `Configuration ID`
      anotado en `frontend/env-config.js` (`WA_EMBEDDED_CONFIG_ID:
      '28288615890741251'`, "ES Config", creada 11 jul 2026). Se había
      transcripto con un dígito de más al principio — corregido en
      `CHANGELOG_v288_fix_config_id_whatsapp.md`.
- [x] Agregar el JS SDK de Facebook + botón "Conectar mi WhatsApp" en el
      panel admin (pantalla de onboarding de empresa). Al completarse el
      flujo, el frontend recibe `waba_id`, `phone_number_id` y un
      `code` de un solo uso.
      `frontend/admin/whatsapp-onboarding.html/.js`, ruta
      `/admin/whatsapp-onboarding` (rewrite en `vercel.json`), nav nueva
      en "Configuración" (`dueno`, `admin`).
- [x] Backend nuevo: endpoint que reciba `waba_id` / `phone_number_id` /
      `code`, haga el intercambio server-to-server por un token
      (`GET /oauth/access_token` con `client_id` + `client_secret` +
      `code`), y guarde el `WA_PHONE_NUMBER_ID` / token asociado a esa
      empresa en la base (hoy son variables de entorno globales — pasan
      a ser datos por empresa).
      `whatsappEmbeddedSignupHandler` en `lib/handlers/notif.js`, tabla
      `empresa_whatsapp` (migración `272_etapa7_whatsapp_embedded_signup.sql`).
- [x] Suscribir el WABA de cada empresa a los webhooks (`messages`) —
      con Embedded Signup esto se puede automatizar en el mismo backend,
      sin que el dueño toque nada en Meta.
      Se hace dentro de `whatsappEmbeddedSignupHandler`, después de
      registrar el número.
- [x] Adaptar `whatsappWebhookHandler` para resolver la empresa por
      `phone_number_id` en vez de asumir un único número global.
      `resolverCredencialesWhatsapp` (con fallback a las env vars
      globales para empresas que siguen en el sandbox) +
      `resolverEmpresaCliente` ahora prioriza `phone_number_id` sobre
      el teléfono del cliente.

  ✅ Migración 272 aplicada contra Supabase (`jgiquzjwoedmzwqgzubr`) —
  tabla `empresa_whatsapp` + vista `v_empresa_whatsapp_estado` con RLS
  operativas, registrada en `schema_migrations_registry` (id 29).

  ✅ **Configuración completa** (código + los 3 ítems manuales de Meta):
  `WA_APP_ID` / `WA_EMBEDDED_CONFIG_ID` ya están cargados en
  `frontend/env-config.js`, y `WA_APP_ID` / `WA_APP_SECRET` en las env
  vars del backend desde la Etapa 2. Esta sección estaba desactualizada
  — quedaba marcada como pendiente algo que ya se había resuelto en
  v287/v288. Lo único que sigue pendiente de verdad es la prueba
  manual de la Etapa 7.2 (dueño conectando su propio WhatsApp) — ver
  nota al pie: se deja para después junto con el resto de las pruebas
  contra Meta real de la Etapa 6.

### 7.2 — Lo que hace el dueño de la distribuidora (minutos, no trámite)

- [ ] Clic en "Conectar mi WhatsApp" desde tu panel.
- [ ] Iniciar sesión con su Facebook / crear o elegir su portfolio de
      negocio.
- [ ] Verificar su número con el código que le llega por SMS o llamada.
- [ ] Listo — sale del sandbox, sin lista de destinatarios permitidos.

### 7.3 — Antes de vender esto en serio

- [ ] Probar el flujo completo con una **sandbox account** de Meta
      (dura 30 días, simula un cliente real sin usar tu Facebook
      personal) antes de mostrárselo a un cliente de verdad.
- [ ] Confirmar que la empresa con la que vas a operar en real **no**
      está marcada como demo (`esEmpresaDemo`) — si lo está, los envíos
      salientes se simulan en vez de mandarse de verdad.
- [ ] Revisión rápida de costos: con Embedded Signup los mensajes se
      facturan por plantilla entregada (billing cambió a esa modalidad
      en 2025) + tokens de IA por conversación. El corte de 8 turnos sin
      confirmar ya protege del caso peor.
- [ ] Límite por defecto: 10 empresas nuevas onboardeadas por semana. Si
      pensás escalar más rápido, ahí sí hace falta completar Business
      Verification + App Review (pero es un trámite tuyo, una sola vez,
      no de cada cliente).
- [ ] Aviso al equipo de vendedores de que empiecen a recibir
      derivaciones por push y sepan qué hacer con ellas.

---

## Registro de cambios de código de esta iniciativa

| Fecha | Etapa | Archivo(s) | Estado |
|-------|-------|-----------|--------|
| 2026-07-10 | 3 — Hardening firma + rate limit | `lib/handlers/notif.js`, `api/index.js` | ✅ hecho (código), ⬜ sin probar contra Meta real |
| 2026-07-10 | 5 — Panel admin conversaciones | `frontend/admin/whatsapp-conversaciones.html/.js`, `lib/handlers/notif.js` (`whatsappConversacionAccionHandler`), `supabase/migrations/271_etapa6_whatsapp_conversacion_tomada.sql`, `vercel.json`, `frontend/admin/js/nav-data.js` | ✅ hecho — código y migración aplicada |
| 2026-07-11 | 7.1 — Embedded Signup (código) | `lib/handlers/notif.js` (`resolverCredencialesWhatsapp`, `whatsappEmbeddedSignupHandler`), `supabase/migrations/272_etapa7_whatsapp_embedded_signup.sql`, `frontend/admin/whatsapp-onboarding.html/.js`, `frontend/env-config.js`, `vercel.json`, `frontend/admin/js/nav-data.js` | ✅ hecho — código y migración 272 aplicada |
| 2026-07-11 | 7.1 — Fix layout onboarding | `frontend/admin/whatsapp-onboarding.html` (v287) | ✅ hecho |
| 2026-07-11 | 7.1 — Fix Configuration ID | `frontend/env-config.js` (v288) | ✅ hecho — `WA_EMBEDDED_CONFIG_ID` real cargado, config de Meta completa |
| 2026-08-01 | 6 — Fix push en `derivar_humano` (v555) | `lib/whatsapp-pedido-tools.js`, `lib/handlers/notif.js` (link de `marcarDerivada`), `tests/handlers/whatsapp-pedido-tools.test.js` (nuevo) | ✅ hecho — suite 64/64 |
| 2026-08-01 | 6 — Tests del motor de conversación (v556) | `lib/handlers/notif.js` (export de `procesarMensajeTexto`/`procesarMensajeNoSoportado`), `tests/handlers/whatsapp-motor-conversacion.test.js` (nuevo) | ✅ hecho — suite 69/69, sin bugs nuevos encontrados en la auditoría |
| 2026-08-01 | 7.1 — Tests de Embedded Signup + doc actualizada (v557) | `lib/handlers/notif.js` (export de `whatsappEmbeddedSignupHandler`), `tests/handlers/whatsapp-embedded-signup.test.js` (nuevo), este documento (checklist 7.1 desactualizado) | ✅ hecho — suite 83/83 |

---

## Notas / bloqueos

_(espacio libre para anotar lo que vaya surgiendo durante la ejecución)_
