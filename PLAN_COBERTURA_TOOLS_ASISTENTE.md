# Plan de cobertura de tools del asistente (2026-09-07)

## 0. Por qué existe este plan

Un cliente preguntó algo puntual que el asistente no pudo responder (cayó al
fallback genérico). Eso no se soluciona agregando una tool suelta: la causa
de fondo es que nadie había comparado nunca, de forma sistemática, **todas**
las funciones (RPC) que ya existen en la base contra **todas** las tools
que el catálogo del asistente (`lib/asistente-tools/`) realmente expone.

Este documento es el resultado de esa auditoría completa (no del caso
puntual) y el orden de trabajo para cerrar cada hueco encontrado. Mismo
principio que ya usó `FASE7_PLAN_ARRANQUE.md` para la migración a repos:
relevamiento real primero, plan de ejecución después.

**Ningún hueco de este tipo se puede prevenir "para siempre" con una sola
sesión de trabajo** — un asistente con tool calling solo puede responder lo
que sus tools le permiten consultar. Este plan cierra los huecos de **hoy**;
cuando se agregue una RPC nueva al sistema, hay que volver a correr la
auditoría (`scripts/audit-asistente-tools.js`) para ver si también necesita
su tool.

## 1. Método de auditoría

1. Listar todas las funciones `public.*` de `supabase/migrations/*.sql`
   (quedándose con la última migración que tocó cada una).
2. Listar todos los `db.rpc(...)` y `db.from(...)` usados dentro de
   `lib/asistente-tools/*.js`.
3. Restar: funciones que existen en la base pero a las que ninguna tool del
   asistente llama nunca.
4. Para cada resto, buscar si hay una pregunta de negocio real y frecuente
   que esa función resolvería, y si el handler/panel administrativo ya la
   usa en producción (evita reinventar cálculos).
5. **Paso extra que no estaba en la primera pasada** (agregado después de
   encontrar el hallazgo de la sección 3): para cada candidata, revisar
   también **cómo resuelve el `empresa_id`** — no alcanza con que la
   función exista y tenga una pregunta que la necesite.

## 2. Cómo agregar una tool nueva (recordatorio, no cambia)

1. Confirmar que la RPC existe, está `SECURITY DEFINER`, revocada de
   `PUBLIC`/`anon` y con `GRANT EXECUTE` a `service_role` (el catálogo del
   asistente llama todo con el cliente de `lib/repos/_db.js`, que usa
   `SUPABASE_SERVICE_ROLE_KEY` — ver hallazgo crítico abajo, sección 3).
2. Agregar la entrada a `TOOLS_<DOMINIO>` en `lib/asistente-tools/<dominio>.js`:
   `name`, `description` (en español, clara — el modelo elige según esto),
   `roles`, `parameters` (JSON Schema) y `execute()`.
3. Agregar los casos correspondientes a
   `tests/asistente/cobertura-seleccion-tools.test.js` (que el selector por
   palabras clave la encuentre) **y** un test de ejecución dedicado (que la
   tool arme bien los parámetros y propague error), mismo patrón que
   `tests/asistente/consultar-reportes-negocio.test.js`.
4. Si es de escritura: `requiereConfirmacion: true` + `resumen()` — no
   aplica a ninguna tool de este plan, todas son de solo lectura.

## 3. Hallazgo crítico transversal — bloqueante para 2 de los 4 frentes pendientes

