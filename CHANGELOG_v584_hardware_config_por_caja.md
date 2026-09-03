# v584 — Fix: la config de terminal de pago (Prisma/MP Point/Getnet) era única por empresa, no por caja

## Auditoría funcional — Etapa 1 (POS/Terminal Prisma), hallazgo de diseño

## Hallazgo
La config de impresora/terminal de pago vivía en `empresas.config->pos_hardware`
(una sola fila por empresa), a pesar de que:

- `cajas_pos` está diseñada desde el origen (`072_pos.sql`) para "Varias cajas
  físicas operando en simultáneo".
- El changelog que introdujo Prisma decía literalmente: "Lo único que cambia
  por caja es el `terminal_id`".
- `GET/POST /api/pos/config-hardware` nunca recibía ni usaba `caja_id` — leía
  y guardaba en `empresas`, sin selector de caja en Admin → Hardware.

Consecuencia real: con 2+ cajas abiertas en simultáneo, cada una con su
propia terminal física Prisma/MP Point/Getnet, no había forma de configurar
un `terminal_id`/`device_id` distinto por caja — la segunda caja terminaba
mandando sus cobros a la terminal de la primera (o lo que haya quedado
guardado último).

## Fix — migración 583
- `cajas_pos` → nueva columna `hardware_config JSONB DEFAULT '{}'` (reemplaza
  a `empresas.config->pos_hardware` como fuente de verdad).
- Backfill: la config de empresa existente se copia a todas las cajas activas
  que todavía no tengan `hardware_config` propio, para no romper la terminal
  ya configurada de comercios con una sola caja.
- `empresas.config->pos_hardware` queda en la tabla (dato viejo, ya no se lee).

## Backend (`lib/handlers/pos.js`, `lib/repos/pos.js`)
- `GET /api/pos/config-hardware` ahora requiere `caja_id` — sin él, devuelve
  defaults neutros (`browser`/`manual`) en vez de leer de una caja al azar.
- `POST /api/pos/config-hardware` ahora requiere `caja_id` en el body.
- Nuevos repos: `obtenerCajaHardwareConfig` / `actualizarCajaHardwareConfig`
  (scoped por `empresa_id`, mismo patrón que el resto de `cajas_pos`).

## Frontend
- `frontend/admin/pos.html`: nuevo selector "Caja a configurar" en el panel
  Admin → Hardware (`hw-caja-select`), poblado con la misma lista de
  `cargarCajas()`. Texto de ayuda corregido (ya no dice "afecta a todas las
  cajas").
- `frontend/admin/js/pos/hardware-config.js`: `cargarConfigHardware()` y
  `guardarConfigHardware()` ahora leen/mandan `caja_id`. La aplicación en
  caliente del driver de impresora/terminal (`window.PosPrinter.init` /
  `window.PosTerminal.init`) solo pisa la sesión activa si se está guardando
  la config de la caja donde el usuario está parado — si un dueño configura
  otra caja desde el panel, no le cambia el hardware a sí mismo.
- `frontend/admin/js/pos/turnos-caja.js`: `usarTurno()` y `abrirTurno()`
  llaman a `window.aplicarHardwareDeCajaActiva(caja_id)` apenas se sabe con
  qué caja va a operar el cajero — antes esto se pedía en el arranque del
  POS (`nucleo.js`), cuando todavía no había caja elegida.
- `frontend/admin/js/pos/nucleo.js`: el `config-hardware` del arranque ya no
  pide `impresora`/`terminal` (no hay caja todavía) — solo se usa para
  precargar `empresaData` (nombre/CUIT/domicilio) para el encabezado del
  ticket.

## Pendiente / no cubierto en este fix
- No se probó de punta a punta con dos cajas físicas reales cobrando en
  simultáneo con terminales Prisma distintas — falta esa verificación en
  producción.
- `tests/e2e/specs/admin/pos.spec.js` mockea `/api/pos/config-hardware` a
  nivel de ruta (`() => ({ json: {} })`), sin distinguir por `caja_id` — el
  mock sigue funcionando (no rompe), pero no ejercita el selector de caja
  nuevo. Quedaría bien agregar un spec que abra dos cajas y verifique que
  cada una guarda/lee su propio `terminal_id`.
