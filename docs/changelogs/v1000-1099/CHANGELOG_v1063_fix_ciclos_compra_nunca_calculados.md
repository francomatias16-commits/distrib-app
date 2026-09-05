# v1063 — Fix: `calcular_ciclos_cliente` nunca se invocaba (ciclos_compra en cero para todos los tenants reales)

Continuación directa de la sesión que reponía datos de demo para
`/admin/clientes-fuga` (v1061). Al reponer los 3 registros manuales de
`ciclos_compra` para el tenant de demo se encontró que la tabla estaba en
cero *para toda empresa*, no solo para la demo — lo que llevó a auditar el
motor real.

## Hallazgo

Existe la función `calcular_ciclos_cliente(p_empresa_id)` desde la migración
032 (`supabase/migrations/032_piloto_automatico.sql`): analiza `pedidos` +
`pedido_items` de los últimos 6 meses y hace upsert en `ciclos_compra` por
cliente/producto cuando hay ≥3 compras del mismo producto por el mismo
cliente con intervalo positivo.

Ningún handler ni cron la invoca nunca. Los únicos crons de Piloto
Automático en `vercel.json` eran:

- `?accion=generar` → `generar_pedidos_sugeridos`, que **lee** de
  `ciclos_compra` pero no la calcula.
- `?accion=whatsapp-cron` → envía por WhatsApp los sugeridos ya generados.

Resultado: los 6 tenants de pago activos verificados en esta sesión
(Selecta Studio, Distribuidora del Sol, Distribuidora Desing, Distri Gas,
Studio Proveedores, Maribel Distribuciones) tenían `ciclos_compra` en cero
con `ultima_actualizacion: null` — es decir, jamás se calculó nada. Tanto el
Piloto Automático de Pedidos como "Clientes en fuga" dependen de esta tabla
para tener algo de dónde leer.

**Nota separada, no resuelta por este fix:** al intentar recalcular contra
los 6 tenants reales para confirmar el fix, se encontró que esas mismas 6
empresas tienen **0 registros en `pedidos`** (no solo 0 ciclos) — ver sesión
de verificación en Supabase. `calcular_ciclos_cliente` corrió sin error
sobre las 6, pero generó 0 ciclos en todas, porque no hay historial de
pedidos del cual derivarlos. Este fix resuelve la causa raíz de código (la
función nunca se llamaba); **no resuelve la falta de pedidos histórico en
los tenants reales**, que es un problema de datos/negocio aparte y más
grande — hace falta confirmar con el equipo de producto si esos 6 tenants
están realmente operando pedidos por la plataforma o si están dados de alta
sin uso real todavía, antes de asumir que el Piloto Automático empezará a
sugerir algo por sí solo mañana.

## Fix

- `lib/repos/piloto.js`: nuevo export `calcularCiclosClienteRpc(empresa_id)`
  (llama al RPC `calcular_ciclos_cliente`). `listarEmpresasActivas` ahora
  también trae `nombre` (se usaba solo `id` antes; no rompe a los
  llamadores existentes, que ya destructuraban por `id`).
- `lib/handlers/piloto.js`: nuevo branch de cron
  `accion=recalcular-ciclos && esCron`, mismo patrón de auth que
  `accion=generar`. Recorre **todas** las empresas activas (incluida demo,
  a diferencia de `whatsapp-cron` que excluye demo) porque "Clientes en
  fuga" también depende de `ciclos_compra` para el tenant de demo. Un error
  puntual en una empresa no corta el resto de la corrida — se cuenta en
  `con_error` y se sigue.
- `vercel.json`: nueva entrada de cron, `30 6 * * *` (corre antes que
  `?accion=generar`, `0 7 * * *`, para que éste tenga de dónde leer cuando
  se ejecute).
- `tests/handlers/piloto-recalcular-ciclos-cron.test.js`: cobertura nueva
  del guard de `CRON_SECRET`, de que recorre todas las empresas sin excluir
  demo, y de que un error puntual no corta la corrida.

No hace falta migración nueva — el RPC ya existe desde la 032.

## Validado en esta sesión

- Suite completa: 99 archivos / 1409 tests, todos verdes
  (`npx vitest run --exclude "**/e2e/**"`).
- Test nuevo (`piloto-recalcular-ciclos-cron.test.js`): 5/5 verde.