El cliente `db` que usa **todo** `lib/asistente-tools/` es el de
`lib/repos/_db.js`, creado con `SUPABASE_SERVICE_ROLE_KEY` (sin JWT de
usuario — ver comentario del propio archivo: *"cada invocación es
stateless"*). Varias RPC de reportes **no reciben `p_empresa_id` como
parámetro**: lo resuelven solas por dentro con
`v_empresa_id := public.get_empresa_id()`, y esa función lee
`auth.uid()`:

```sql
-- get_empresa_id(), vigente:
SELECT empresa_id FROM public.usuarios
WHERE id = auth.uid() AND activo = true
LIMIT 1;
```

Con `service_role` no hay sesión de usuario → `auth.uid()` es `NULL` →
`get_empresa_id()` devuelve `NULL` → la función corre igual pero sin
filtrar nada por empresa (o devuelve vacío, según el `JOIN`/`WHERE`).
Llamar estas RPC tal cual desde una tool del asistente **no rompe con un
error visible**: devuelve datos vacíos o, peor, sin scope de empresa. Es
el mismo tipo de bug de seguridad que ya se corrigió una vez en
`232_fix_auditoria_etapa2_rls_empresas_activo_grants.sql` para
`empresas_select_propio`.

Afectadas (confirmado leyendo la migración vigente de cada una):

| Función | Migración | Recibe `p_empresa_id` | Grant a `service_role` |
|---|---|---|---|
| `fn_reportes_stock_valorizacion()` | 494 | ❌ (usa `get_empresa_id()`) | ✅ sí (494 lo agrega) |
| `fn_reportes_stock_distribucion(p_deposito_id)` | 200 | ❌ (usa `get_empresa_id()`) | ❌ solo `authenticated` |
| `fn_reportes_stock_kpis(p_deposito_id, p_categoria_id)` | 200 | ❌ (usa `get_empresa_id()`) | ❌ solo `authenticated` |
| `fn_facturas_contadores()` | 262 | ❌ (usa `get_empresa_id()`) | ✅ sí |
| `fn_facturas_lista(...)` | 262 | ❌ (usa `get_empresa_id()`) | ✅ sí |
| `fn_clientes_en_fuga(p_empresa_id, p_limite)` | 592 | ✅ **sí, ya la recibe** | (verificar grant puntual antes de usar) |

**Conclusión:** `fn_clientes_en_fuga` está lista para envolver en una tool
tal cual. Las otras cinco necesitan **una migración nueva primero**
(overload o `CREATE OR REPLACE` agregando `p_empresa_id uuid` como
parámetro explícito, con `GRANT EXECUTE ... TO service_role`) — mismo
patrón que ya se usó para las 6 RPC de `obtener_*` del frente 1
(`obtener_dashboard_ejecutivo_resumen`, etc., todas con `p_empresa_id`
explícito desde el día uno). Este paso de migración SQL queda fuera del
alcance de este repo de código y hay que coordinarlo antes de escribir la
tool — escribir la tool contra la función tal como está hoy dejaría un
agujero de scoping por empresa.

## 4. Estado por frente

### Frente 1 — Resúmenes de negocio (dueño/admin) — ✅ **hecho**

Sin bloqueo: las 6 RPC ya reciben `p_empresa_id` explícito.

| Tool | RPC | Estado |
|---|---|---|
| `consultar_resumen_ejecutivo` | `obtener_dashboard_ejecutivo_resumen` | ✅ |
| `consultar_comparativa_mensual` | `obtener_comparativa_mensual` | ✅ |
| `consultar_ventas_por_canal` | `obtener_ventas_por_canal` | ✅ |
| `consultar_resumen_compras_proveedor` | `obtener_resumen_compras_proveedor` | ✅ |
| `consultar_resumen_gastos_generales` | `obtener_resumen_gastos_generales` | ✅ |
| `consultar_estado_financiero_integral` | `obtener_estado_financiero_integral` | ✅ |

Archivos: `lib/asistente-tools/reportes.js` (nuevo),
`lib/asistente-tools/index.js` (registrado),
`tests/asistente/consultar-reportes-negocio.test.js` (15 tests),
6 casos nuevos en `tests/asistente/cobertura-seleccion-tools.test.js`.
Suite completa corrida: 311/311 en `tests/asistente`, 512/512 en
`tests/repos` + `tests/handlers/admin*`.

### Frente 2 — Clientes en fuga — ✅ **hecho**

| Tool | RPC | Estado |
|---|---|---|
| `consultar_clientes_en_fuga` | `fn_clientes_en_fuga(p_empresa_id, p_limite)` | ✅ |

Roles: `dueno`, `admin`, `vendedor` (mismo criterio que
`listar_clientes_por_deuda`, ya disponible para vendedor). Confirmado antes
de escribir la tool que `fn_clientes_en_fuga` es invocable con el cliente
`service_role` sin ningún cambio de SQL: `handleFugaCron`
(`lib/handlers/notif.js`) ya la llama en producción con ese mismo cliente.

Archivos: `lib/asistente-tools/clientes.js` (tool agregada al final de
`TOOLS_CLIENTES`), `tests/asistente/consultar-clientes-en-fuga.test.js`
(6 tests nuevos), 2 casos nuevos en
`tests/asistente/cobertura-seleccion-tools.test.js`. Suite completa
corrida: 319/319 en `tests/asistente`, 952/952 en `tests/handlers` +
`tests/repos`.

### Frente 3 — Stock: valorización y distribución — 🔴 bloqueado por SQL (sección 3)

| Tool propuesta | RPC | Pregunta típica sin cubrir hoy | Bloqueo |
|---|---|---|---|
| `consultar_stock_valorizacion` | `fn_reportes_stock_valorizacion()` | "cuánto vale mi stock total", "valorización de stock por depósito" | Necesita `p_empresa_id` explícito |
| `consultar_stock_distribucion` | `fn_reportes_stock_distribucion(p_deposito_id)` | "cómo se distribuye el valor del stock por categoría" | Necesita `p_empresa_id` explícito + grant a `service_role` |

No arrancar el código de la tool hasta que la migración SQL correspondiente
esté aplicada y confirmada (ver sección 3).

### Frente 4 — Facturación: listado general — 🔴 bloqueado por SQL (sección 3)

| Tool propuesta | RPC | Pregunta típica sin cubrir hoy | Bloqueo |
|---|---|---|---|
| `consultar_resumen_facturacion` | `fn_facturas_contadores()` | "cuánto facturamos este mes", "cuántas facturas están pendientes/con error AFIP" | Necesita `p_empresa_id` explícito |
| `listar_facturas` | `fn_facturas_lista(p_busqueda, p_estado, p_fecha_desde, p_fecha_hasta, p_limit, p_offset)` | "facturas de tal cliente", "facturas del mes pasado", "facturas pendientes" | Necesita `p_empresa_id` explícito |

Hoy el catálogo solo tiene tools puntuales (`emitir_factura`,
`anular_factura`, `listar_notas_credito`) — ninguna de listado/búsqueda
general, a pesar de que la RPC paginada con filtros ya existe y ya la usa
`facturacion.js` en el panel.

### Frente 5 — Pedidos: filtros más allá de "pendientes" — 🟡 sin bloqueo SQL, requiere RPC nueva o extender la query existente

`listar_pedidos_pendientes` (en `lib/asistente-tools/pedidos.js`) hoy hace
un `.from('pedidos')` directo, hardcodeado a excluir solo
`entregado`/`cancelado`, sin filtro de estado puntual, sin filtro de
cliente y sin rango de fechas:

```js
.eq('empresa_id', empresaId)
.not('estado', 'in', '(entregado,cancelado)')
.order('created_at', { ascending: true })
.limit(limit);
```

Preguntas sin cubrir: "pedidos entregados esta semana", "historial de
pedidos de tal cliente", "pedidos cancelados del mes". No hace falta una
RPC nueva necesariamente — se puede resolver extendiendo esta misma query
(`.eq('estado', ...)` opcional, `buscarClientePorTexto` ya existe en
`_helpers.js` para resolver "tal cliente" a un `cliente_id`, y
`.gte/.lte('created_at', ...)` para el rango). Evaluar si conviene:

- (a) una tool nueva `listar_pedidos_por_filtro` con `estado`, `cliente`,
  `desde`, `hasta` opcionales, o
- (b) ampliar `listar_pedidos_pendientes` para que sirva también sin el
  filtro fijo de pendientes (cambia su contrato actual, más riesgoso).

Preferencia: (a), no toca nada ya probado.

## 5. Orden de ejecución propuesto

1. ~~Frente 1 — Resúmenes de negocio~~ ✅ **hecho**
2. ~~Frente 2 — Clientes en fuga~~ ✅ **hecho**
3. **Coordinar la migración SQL de la sección 3** (agregar `p_empresa_id`
   explícito a las 5 funciones afectadas + grants a `service_role`) — esto
   desbloquea los frentes 3 y 4 a la vez
4. **Frente 3 — Stock: valorización y distribución**
5. **Frente 4 — Facturación: listado general**
6. **Frente 5 — Pedidos: filtros por estado/cliente/fecha**

## 6. Qué falta para cerrar cada frente (checklist reutilizable)

- [ ] RPC confirmada con `p_empresa_id` explícito y grant a `service_role`
- [ ] Tool agregada al módulo de dominio correspondiente en `lib/asistente-tools/`
- [ ] Registrada en `lib/asistente-tools/index.js`
- [ ] Casos nuevos en `tests/asistente/cobertura-seleccion-tools.test.js`
      (que el selector por palabras clave la encuentre para el rol correcto)
- [ ] Test de ejecución dedicado (parámetros, propagación de datos y de error)
- [ ] Suite completa de `tests/asistente` corrida en verde
