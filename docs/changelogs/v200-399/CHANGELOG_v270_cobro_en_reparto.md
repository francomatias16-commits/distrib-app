# v270 — Cobro en el reparto (chofer)

Resuelve la única brecha funcional real detectada en la auditoría UX v2
(sección 4, fila "Entrega, conciliación y cobranza en el reparto"): la app
del chofer confirmaba entregas con firma y foto, pero no había forma de
registrar que cobró efectivo/transferencia/cheque al entregar.

## Decisión de diseño

No se creó un circuito de cobro paralelo. Se reutilizó el RPC
`registrar_cobro_completo` (migración 199), que ya es el único punto de
entrada real para registrar un cobro en todo el sistema (webhook de
MercadoPago y "Cobro rápido" del resumen de rutas en el admin lo usan
igual). Esto significa que un cobro registrado por el chofer:

- Crea el `cobro` y el movimiento en `cta_cte` de forma atómica.
- Reevalúa automáticamente el bloqueo por deuda del cliente.
- Aparece sin trabajo adicional en `/admin/cobranzas` y en el panel
  "Cobros y saldos pendientes" del resumen de rutas (`cargarCobrosHoy`
  lee de `cta_cte` filtrando por `tipo = 'cobro'`, sin filtrar por quién
  lo cargó).

## Cambios

### 1. `supabase/migrations/253_etapa1_logistica_cobro_en_entrega.sql`
- `entregas.monto_cobrado` (NUMERIC) — monto cobrado en esa entrega, si hubo.
- `entregas.medio_cobro` (TEXT) — efectivo | transferencia | cheque | otro.
- `entregas.cobro_id` (UUID, FK a `cobros`) — trazabilidad hacia el
  registro contable completo.

### 2. `lib/handlers/pedidos.js` — `PATCH /api/chofer/remitos/:id/entregar`
- Acepta un campo opcional `cobro: { monto, medio, notas }` en el body.
- Si viene con `monto > 0`: valida que el pedido tenga cliente asociado y
  que se haya elegido medio de pago, y llama a `registrar_cobro_completo`
  **antes** de marcar el pedido como entregado. Si el cobro falla, la
  entrega NO se confirma (para que el chofer pueda corregir monto/medio y
  reintentar) — la firma y la foto ya están subidas a Storage, no se
  pierden.
- Si el cobro se registra bien, guarda `monto_cobrado`, `medio_cobro` y
  `cobro_id` en la fila de `entregas` junto con el resto de los datos de
  la entrega.
- `GET /api/chofer/remitos?id=` ahora también devuelve `monto_cobrado` y
  `medio_cobro` de la entrega, para poder mostrarlos en el detalle.

### 3. `frontend/chofer/remito.html`
- Nuevo campo opcional en el modal "Confirmar entrega": monto + medio de
  pago (mismo vocabulario que usa el admin: Efectivo / Transferencia /
  Cheque / Otro). Si se deja vacío, no se registra ningún cobro (caso
  cliente con cta. cte. o que ya pagó por transferencia antes).
- Validación en el cliente: si hay monto, exige medio de pago; monto debe
  ser mayor a cero.
- Una vez entregado, si hubo cobro, se muestra en la tarjeta del remito:
  "💵 Cobraste $X (Efectivo)".

## Verificación

- `node --check` OK en `lib/handlers/pedidos.js`.
- JS inline de `remito.html` extraído y verificado con `node --check`.
- Tags balanceados en `remito.html` (43 `<div>` / 43 `</div>`).

## Pendiente (fuera de este alcance)

- `dashboard-v2.html` / `setup-wizard.html`: decisión de producto sobre
  fusionar, eliminar o documentar cuál es la vigente.
- Reglas de precio: evaluar si conviene duplicar el acceso desde Ventas
  (hoy sólo está en Facturación).
- Candidatos de pulso de prioridad Media/Baja (badge de Recordatorios,
  pestaña "¿A quién llamo hoy?", botón "Confirmar entrega" mientras falte
  firma) — el informe sólo pedía aplicar los de prioridad Alta.
