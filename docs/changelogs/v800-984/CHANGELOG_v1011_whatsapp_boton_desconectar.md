# v1011 — WhatsApp: fix del cartel que no pasaba a "conectado" + botón "Desconectar" (2026-08-30)

## Bug principal: el cartel se quedaba en "no conectado" a pesar del toast de éxito

Reportado con captura: después de conectar el WhatsApp, aparecía el toast
"¡WhatsApp conectado!" pero el cartel de estado seguía mostrando "Todavía
no conectaste un número de WhatsApp propio" — indefinidamente, sin
recuperarse solo ni con recargas.

**Causa:** `cargarEstadoActual()` (llamada tanto al cargar la página como
después de conectar) lee el estado por **un camino distinto** al que lo
escribe. La escritura (`whatsappEmbeddedSignupHandler`, backend) usa
`SUPABASE_SERVICE_ROLE_KEY` — bypassa RLS por completo, así que si el POST
respondía 200 la fila SÍ había quedado guardada. La lectura, en cambio, la
hace el frontend con el JWT del propio usuario contra la vista
`v_empresa_whatsapp_estado`, scopeada por la policy
`empresa_id IS NOT DISTINCT FROM get_empresa_id() AND get_rol_usuario() IN
('dueno','admin')`. Como el código usaba `.maybeSingle()`, si esa policy no
matcheaba la fila por cualquier motivo (desincronización puntual entre el
JWT cacheado en `authCtx` y lo que resuelve Postgres vía `auth.uid()`,
lag del lado de Supabase, etc.), la consulta no tiraba error — devolvía
`data: null`, indistinguible en el código de "nunca conectaste nada". El
`error` real (cuando lo había) tampoco se logueaba en ningún lado, así que
no quedaba ningún rastro para diagnosticar en el momento.

**Fix — `frontend/admin/js/whatsapp-onboarding.js`:**

- **Se deja de depender de la relectura por RLS para el estado
  inmediato tras conectar/desconectar.** `enviarAlBackend()` y
  `desconectarWhatsapp()` ahora pintan el cartel DIRECTO con la respuesta
  del propio POST (fuente de la verdad: lo que el backend, con
  service_role, acaba de guardar/borrar) — se extrajo `renderBoxConectado()`
  para reusar el mismo HTML que ya generaba `cargarEstadoActual()`.
  `cargarEstadoActual()` se sigue llamando después, pero en segundo plano
  (sin `await`, sin bloquear ni poder pisar el cartel recién pintado) —
  solo para traer campos que el POST no devuelve (`necesita_reconexion`,
  `business_id` para la próxima reconexión, etc.).
- **Se agrega `console.error` del `error` de Supabase** en la rama que
  antes lo tragaba en silencio — si esto vuelve a pasar en una carga de
  página normal (no justo después de conectar, donde ya no depende de
  esto), va a quedar visible en consola (F12) para diagnosticar la causa
  puntual de la policy en vez de a ciegas.

Con esto, el síntoma reportado en la captura queda resuelto: el cartel
pasa a "conectado" en el mismo momento que el toast, sin depender de que
la relectura scopeada por RLS encuentre la fila.

## Además: botón "Desconectar" en el panel de onboarding

Hasta esta entrega tampoco existía ninguna forma de desconectar el
WhatsApp propio desde el panel — el botón alternaba entre "Usar mi
WhatsApp Business existente" y "Reconectar / cambiar número", pero nunca
ofrecía una acción explícita de desconexión. La conexión quedaba activa
indefinidamente en la base (no hay ningún timeout ni política de
re-autenticación forzada) hasta que ocurriera uno de dos eventos pasivos:
el dueño desconectaba el número desde la propia app de WhatsApp Business
(webhook `ACCOUNT_OFFBOARDED` de Meta), o el token de acceso vencía (~60
días, sin cron de renovación) y el próximo envío fallaba con error 190.

Se agrega una acción explícita: el botón ahora tiene un solo comportamiento
por vez, según el estado real de la conexión, y pasa a ser **"Desconectar"**
(estilo `btn--danger`, con confirmación) únicamente cuando la empresa está
efectivamente conectada.

### Backend

- **`lib/repos/whatsapp-bot.js`**: dos funciones nuevas —
  `obtenerWabaIdYTokenWhatsapp(empresa_id)` (lee `waba_id` + `access_token`
  cifrado de la fila actual) y `borrarCredencialesWhatsapp(empresa_id)`
  (`DELETE` de la fila completa). Se distingue a propósito de
  `actualizarEstadoConexionWhatsapp` (que solo marca
  `desconectado_en`/`necesita_reconexion` cuando el aviso viene de un
  webhook de Meta y hay que dejar rastro para el flujo de reconexión): acá
  es una decisión explícita del dueño/admin de dejar de usar Embedded
  Signup en distrib, así que se borra la fila entera. Sin fila,
  `resolverCredencialesWhatsapp()` (ya existente) cae automáticamente al
  número de prueba global — mismo criterio que una empresa que nunca
  conectó nada.
