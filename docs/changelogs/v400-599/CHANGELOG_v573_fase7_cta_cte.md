# v573 — Fase 7, paso 4: `lib/repos/cta-cte.js` — cerrado en un solo paso

Continuación de `CHANGELOG_v572_fase7_productos_lote2.md`. El plan original
asumía 9 handlers tocando `cta_cte` directo (pedidos, pos, pagos, facturas,
cierre, cc_proveedores, migracion, notif, auditoria) y proponía migrar
primero los "chicos" (`cc_proveedores`, `auditoria`, `migracion`) para
validar el repo antes de tocar facturación/cobranza. Al relevar el código
real, ese plan quedó obsoleto — mismo patrón que ya había pasado con
`productos`/`maestros.js` en el paso 3.

## Qué se encontró

- `pedidos.js`, `pos.js`, `pagos.js` — solo mencionan `cta_cte` en
  comentarios. La escritura real pasa por la RPC `crear_pedido_cliente` y
  por un trigger de base que sincroniza `saldo_deuda`.
- `facturas.js` — usa la RPC `aplicar_nota_credito_cta_cte`.
- `migracion.js` — usa la RPC `migracion_confirmar_cta_cte_lote`.
- `cc_proveedores.js` y `auditoria.js` — no tocan la tabla en absoluto.
- Los únicos `.from('cta_cte')` reales: **`cierre.js` (4 usos)** y
  **`notif.js` (2 usos)**.

Con eso, el paso 4 se resolvió en un solo lote en vez de dos como estaba
planeado.

## Qué se hizo

- **`lib/repos/cta-cte.js` (nuevo)** — 4 funciones:
  - `obtenerUltimoSaldo(empresa_id, cliente_id)` — saldo corrido más
    reciente. Silenciosa ante error (devuelve 0), igual que el original;
    queda anotado como observación para una futura auditoría, no se
    corrige en este paso (fuera de alcance de "sin cambiar comportamiento
    observable")
  - `insertarMovimiento({...})` — sí propaga el error (ya lo hacía el
    original: un insert de deuda fallido en silencio es plata mal
    contabilizada)
  - `listarMovimientosPorCliente(empresa_id, cliente_id)` — **hallazgo
    corregido de paso** (mismo criterio que el filtro `activo` agregado en
    la migración de `empresa.js`): el query original en
    `detectarVencimientosYBloquear()` solo filtraba por `cliente_id`, no
    por `empresa_id`. Se agregó el filtro. Sigue silenciosa ante error
    porque se llama dentro de un `for` sin try/catch por iteración — lanzar
    cortaría el cron completo por un timeout puntual en un cliente
  - `listarUltimosMovimientos(empresa_id, cliente_id, { limit })` — usada
    dos veces en `notif.js` con el mismo shape exacto, unificada en una
    función

- **2 handlers migrados a 0 `.from('cta_cte')` directos:**
  - `cierre.js` — `insertarEnCtaCte` (saldo + insert), `procesarNotifVencimiento`
    (saldo) y `detectarVencimientosYBloquear` (movimientos, con el filtro
    de `empresa_id` agregado)
  - `notif.js` — `handleEstadoCuenta` y `_reintentarEstadoCuenta` (el envío
    normal y el reintento manual del estado de cuenta por email)

## Tests

- `tests/repos/cta-cte.test.js` (nuevo, 10 casos) — cada test documenta en
  su descripción la política de error de la función que cubre, porque acá
  la diferencia importa: `insertarMovimiento` propaga, el resto no.
- Suite completa: **153/153 OK** (14 archivos de test).
- `node --check` limpio en los 4 archivos tocados (repo + 2 handlers + test).
- Confirmado `grep -rn ".from('cta_cte')" lib/handlers/` = 0 en todo el
  proyecto.
