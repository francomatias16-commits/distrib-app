# Etapa 10 — Fidelización (puntos y recompensas)

Cobertura: acreditación de puntos (`acreditarPuntos()` en
`lib/handlers/pedidos.js`), catálogo y canje (`lib/handlers/fidelizacion.js`
+ `canjear_recompensa()`), panel admin (`frontend/admin/fidelizacion.html`
+ `js/fidelizacion.js`), portal cliente (`frontend/cliente/cuenta.html`) y
las políticas RLS de las 5 tablas del módulo (`saldo_puntos`,
`movimientos_puntos`, `recompensas`, `programas_fidelizacion`,
`canjes_recompensas`).

## Resumen de hallazgos

| # | Severidad | Estado |
|---|---|---|
| 1. RLS de puntos/recompensas sin aislar por cliente ni por rol — cualquier cliente podía leer y **escribir** puntos de otros clientes | 🔴 Crítica | ✅ Corregido en DB (aplicado directo en producción) |
| 2. Cancelar un pedido nunca revertía los puntos ya acreditados, contradiciendo la ayuda al usuario | 🟡 Media | ✅ Corregido — DB (nueva RPC) + código (`lib/handlers/pedidos.js`), pendiente `git push`/deploy |
| 3. Botón "Aplicar"/"Expirar" canje en el admin fallaba en silencio (sin policy UPDATE) | 🔴 Alta-media | ✅ Corregido en DB (parte del fix del Hallazgo 1) |
| 4. `canjear_recompensa()` no respetaba `puntos_minimos_canje` pese a estar documentado como exigido | 🟢 Baja | ✅ Corregido en DB |
| 5. KPI "Puntos bonus este mes" del panel admin mostraba siempre 0 (tipo `'bonus'` nunca se inserta) | 🟢 Baja | ✅ Corregido en código (`frontend/admin/js/fidelizacion.js`), pendiente `git push`/deploy |
| 6. POS no acredita puntos de fidelización, pese a que la ayuda dice "todos los clientes acumulan puntos con sus compras" | 🟢 Informativo | ✅ Resuelto (2026-07-13) — decisión del usuario: no implementar, se ajustó la ayuda en su lugar |

## Hallazgo 1 — RLS sin aislamiento por cliente (🔴 crítico)

**Qué pasaba:** las políticas RLS de `saldo_puntos`, `movimientos_puntos`,
`recompensas`, `programas_fidelizacion` y `canjes_recompensas` solo
comprobaban `empresa_id = get_empresa_id()`. Como un cliente autenticado
también tiene una fila en `usuarios` con su `empresa_id` real (mismo
patrón que usa `resolverClienteDesdeSesion()` en
`lib/handlers/fidelizacion.js`), esa condición es verdadera para
cualquier cliente de la empresa, no solo para el dueño de la fila.

El portal cliente (`frontend/cliente/cuenta.html`) usa `supabase-js` con
sesión propia y consulta estas tablas directo (sin pasar por el backend)
— es el patrón correcto para lectura simple, pero necesita que la RLS
haga el trabajo de aislamiento que el frontend no puede garantizar por sí
solo (cualquiera puede abrir la consola del navegador y pegar su propio
`fetch`/`supabase.from(...)` sin las condiciones que pone la pantalla).

Con las políticas viejas, cualquier cliente logueado podía, con su propia
sesión:

- **Leer** el saldo, historial de movimientos y canjes de **todos** los
  clientes de su empresa (filtrando solo por `empresa_id`, sin
  `cliente_id`) — fuga de datos entre clientes de la misma distribuidora.
- **Escribir** directo en `saldo_puntos.puntos_disponibles` vía `UPDATE`
  (la policy de escritura tampoco distinguía cliente ni rol) y regalarse
  puntos ilimitados. Ese saldo falso después se podía canjear de verdad:
  `canjear_recompensa()` es segura y usa `service_role`, pero confía en
  el saldo que lee de `saldo_puntos` — si ese saldo ya está falsificado,
  el canje "legítimo" entrega una recompensa real sin haberla pagado con
  puntos genuinos.
- **Crear o editar** recompensas y la configuración del programa
  (`puntos_por_peso`, `bonus_pct_categoria`), pese a que el comentario en
  `010_etapa7_fidelizacion.sql` decía explícitamente "Solo dueño/admin
  pueden crear/modificar el programa" — la condición real nunca lo
  exigía.