- **`lib/handlers/notif.js`**: nuevo `whatsappDesconectarHandler`, ruteado
  en `_svc === 'whatsapp-desconectar'` (`POST /api/notif/whatsapp-desconectar`).
  - Mismo esquema de auth que `whatsappEmbeddedSignupHandler` (Bearer +
    `verificarToken` + `puede()`).
  - Avisa a Meta (`DELETE /{waba_id}/subscribed_apps`) que esta app deja de
    estar suscripta a los webhooks de esa cuenta. No es crítico si falla
    (token ya vencido, o el dueño ya había desconectado el número desde el
    celular): se borra la fila local igual.
  - Si no había ninguna fila (ej. doble click, dos tabs abiertas), responde
    `200 { ok: true, ya_estaba_desconectado: true }` sin llamar a Meta —
    no es un error, el resultado final es el mismo.
  - El número de WhatsApp Business del dueño en su celular **no se toca**
    en ningún caso — esto solo desconecta del lado de distrib.
- **`lib/permisos-service.js`**: gate nuevo `desconectar: ['dueno', 'admin']`
  dentro de `whatsapp_onboarding`, mismo criterio que `conectar`.

### Frontend

- **`frontend/admin/js/whatsapp-onboarding.js`**: se centraliza texto +
  estilo + comportamiento del botón en `aplicarEstadoBoton(estado)`,
  llamada desde `cargarEstadoActual()` según lo que devuelve
  `v_empresa_whatsapp_estado`:
  - `sin_conectar` → `"Usar mi WhatsApp Business existente"`, dispara
    Embedded Signup.
  - `necesita_reconexion` → `"Reconectar mi WhatsApp"`, mismo flujo.
  - `conectado` → **`"Desconectar"`** (única opción visible en este
    estado), estilo `btn--danger`, dispara `desconectarWhatsapp()`.
  - `onClickBotonPrincipal()` reemplaza el listener fijo que antes siempre
    llamaba a `lanzarEmbeddedSignup` — ahora decide según `_estadoActual`.
  - `desconectarWhatsapp()`: pide confirmación (`window.confirm`, aclara
    que el WhatsApp Business del celular no se ve afectado) antes de
    llamar al endpoint nuevo.
  - `restaurarBoton()` ya no hardcodea el label por defecto: delega en
    `aplicarEstadoBoton(_estadoActual)`, para que un intento cancelado/
    fallido vuelva al texto que corresponde al estado real (ej.
    "Reconectar mi WhatsApp"), no siempre a la primera conexión.

## Por qué

Sin el botón, la única manera de "soltar" una conexión de WhatsApp desde
distrib era esperar a que se rompiera sola (token vencido) o pedirle al
dueño que la corte desde su celular — ninguna de las dos es una acción
disponible ni visible para el dueño/admin dentro del panel.

## Tests

- **`tests/handlers/whatsapp-desconectar.test.js`** (nuevo, 10 casos):
  validaciones (401/403/400/405, mismo criterio que
  `whatsapp-embedded-signup.test.js`), camino feliz (desuscribe en Meta con
  el token descifrado + borra la fila), `ya_estaba_desconectado` cuando no
  hay fila, tolerancia a que Meta rechace la desuscripción o falle la red
  (borra igual, responde 200), y 500 si falla la lectura o el borrado en la
  base.
- El fix del cartel es puramente de frontend (reordena cuándo se pinta cada
  estado, sin lógica nueva de negocio) — sin test unitario dedicado, no hay
  suite de frontend para este archivo todavía. Cubierto por revisión manual
  y por los 10 tests nuevos del endpoint que ahora alimenta el cartel
  directo.
- **Suite completa: 1242/1242** (78/78 archivos) — sin fallas, incluidos
  `tests/repos/whatsapp-bot.test.js` y `tests/permisos-service.test.js`.

## Archivos

- `frontend/admin/js/whatsapp-onboarding.js`
- `lib/repos/whatsapp-bot.js`
- `lib/handlers/notif.js`
- `lib/permisos-service.js`
- `tests/handlers/whatsapp-desconectar.test.js`

## Fuera de alcance (a propósito)

- No se tocó la policy RLS de `empresa_whatsapp`/`v_empresa_whatsapp_estado`
  en Supabase — el fix evita que el bug sea visible sin depender de
  diagnosticar la causa exacta de la desincronización puntual, pero si el
  `console.error` nuevo vuelve a aparecer en una carga de página normal
  (no recién conectado), vale la pena correr en el SQL editor de Supabase
  `select get_empresa_id(), get_rol_usuario();` autenticado como ese
  usuario, contra `select * from empresa_whatsapp where empresa_id = '<uuid>'`,
  para confirmar si es un problema real de policy o de JWT desactualizado.
- No se agregó ningún job/cron de renovación del token de larga duración
  (~60 días) — sigue siendo el mismo mecanismo pasivo de siempre (error 190
  → `necesita_reconexion`). Si se quiere evitar que una empresa activa se
  desconecte sola por vencimiento, es una entrega aparte.
- No se llama a ningún endpoint de Meta para "borrar"/revocar el WABA en
  sí — Coexistencia no lo permite ni tendría sentido (el número sigue
  siendo del dueño en su WhatsApp Business real). Lo único que se revoca
  es la suscripción de *esta* app a sus webhooks.

