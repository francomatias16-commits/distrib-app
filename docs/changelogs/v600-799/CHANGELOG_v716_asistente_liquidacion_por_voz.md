# v716 — Asistente: liquidación por voz (Fase D, cierre del plan)

## Contexto

`PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md` §6 dejaba una sola fila
pendiente sin decisión explícita: `liquidacion.html`, marcada 🔴 ("sin
tool, sin RPC server-side"). Al auditar el código real (mismo tipo de
error de inventario ya encontrado con facturación en v715) se confirmó
que el diagnóstico estaba mal: `lib/handlers/stock.js`
(`handleLiquidacion()`), `lib/repos/stock.js` y la RPC
`generar_ofertas_liquidacion` (`supabase/migrations/190_fix_...sql`) ya
existían completos y en uso por el panel admin — solo faltaba cablear las
tools del asistente sobre esa capa ya construida, sin tocar nada de eso.

## Tools agregadas (`lib/asistente-tools.js`)

| Tool | Tipo | Roles | Qué hace |
|---|---|---|---|
| `consultar_ofertas_liquidacion_asistente` | lectura | dueño, admin, vendedor, depositero | Ofertas de liquidación activas: producto, lote, precio de oferta, % descuento, cantidad disponible, cuándo vence la oferta. |
| `consultar_reglas_liquidacion_asistente` | lectura | dueño, admin, vendedor, depositero | Reglas vigentes: activo/inactivo, `dias_alerta`, y los 3 niveles de días/% descuento. |
| `generar_ofertas_liquidacion_asistente` | escritura, `requiereConfirmacion` | dueño, admin | Dispara `generar_ofertas_liquidacion` ahora (mismo botón "Generar ahora" del panel, que normalmente corre por cron). |
| `guardar_reglas_liquidacion_asistente` | escritura, `requiereConfirmacion` | dueño, admin | Patch parcial de las reglas (activo, `dias_alerta`, niveles 1-3). |

Roles de lectura calcados de `stock: { acceder: [...] }` en
`lib/permisos-service.js` — el mismo gate que usa `handleLiquidacion()`
para listar ofertas y reglas (más amplio que la escritura, que en el
handler real está restringida a `['dueno','admin']` con un chequeo
explícito para `generar` y `guardar-reglas`; se replicó igual acá).

## Detalles de implementación que valen la pena dejar anotados

- **`generar_ofertas_liquidacion_asistente` usa `p_dry_run` para el
  `resumen()`.** La RPC ya soportaba ese parámetro desde antes (lo usa
  el propio cron para simular), pero `handleLiquidacion()` nunca lo manda
  en `true` para el disparo manual del admin — así que no había ningún
  lugar del código real haciendo un preview. Se aprovechó acá: `resumen()`
  corre la RPC en modo `dry_run` (no escribe nada) para mostrarle al
  usuario cuántas ofertas se van a crear/actualizar y cuántas se van a
  desactivar *de verdad*, en vez de una frase genérica tipo "se van a
  generar ofertas de liquidación". `execute()` corre después la versión
  real (`p_dry_run: false`), solo tras el click de Confirmar.
- **`guardar_reglas_liquidacion_asistente` valida rangos y orden.**
  `guardarReglas()` (repo) hace un upsert directo sin validar nada — el
  panel confía en los límites del formulario HTML (`type="number"`,
  `min`/`max`). Como acá no hay formulario, se agregó validación explícita
  antes de guardar: cada `pct_nivelN` entre 0 y 100, y
  `dias_nivel1 > dias_nivel2 > dias_nivel3` (si no, la RPC de generación
  aplicaría el nivel equivocado silenciosamente — ver la lógica de
  `generar_ofertas_liquidacion` en la migración 190).
- **`guardar_reglas_liquidacion_asistente` es un upsert de fila completa,
  no un `UPDATE` parcial por id** (a diferencia de
  `editar_regla_precio_asistente`/`editar_regla_automatizacion_asistente`,
  que sí tienen id). El helper `armarCambiosReglaLiquidacion` trae la fila
  actual completa (o los mismos defaults que usa `handleLiquidacion()`
  cuando la empresa nunca configuró reglas: `dias_alerta:7, dias_nivel1:3
  pct_nivel1:10, dias_nivel2:1 pct_nivel2:15, dias_nivel3:0 pct_nivel3:25,
  activo:true`) y pisa encima solo los campos que el usuario pidió
  cambiar, antes de mandar el objeto completo al upsert.

## Hallazgo aparte, sin resolver todavía (fuera de alcance de este changelog)

Al revisar el archivo para ubicar dónde insertar las tools nuevas, se
detectó que `crear_regla_precio_asistente` y `editar_regla_precio_asistente`
(Fase B, dadas por ✅ cerradas) llaman a tres funciones que **no están
definidas en ningún lado del archivo ni del repo**: `armarCamposReglaPrecio`,
`describirReglaPrecio` y `armarCambiosReglaPrecio`. Hoy esas dos tools
tirarían `ReferenceError` apenas alguien intente crear o editar una regla
de precio por voz — nunca se llegaron a escribir esos helpers (sí se
escribió el equivalente para reglas de automatización,
`armarCambiosReglaAutomatizacion`/`armarCamposReglaAutomatizacion`, que
funciona bien). No lo toqué en esta tanda porque no es parte de
liquidación y quería que este changelog quedara acotado a lo que pediste —
avisame si querés que lo arregle ahora (es un fix contenido: escribir los
3 helpers que faltan, calcados 1 a 1 del patrón que ya usa
`armarCambiosReglaAutomatizacion`).

## Pendiente

- Prueba funcional contra datos reales (sin credenciales de Supabase en
  este entorno) — igual que el resto de las tools de Fase A/B, ver §6 del
  plan.
- Con esto, el plan `PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md` ya no
  tiene ninguna fila 🔴/🟠 sin decisión explícita (§6 actualizado).
