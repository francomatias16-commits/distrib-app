# v582 — Fase 7, paso 7, lote 4 (cierre): bot conversacional de WhatsApp

Continuación de `CHANGELOG_v582_fase7_notif_lote1_alertas_cron.md` (lotes 2 y 3
quedaron documentados en el propio `lib/repos/notif.js`, no se armó
changelog aparte para esos — este lote sí lo tiene por ser el de cierre y
el de mayor riesgo). Cierra el paso 7 del plan (`notif.js`, 71 `.from()`
directos al arrancar el paso).

## Decisión: repo propio en vez de sumarse a `lib/repos/notif.js`

Quedó anotado al cerrar el lote 3: "el bot conversacional de WhatsApp...
posiblemente merezca su propio repo en vez de vivir acá, a evaluar antes de
empezarlo". Se confirmó que sí — conceptualmente esto no es "notif" (no hay
ningún envío de plantilla/push acá) sino el motor conversacional completo:
matching teléfono→empresa/cliente, estado de la conversación, historial de
mensajes, creación del pedido en firme y el flujo de alta de WhatsApp
Business propio de una empresa (Embedded Signup). Es también el lote de
mayor riesgo real de los 4 (firma de Meta, estado de conversación, plata —
crea pedidos).

Nuevo archivo: **`lib/repos/whatsapp-bot.js`** (356 líneas).

## Qué se hizo

- **`lib/repos/whatsapp-bot.js` — 24 funciones nuevas**, agrupadas en:
  - Credenciales por empresa (Etapa 7): `obtenerCredencialesWhatsapp`,
    `guardarCredencialesWhatsapp`.
  - Matching teléfono → empresa/cliente: `buscarConversacionAbiertaPorTelefono`,
    `obtenerEmpresaPorPhoneNumberId`, `buscarClientePorTelefonoEnEmpresa`,
    `resolverClientePorTelefonoRpc`.
  - Conversación (CRUD de estado): `buscarConversacionAbiertaId`,
    `crearConversacion`, `obtenerEstadoYBorrador`, `marcarConversacionActiva`,
    `reiniciarBorradorConversacion`, `cerrarConversacionConPedido`,
    `marcarConversacionDerivada`, `obtenerConversacionEmpresaTelefono`,
    `obtenerConversacionParaAccion`, `tomarConversacion`, `liberarConversacion`.
  - Mensajes: `registrarMensajeWhatsapp`, `obtenerHistorialMensajes`,
    `contarMensajesEntrantes`.
  - Creación de pedido desde el bot: `obtenerClienteParaPedidoWhatsapp`,
    `obtenerStockParaPedidoWhatsapp`, `resolverPreciosClienteRpc`,
    `crearPedidoClienteRpc`, `obtenerNumeroPedido`.
- **Reuso en vez de duplicar**: el aviso a admins/vendedores dentro de
  `marcarDerivada` (`.from('usuarios').select('id').eq('empresa_id',
  ...).in('rol', [...])`) coincide exactamente con `listarUsuariosPorRoles`,
  ya agregado al repo `notif.js` en el lote 3 — no se creó una función
  nueva, el handler pasó a llamar esa.
- **Consolidación de 3 llamadas idénticas**: las tres apariciones de
  `update({ estado: 'activa' }).eq('id', conversacionId)` (mensaje ambiguo
  en confirmación pendiente, borrador vacío al confirmar, error creando el
  pedido) pasaron a la misma función `marcarConversacionActiva`.
- **Handler migrado sin cambiar comportamiento observable**, con una
  excepción intencional: los mensajes de error internos que antes decían
  `No se pudo crear la conversación de WhatsApp: ...` ahora llevan el
  prefijo `[WhatsappBotRepo.crearConversacion] ...` — mismo criterio que el
  resto de los repos (lotes 1-3), no son mensajes de cara al usuario (se
  loguean en el catch de `whatsappWebhookHandler`, que siempre responde 200
  a Meta).
- **`lib/repos/index.js`**: se agregó `WhatsappBotRepo` al barrel.
- **`lib/repos/notif.js`**: se actualizó el comentario de cabecera para
  cerrar el historial de lotes (ya no queda "lote 4 pendiente").

## Tests

- `tests/repos/whatsapp-bot.test.js` (nuevo, 33 casos) — cubre las 24
  funciones del repo nuevo.
- Se actualizaron los mocks de 3 archivos de test existentes que hasta
  ahora mockeaban `supabase` (vía `crearClienteSupabaseLazy`) directamente
  para las funciones que este lote migró a `lib/repos/whatsapp-bot.js`
  (que usa `db` de `lib/repos/_db.js`, no `supabase`):
  - `tests/handlers/whatsapp-pedido-borrador.test.js` — se sumó `rpc()` al
    mock de `_db.js` que ya existía (agregado en un lote previo para
    `productos.js`), sin tocar ninguna aserción.
  - `tests/handlers/whatsapp-embedded-signup.test.js` — se agregó un mock
    de `_db.js` con el mismo router `upsertLlamadas`/`upsertResultado` que
    ya usaba el mock de `crearClienteSupabaseLazy`.
  - `tests/handlers/whatsapp-motor-conversacion.test.js` — se agregó un
    mock de `_db.js` con el mismo router de colas
    (`dbMock.colas`/`dbMock.rpcColas`) que ya usaba el mock de
    `crearClienteSupabaseLazy`, duplicado (no se puede compartir la función
    entre los dos `vi.mock` por las reglas de hoisting de Vitest).
  - Ninguna aserción de negocio se modificó en estos 3 archivos — solo el
    mock de transporte.
- Suite completa: **642/642 OK** (28 archivos de test).
- `node --check` limpio en repo y handler.
- `grep -c "\.from("` en `lib/handlers/notif.js`: **3** (las 3 restantes
  son `Buffer.from()` de la validación de firma HMAC de Meta, no Supabase).
- `grep -c "\.rpc("` en `lib/handlers/notif.js`: **0**.

## Checklist Fase 7 (`FASE7_PLAN_ARRANQUE.md`, sección 3) — para este lote

1. ✅ Repo nuevo creado (24 funciones, `empresa_id`/`cliente_id` explícitos
   donde aplica)
2. ✅ Handler migrado sin cambiar comportamiento observable (salvo el
   prefijo de mensaje de error interno documentado arriba)
3. ✅ `grep -c "\.from("` → 0 llamadas a Supabase (quedan solo `Buffer.from`)
   — **paso 7 completo**, los 4 lotes de `notif.js` migrados.
4. ✅ Suite completa corrida — 642/642
5. ✅ Tests nuevos del lote (33 casos), sin reabrir aserciones de negocio
   de los tests existentes (solo se actualizó el mock de transporte)
6. ✅ Changelog de cierre — este documento

`notif.js` (2225 líneas) queda sin accesos directos a Supabase — toda la
capa de datos vive en `lib/repos/notif.js` (lotes 1-3) y
`lib/repos/whatsapp-bot.js` (lote 4). Paso 7 del plan de migración cerrado.
