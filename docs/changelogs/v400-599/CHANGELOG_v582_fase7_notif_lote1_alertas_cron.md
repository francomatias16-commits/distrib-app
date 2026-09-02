# v582 — Fase 7, paso 7, lote 1: `notif.js` — alertas operativas por cron

Continuación de `CHANGELOG_v581_fase7_stock.md`. Arranque del paso 7 del
plan (`notif.js`, 71 `.from()` directos pendientes).

## Relevamiento (el plan lo tenía marcado como "repo chico, handler grande")

`lib/handlers/notif.js` es un router consolidado de 2312 líneas que agrupa
subsistemas bastante distintos entre sí: el bot conversacional de WhatsApp
(webhook, conversaciones, mensajes), dispositivos push, notificaciones de
entrega, alertas por cron (token de WhatsApp vencido, cheques por vencer,
deuda vencida), estado de cuenta y reintento de emails. Migrarlo entero de
una sería el mismo error que el plan ya evitó con `pedidos.js`/`pos.js` — un
PR gigante, imposible de revisar con seguridad, tocando código con
comportamiento sensible (firma de webhooks, motor conversacional).

**Se parte en 4 lotes por concern**, mismo criterio que `pedidos.js` (paso 6):

1. **Lote 1 (hoy)** — alertas operativas por cron: token de WhatsApp vencido,
   cheques por vencer, deuda vencida. 12 `.from()`.
2. **Lote 2** — estado de cuenta + reintentar email (`handleEstadoCuenta`,
   `handleReintentarEmail` y sus 4 helpers `_reintentar*`). ~18 `.from()`.
3. **Lote 3** — dispositivos push + notificaciones de entrega
   (`pushInternoHandler`, `registrarDispositivo`, `desregistrarDispositivo`,
   `pushChoferHandler`, `entregaHandler` y sus helpers `manejar*`).
   ~13 `.from()`.
4. **Lote 4** — el bot conversacional de WhatsApp (webhook entrante,
   conversaciones, mensajes, confirmación de pedido por chat). Es el más
   grande (~28 `.from()`) y el de mayor riesgo real (firma de Meta, estado
   de conversación) — a evaluar antes de arrancarlo si conviene que viva en
   `lib/repos/notif.js` o si merece su propio repo
   (`whatsapp-conversaciones.js`), dado que conceptualmente no es "notif".

## Qué se hizo (lote 1)

- **`lib/repos/notif.js` — 7 funciones nuevas:**
  - `ultimoEnvioPorTipo(tipo, { empresa_id })` — generaliza el cooldown de
    `ultimoEnvio` para los casos sin `cliente_id` (alertas globales). El
    filtro por `empresa_id` es opcional porque el aviso de token vencido
    del número *compartido* corre el cooldown entre todas las empresas; el
    del número *propio* lo corre por empresa.
  - `ultimoEnvioPorCliente(cliente_id, tipo)` — variante sin `empresa_id`
    para `handleDeudaCron`, donde `cliente_id` ya identifica una única
    empresa (agregar el filtro habría sido redundante, no una corrección).
  - `listarAdminsDueno(empresa_id, { campos })` — cubre los dos selects
    distintos que tenía el original (`id, empresa_id` vs.
    `id, nombre, email, telefono`) y el filtro opcional por empresa.
  - `listarChequesPorIds(ids)` — devuelve `{ data, error }` tal cual, porque
    el handler original branchea sobre el error para un mensaje legible en
    vez de tirar excepción.
  - `listarChequesPorVencer(desde, hasta)` — propaga el error (igual que el
    original, que lo relanza dentro de su try/catch).
  - `listarClientesActivosConCtaCte()` — propaga error, igual criterio.
  - `actualizarNecesitaReconexionWhatsapp(empresa_id, necesita_reconexion)`
    — nunca lanza (best-effort, igual que el original).
- **3 funciones migradas a usar el repo, 0 `.from()` propios:**
  `marcarEstadoTokenWhatsapp`, `alertarTokenWhatsAppVencido`,
  `enviarAvisoChequesPorVencer`, `handleChequesCron`,
  `enviarAvisoDeudaVencida`, `handleDeudaCron` — los 3 inserts a `notif_log`
  de este lote (que antes escribían silenciando el error a mano, con o sin
  `.catch(() => {})`) pasaron a usar `registrarLog()`, ya existente en el
  repo — mismo comportamiento observable (ninguno de los dos caminos
  originales chequeaba `error`, así que ambos eran efectivamente
  silenciosos; `registrarLog` solo suma un `console.error` si falla, no
  cambia el flujo).

## Tests

- `tests/repos/notif.test.js` (nuevo, 16 casos) — cubre únicamente las 7
  funciones del lote 1; las que ya existían antes (`ultimoEnvio`,
  `listarLogs`, `listarDispositivos`, `registrarLog`, `registrarLogs`,
  `registrarEmail`) quedan sin tests nuevos en este paso.
- Suite completa: **583/583 OK** (27 archivos de test).
- `node --check` limpio en repo y handler.
- `grep -c "\.from(" lib/handlers/notif.js`: 71 → **59** (quedan los otros
  3 lotes).

## Checklist Fase 7 (`FASE7_PLAN_ARRANQUE.md`, sección 3) — para este lote

1. ✅ Repo extendido (7 funciones nuevas, `empresa_id`/`cliente_id`
   explícitos donde aplica)
2. ✅ Handler migrado sin cambiar comportamiento observable
3. ⏳ `grep -c "\.from("` → 0 recién al cerrar el lote 4 (parcial: 71 → 59)
4. ✅ Suite completa corrida — 583/583
5. ✅ Tests nuevos del lote, sin tocar los que no correspondían
6. ✅ Changelog por lote — este documento

Próximo paso: lote 2 (`handleEstadoCuenta` + `handleReintentarEmail`).
