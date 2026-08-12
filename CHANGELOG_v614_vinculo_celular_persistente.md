# v614 — Vínculo celular persistente (sliding expiration + reconexión)

## Problema
El vínculo "Vincular celular" del POS (v612) tenía dos huecos que podían
cortar la sesión sin que el cajero lo pidiera:

1. **TTL fijo de 45 min sin renovación.** Un mostrador activo más de 45 min
   perdía el vínculo solo, en medio del turno, aunque se estuviera usando.
2. **El celular no detectaba un cierre remoto.** Si la compu cerraba el
   vínculo (botón "Cerrar vínculo", u otra pestaña regeneraba el token)
   mientras el celular estaba minimizado, al volver de background
   reconectaba cámara y canal a ciegas — quedaba "escaneando al vacío"
   sin ningún aviso.

Además, un `CHANNEL_ERROR`/`TIMED_OUT` de Realtime en la compu (por ejemplo
por wifi inestable) solo se logueaba a consola — no había reintento, el
cajero tenía que cerrar y reabrir el modal a mano.

## Cambio
El vínculo ahora se mantiene activo mientras se usa, y solo se corta por:
(a) el botón "Cerrar vínculo", o (b) inactividad real (nadie escanea nada
en 45 min). Minimizar cualquiera de las dos pantallas nunca lo corta.

- **`lib/repos/pos-scanner.js`** — nueva `extenderTokenScanner()`: empuja
  `expira_at` hacia adelante, solo si el token sigue vivo (no revocado, no
  ya vencido).
- **`lib/handlers/pos-scanner.js`** — nueva acción `?accion=extender`
  (mismo auth/permiso que `generar`/`revocar`).
- **`frontend/admin/js/pos-scanner-remoto.js`**:
  - Cada código recibido dispara `extenderVinculoSiCorresponde()`
    (throttleado a 1 vez cada 5 min) que renueva el TTL y reprograma el
    timer de expiración — sliding expiration.
  - Auto-reconexión con backoff (1s → 2s → 4s... tope 15s) ante
    `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED` del canal Realtime, sin tocar el
    token — el vínculo se repara solo ante un blip de red.
- **`frontend/scan-pos/portal.js`** — `reconectar()` (se llama al volver de
  segundo plano) ahora re-valida el token contra `?accion=validar` antes
  de prender cámara y canal. Si el vínculo ya no está vivo, muestra
  "Vínculo cerrado" en vez de reconectar a ciegas. Si el fetch falla por
  falta de red momentánea (no por cierre real), sigue reconectando como
  antes — no rompe el caso normal de "se cortó el wifi un instante".

## Sin cambios de esquema
No hace falta migración nueva — `extenderTokenScanner` reusa la tabla
`pos_scanner_tokens` de la migración 438, solo actualiza `expira_at`.

## Archivos
- `lib/repos/pos-scanner.js`
- `lib/handlers/pos-scanner.js`
- `frontend/admin/js/pos-scanner-remoto.js`
- `frontend/scan-pos/portal.js`
