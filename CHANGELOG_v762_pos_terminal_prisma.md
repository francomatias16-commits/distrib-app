# v762 — Terminal de pago Prisma reemplaza al driver "Lapos" (falso) del POS

## Problema
El selector de terminal en Admin → Hardware (`hw-term-driver`) tenía una opción
"Lapos" que se conectaba a un WebSocket local inventado (`ws://lapos-ip:8080`).
No existía ningún agente/servicio real del otro lado — cualquier intento de cobro
con ese driver quedaba colgado esperando una conexión que nunca se establecía.
Nunca hubo un cliente en producción usando ese driver.

## Fix
Se reemplaza por una integración real contra la Terminal Payments API de Prisma
(Paystore terminals), siguiendo el mismo patrón ya usado para Mercado Pago
(`_svc=config`) y el cobro QR (`_svc=pos-qr-*`): la cuenta se conecta una vez
en Admin → Hardware y el token queda cifrado en el backend — nunca viaja al
frontend ni se repite por caja. Lo único que cambia por caja es el
`terminal_id` (cada caja física tiene su propia terminal vinculada).

### Frontend
- `frontend/admin/pos.html`: reemplazado el bloque de campos "Lapos" (IP +
  puerto) por el de Prisma: CUIT/CUIL, botón "Conectar cuenta", campo de
  token y campo de ID de terminal por caja.
- `frontend/admin/js/pos.js`:
  - `apiPut()` nuevo (no existía; solo había `apiGet`/`apiPost`).
  - `toggleHardwareTerminalFields()` actualizado: `prisma` en vez de `lapos`.
  - `cargarConfigHardware()`: puebla `prisma_terminal_id` y dispara
    `cargarEstadoCuentaPrisma()`.
  - `cargarEstadoCuentaPrisma()` / `conectarPrismaHardware()` nuevos: estado
    de la cuenta conectada (sin exponer el token) y alta/edición de
    CUIT+token contra `_svc=prisma-config`.
  - `guardarConfigHardware()`: valida que haya `terminal_id` cuando el driver
    es `prisma`, guarda `prisma_terminal_id`, se sacan los campos muertos de
    `lapos_ip`/`lapos_puerto`.
- `frontend/admin/js/pos-terminal.js`: eliminado por completo `cobrarLapos`
  (el driver WebSocket falso). Nuevo `cobrarPrisma()`: inicia el cobro
  (`prisma-cobrar`), muestra el diálogo de espera, pollea cada 3s
  (`prisma-verificar`) y cancela en el backend (`prisma-cancelar`) si el
  cajero cancela o se agota el timeout. Actualizados el router de drivers y
  `getTerminalesSoportadas()`.
- `frontend/admin/js/pos-printer.js`: el mapa de nombres de medio de pago en
  el ticket impreso tenía `lapos:'Lapos'` — corregido a `prisma:'Prisma'`
  (se había escapado en la primera pasada del fix).

### Backend
- `lib/handlers/pagos.js`:
  - `fetchPrisma()` (helper propio, separado de `fetchMP`): la API de Prisma
    devuelve errores como array `[{code, message}]`, no objeto plano.
  - `prismaBreaker`: circuit breaker propio (no comparte el de MP).
  - 4 endpoints nuevos, mismo patrón que `pos-qr-*`:
    - `_svc=prisma-config` (GET/PUT/DELETE, rol dueño/admin): alta valida el
      CUIT (11 dígitos) y el token contra la API real antes de guardar
      (mismo criterio que `guardarConfigMP` con `/users/me`).
    - `_svc=prisma-cobrar` (POST, roles de caja): inicia el cobro en la
      terminal de la caja actual.
    - `_svc=prisma-verificar` (GET, roles de caja): polling de estado.
    - `_svc=prisma-cancelar` (POST, roles de caja): cancela; responde
      `{ok:false}` en vez de 5xx ante fallas — el frontend lo llama
      "fire and forget" al cerrar el diálogo.
- `lib/repos/pagos.js`: `obtenerConfigIntegracionPrisma` (sin token) y
  `obtenerIntegracionPrismaActiva` (fila completa). No hizo falta tocar
  `upsertIntegracionMP`/`desactivarIntegracionMP`: ya eran genéricas por
  `proveedor` y se reusan tal cual con `proveedor='prisma'`.
- `supabase/migrations/481_integraciones_pago_prisma_columnas.sql`: agrega
  solo `integraciones_pago.cuit_cuil` — sin tabla nueva. `access_token`
  reusa la columna que ya tenía la tabla desde
  `010_etapa7_fidelizacion.sql`, cifrado con el mismo `lib/crypto-secrets.js`
  que Mercado Pago.

## Pendiente / a verificar (no probado end-to-end)
- **Enum de estados de pago sin confirmar contra la doc real de Prisma.**
  `prismaVerificarHandler` trata como aprobados
  `APPROVED / PAYMENT_APPROVED / CONFIRMED` y como rechazados
  `REJECTED / PAYMENT_REJECTED / DECLINED / CANCELLED / EXPIRED` — son los
  nombres más probables, no confirmados. Cualquier otro valor queda como
  pendiente y se loguea con `console.warn` para ajustar la lista contra el
  primer cobro real en sandbox.
- **Nombres de campo de la respuesta de `POST /payments` sin confirmar**:
  `prismaCobrarHandler` prueba `payment_id` / `id` / `paymentId`, en ese
  orden, y loguea si no encuentra ninguno.
- **Paths de la API** (`/terminals`, `/payments`, `/payments/{id}`,
  `/payments/{id}/cancel`) son los que sigue el resto del módulo por
  convención con MP, pero no están verificados contra la documentación
  oficial de la Terminal Payments API de Prisma/Paystore — se necesita
  confirmarlos antes del primer test real.
- **`PRISMA_API_URL`** debe configurarse en Vercel (sandbox y producción son
  hosts distintos) — sin esa variable, `fetchPrisma` falla explícito en vez
  de pegarle a un host adivinado.
- El token de Prisma expira (a diferencia del de MP, que es de larga vida) y
  todavía no hay endpoint de refresh documentado — por ahora se repega a
  mano desde Admin → Hardware cuando venza.

## Cómo queda el flujo
Admin → Hardware → Terminal de pago → elegir "Prisma (terminal, cobro con
tarjeta)" → conectar la cuenta (CUIT/CUIL + token) una sola vez → cargar el
ID de terminal de esta caja → Guardar. Desde ahí, el checkout del POS cobra
con tarjeta contra la terminal física real en vez de esperar indefinidamente
a un WebSocket que nunca respondía.