**Cómo se encontró:** comparando las políticas contra el patrón ya
establecido y probado en el resto del sistema para separar cliente
interno vs. cliente externo (`pedidos_select` / `clientes_select` en
`040_fix_rls_duplicates.sql`), que sí usa
`cliente_id IN (SELECT id FROM clientes WHERE usuario_id = auth.uid())`.
Las tablas de fidelización (agregadas en la etapa 7, antes de que ese
patrón se consolidara) nunca se alinearon a ese estándar, y ninguna
auditoría de RLS posterior (043, 077, 095, 098 — todas centradas en
"¿tiene RLS activado?") llegó a revisar la granularidad de la condición.

**Fix (ya aplicado en producción):**
`296_fix_etapa10_h1_rls_fidelizacion_aislamiento_cliente.sql` — mismo
patrón `es_admin()` (acceso interno amplio) OR `cliente_id IN (...)`
(acceso propio) para SELECT en las 5 tablas; `es_admin()` puro para
INSERT/UPDATE/DELETE en `saldo_puntos`, `movimientos_puntos`,
`recompensas` y `programas_fidelizacion` (nadie necesita escribirlas
directo desde el navegador — todo pasa por RPCs `SECURITY DEFINER` con
`service_role`, que bypasean RLS igual). El catálogo de `recompensas`
(SELECT) se dejó como estaba: es la vidriera pública del programa, todos
los clientes de la empresa deben poder verla.

## Hallazgo 2 — Cancelar un pedido no revierte los puntos ganados (🟡 media)

**Qué pasaba:** `DELETE /api/pedidos?id=` (cancelación admin) revierte
stock reservado y anula/emite NC de la factura vinculada, pero nunca
tocaba `saldo_puntos`/`movimientos_puntos`. La ayuda al usuario
(`docs/ayuda/fidelizacion-puntos-y-recompensas.md`) dice explícitamente
en la FAQ: *"¿Se pueden perder puntos ya ganados? Sí, por ejemplo si se
anula el pedido que los generó"* — una promesa que el código nunca
cumplió: un pedido cancelado dejaba los puntos ganados intactos en el
saldo del cliente.

**Fix:** nueva RPC `revertir_puntos_pedido_cancelado(p_pedido_id,
p_empresa_id)` (`298_fix_etapa10_h2_revertir_puntos_pedido_cancelado.sql`),
llamada desde el handler de cancelación en `lib/handlers/pedidos.js`
justo después de marcar el pedido como `cancelado`. Si el cliente ya
canjeó parte de esos puntos antes de que se cancelara el pedido, revierte
solo lo que quede disponible (nunca deja el saldo negativo) y registra un
movimiento `tipo='ajuste'` con el pedido como referencia, para que quede
trazado en el historial. Es idempotente: si por algún motivo el handler
se ejecuta dos veces sobre el mismo pedido, no revierte doble.

**Pendiente:** `git push`/deploy a Vercel para que el código tenga
efecto (la RPC en Supabase ya está viva).

## Hallazgo 3 — Canje "Aplicado"/"Expirado" fallaba en silencio (🔴 alta-media)

**Qué pasaba:** en `/admin/fidelizacion.html`, la pestaña de canjes
pendientes tiene botones "Aplicar" y "Expirar"
(`actualizarEstadoCanje()` en `frontend/admin/js/fidelizacion.js`) que
hacen `sb.from('canjes_recompensas').update(...)` directo con la sesión
del admin. La tabla `canjes_recompensas` nunca tuvo una policy `UPDATE`
desde que se creó (`010_etapa7_fidelizacion.sql` solo definió `SELECT` e
`INSERT`). Con RLS y ninguna policy que matchee, Postgres/PostgREST no
tira error: el `UPDATE` simplemente no afecta ninguna fila, `error` queda
`null`, y el código muestra el toast "Canje aplicado" — el admin cree que
funcionó, pero el estado del canje nunca cambió en la base. Mismo patrón
de falla silenciosa que ya se había encontrado y corregido en otros
módulos (notificaciones, stock).

**Fix:** incluido en `296_...sql` — se agregó la policy `canjes_update`
(`es_admin()`), corregida en la misma migración del Hallazgo 1 porque
tocaba la misma tabla.

## Hallazgo 4 — `puntos_minimos_canje` configurado pero nunca usado (🟢 baja)

**Qué pasaba:** `programas_fidelizacion.puntos_minimos_canje` existe
desde la migración original, el admin lo edita desde la pantalla de
configuración (`config-puntos-minimos` en `fidelizacion.js`), y la ayuda
al usuario lo documenta como un piso general que el sistema exige para
poder canjear cualquier recompensa. `canjear_recompensa()` nunca lo leía
— solo comparaba el saldo contra el costo puntual de la recompensa
elegida. Si una empresa configuraba, por ejemplo, un mínimo de 200 puntos
pero tenía una recompensa que solo pedía 50, un cliente con 60 puntos
podía canjearla igual, salteándose el piso que el admin creía haber
fijado.

