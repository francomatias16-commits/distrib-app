# v763 — Terminal Prisma: corregido contra la documentación real de la API

## Contexto
El v762 armó el driver Prisma sobre una API supuesta (`/terminals`, `/payments`
con campos `cuit`/`amount`/`terminal_id` a nivel raíz, cancelación por
`POST .../cancel`) — no había forma de confirmarla en ese momento. Con acceso al
portal real (`portal.developers.prismamediosdepago.com`, catálogo "Paystore
terminals - Terminal Payments v1") se corrigen los tres endpoints usados por
`lib/handlers/pagos.js` contra el contrato documentado.

## Qué cambió (todo en `lib/handlers/pagos.js`, sin tocar frontend ni migración)

- **Base URL confirmada**: `https://api-sandbox.prismamediosdepago.com/v1/paystore_terminals/terminal_payments`.
- **`subnet_acquirer_id` nuevo** (no existía en v762): identificador de
  "facilitator" que la API exige — `1` sandbox, `9` homologación, `2`
  producción. Configurable por `PRISMA_SUBNET_ACQUIRER_ID`, default `1`.
- **CUIT/CUIL con guiones**: la API lo espera formateado (`30-12345678-9`), no
  como 11 dígitos seguidos. Se normaliza siempre al guardar la config
  (`_formatCuit`).
- **`prisma-config` (guardar)**: sacado el chequeo contra `/terminals` (no
  existe en el catálogo real) — ahora valida el Bearer token contra
  `GET /health/liveness`, que sí está documentado y requiere auth.
- **`prisma-cobrar`**: reescrito el body completo al schema real de
  `POST /payments` (`payment_request_data` con `subnet_acquirer_id`,
  `payment_amount` en **centavos** como string, `terminals_list: [{terminal_id}]`,
  `ecr_provider`/`ecr_name`/`ecr_version`, flags de impresión, etc. — varios
  fijados igual que el ejemplo del portal porque la doc advierte que Sandbox
  usa datos fijos por caso de prueba). `cuit_cuil` va como query param, no en
  el body. El id de pago se lee de `payment_data.payment_id` (confirmado).
- **`prisma-verificar`**: `GET /payments/{payment_id}` ahora manda
  `cuit_cuil` **y** `subnet_acquirer_id` como query params (antes solo
  mandaba uno, y con otro nombre). El estado se lee de
  `payment_data.payment_status` — antes se buscaba en `status`, que no existe
  en la respuesta real. Se agrega `PAYMENT_REQUEST` como estado pendiente
  confirmado (es lo que devuelve `POST /payments` al crear el pago).
- **`prisma-cancelar`**: la operación real es
  `PUT /payments/{payment_id}/cancellations` (`undoPayment`, "cancela un pago
  que todavía no fue confirmado") — v762 le pegaba a un
  `POST /payments/{id}/cancel` inventado.

## Sigue sin confirmar (no hay más info en las capturas compartidas)
- El **enum completo de estados finales** (aprobado/rechazado): la doc solo
  muestra `PAYMENT_REQUEST` como ejemplo de estado inicial. Los valores de
  aprobado/rechazado siguen siendo los más probables, logueados con
  `console.warn` si no matchean para poder ajustar la lista contra el primer
  cobro real.
- El **schema de `POST /payments/searches`** (`getPayments`) — no se llegó a
  ver, no se usa en este módulo.
- El **body de `PUT .../cancellations`** — no estaba documentado en las
  capturas; se manda sin body, solo con los query params que sí se ven
  repetidos en el resto de las operaciones.
- **Flujo de obtención de token real**: el portal muestra un token de prueba
  vía "Obtener token aquí" (OAuth2 2-legged, expira ~3502s ≈ 1h) — confirma
  que el token expira como ya se había asumido, pero no está claro si hay un
  endpoint de `client_credentials` para que el backend lo renueve solo, o si
  siempre requiere entrar al portal manualmente. Por ahora se sigue
  repegando a mano desde Admin → Hardware.

## Antes del primer test real
Con esto ya alcanza para intentar un cobro contra sandbox. Recomendado: correr
`prisma-cobrar` una vez con un monto de prueba y loguear la respuesta cruda de
`POST /payments` y `GET /payments/{payment_id}` completas (no solo
`payment_status`) para terminar de confirmar el enum de estados finales antes
de dar por cerrado el flujo.
