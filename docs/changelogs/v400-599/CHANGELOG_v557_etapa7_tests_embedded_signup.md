# v557 — Etapa 7 (Embedded Signup): tests del handler + checklist actualizado

Sigue a v555/v556 (Etapa 6). Se pasa a la Etapa 7 del plan, dejando de lado
—como se pidió— la parte que exige probar contra Meta real.

## Hallazgo: el checklist de 7.1 estaba desactualizado

Los 3 ítems manuales de la Etapa 7.1 (registrar la app como Business-type,
cargar dominios en Facebook Login for Business, crear la Configuration de
Embedded Signup) figuraban como pendientes (`- [ ]`), pero
`frontend/env-config.js` ya trae `WA_APP_ID` y `WA_EMBEDDED_CONFIG_ID`
reales con comentarios que confirman que se hicieron ("confirmada Etapa
7.1", "ES Config, creada 11 jul 2026") — y `CHANGELOG_v288_fix_config_id_whatsapp.md`
documenta incluso la corrección de un error de transcripción en ese ID. Se
actualiza `PLAN_whatsapp_bidireccional_seguimiento.md`:

- Los 3 ítems manuales de 7.1 pasan a `- [x]`, con referencia a dónde quedó
  registrado cada uno (env-config.js, changelogs v287/v288).
- La nota "⬜ Pendiente antes de probar contra Meta real" se reemplaza por
  "✅ Configuración completa" — lo único que sigue pendiente de verdad es la
  prueba manual 7.2 (el dueño conectando su propio WhatsApp desde el panel),
  que queda para después junto con el resto de las pruebas de la Etapa 6.
- Se agregan filas nuevas a la tabla de "Registro de cambios" con v555/556/557
  y las entregas de v287/v288 que faltaban ahí.

## Auditoría de `whatsappEmbeddedSignupHandler` (sin bugs encontrados)

Se revisó el handler completo (intercambio de `code` → token, canje a token
de larga duración, registro del número, suscripción a webhooks, guardado
cifrado) buscando el mismo tipo de gap que apareció con `derivar_humano` en
v555. El diseño ya es sólido: cada paso corta con un 502 claro si Meta lo
rechaza, y **nada se guarda en `empresa_whatsapp` a menos que los 3 pasos
salgan bien** (comentario del propio código: "si algo falla a mitad de
camino, no queda un estado a medias"). El canje a token de larga duración es
la única excepción intencional — si falla, sigue con el token corto en vez
de cortar el alta completa, documentado en el propio código.

## Código

- **`lib/handlers/notif.js`**: se exporta `whatsappEmbeddedSignupHandler`
  (antes interna) para poder testearlo directamente — mismo criterio que
  `crearPedidoDesdeItemsWhatsapp`/`procesarMensajeTexto`. Sin cambios de
  comportamiento.

## Tests

- **Nuevo** `tests/handlers/whatsapp-embedded-signup.test.js` — hasta esta
  entrega, el handler que maneja tokens de acceso de WhatsApp Business de
  cada empresa cliente no tenía ningún test. Mockea `fetch` global (nunca le
  pega a Meta real), `lib/auth-helpers.js` (`verificarToken`) y
  `lib/crypto-secrets.js` (`cifrar`/`descifrar`, sin necesitar
  `ARCA_SECRETS_KEY` real en el entorno de test). Cubre:
  - Validaciones: sin sesión (401), rol no autorizado (403), usuario sin
    empresa (400), faltan `code`/`waba_id`/`phone_number_id` (400), faltan
    `WA_APP_ID`/`WA_APP_SECRET` en el servidor (500), método no permitido
    (405).
  - Camino feliz: guarda el token de larga duración cifrado
    (`onConflict: 'empresa_id'`) y devuelve `verified_name`.
  - Si falla el canje a token de larga duración, guarda igual con el token
    corto (no corta el alta) — comportamiento intencional documentado en el
    código.
  - Si falla el intercambio inicial del code, el registro del número, o la
    suscripción a webhooks: corta con 502 y **no llega a escribir nada** en
    `empresa_whatsapp` (verifica el invariante "todo o nada" del diseño).
  - Si falla solo la consulta de `verified_name` (no crítica): el alta se
    completa igual, con `verified_name: null`.
  - Si Meta acepta todo pero falla el `upsert` en la base: 500 con mensaje
    claro para el usuario.
  - Si se corta la conexión con Meta en cualquier paso (excepción de red):
    500 genérico, sin dejar nada a medias.
- **Suite completa: 83/83** (69 previos + 14 nuevos).

## Qué NO se hizo en esta entrega

- No se tocó nada de la Etapa 6 ni de la 7.2/7.3 del checklist — esas
  siguen pendientes de la prueba manual contra Meta real, que se deja para
  después según lo acordado.
- No se armaron tests para el frontend de onboarding
  (`whatsapp-onboarding.html/.js`) — es JS de UI sin lógica de negocio
  propia (delega todo al backend), no pareció el foco de esta entrega.