**Fix:** incluido en `297_...sql` — `canjear_recompensa()` ahora valida
además que `puntos_disponibles >= puntos_minimos_canje` del programa
activo de la empresa, antes de permitir el canje.

## Hallazgo 5 — KPI "Puntos bonus este mes" mostraba siempre 0 (🟢 baja)

**Qué pasaba:** el dashboard de `/admin/fidelizacion.html` calcula un KPI
filtrando `movimientos_puntos.tipo = 'bonus'`, pero ese valor de `tipo`
nunca se inserta en ningún lado del código — el bonus por categoría de
score (Innovación #8, `bonus_pct_categoria`) se suma **dentro** de la
ganancia total con `tipo='ganancia'` (ver `acreditarPuntos()` en
`pedidos.js`). El KPI quedaba permanentemente en 0 aunque el bonus sí se
esté acreditando de verdad — podía leerse como que la función de bonus
por categoría no funciona, cuando en realidad el problema es solo del
cálculo del KPI.

**Fix:** se reemplazó por un KPI real y verificable: "Puntos ganados este
mes" (`tipo='ganancia'`, dato que sí existe). Separar el bonus del monto
base requeriría cambiar cómo se registra el movimiento en el momento de
acreditar (guardar base y bonus como dos filas, o una columna aparte) —
no se hizo en esta pasada por ser un cambio de modelo de datos, no un bug
puntual; queda anotado por si se quiere ese detalle más adelante.

**Pendiente:** `git push`/deploy a Vercel.

## Hallazgo 6 (RESUELTO 2026-07-13) — POS no acredita puntos; se ajustó la ayuda
🟢 Informativo — cerrado

`acreditarPuntos()` solo se llama desde los dos flujos de creación de
pedido (portal cliente y alta admin) en `pedidos.js`. Ninguna venta de
POS (`lib/handlers/pos.js`) acredita puntos de fidelización, mientras que
la ayuda al usuario decía "todos los clientes acumulan puntos con sus
compras" sin distinguir canal.

**Decisión del usuario:** no desarrollar la acreditación de puntos en
POS por ahora (no es un bug, era una decisión de producto pendiente).
Se ajustó la documentación en vez de tocar código:
`docs/ayuda/fidelizacion-puntos-y-recompensas.md`, FAQ "¿Todos los
clientes participan del programa automáticamente?" — ahora aclara que
la acumulación automática aplica a **pedidos** (portal/app o cargados
por vendedor/admin), y que las ventas de mostrador (POS) no suman
puntos por el momento, aunque estén asociadas a un cliente identificado.

Sin cambios de código ni de base de datos. Si en el futuro se quiere
sumar puntos también en POS, queda pendiente definir: (a) qué pasa con
ventas sin `cliente_id` (mostrador anónimo, hoy la mayoría — no
sumarían, no hay a quién acreditar), y (b) que anular una venta de POS
revierta los puntos igual que ya hace la cancelación de un pedido
(Hallazgo 2) — son las dos decisiones que ya se conversaron y quedaron
resueltas *si algún día se retoma* esto, pero no aplican hoy porque no
se va a implementar.

## Archivos modificados

- `supabase/migrations/296_fix_etapa10_h1_rls_fidelizacion_aislamiento_cliente.sql` (nuevo)
- `supabase/migrations/297_fix_etapa10_h4_canjear_recompensa_puntos_minimos.sql` (nuevo)
- `supabase/migrations/298_fix_etapa10_h2_revertir_puntos_pedido_cancelado.sql` (nuevo)
- `lib/handlers/pedidos.js` — llama a `revertir_puntos_pedido_cancelado()`
  al cancelar un pedido.
- `frontend/admin/js/fidelizacion.js` — KPI "Puntos ganados este mes" en
  vez de "Puntos bonus este mes".

## Base de datos (Supabase)

Ya aplicado directo en producción, sin acción pendiente: migraciones 296,
297 y 298 (ver detalle de cada una arriba). Registradas en
`schema_migrations_registry`.

## Pendiente

- `git push`/deploy a Vercel para que los fixes de código (Hallazgos 2 y
  5) tengan efecto — la parte de base de datos ya está viva.
- Etapas 6, 7, 9, 11 y 12 de esta auditoría de módulos siguen pendientes.
