# Etapa 2 — Stock y depósitos

**Flujo auditado:** `frontend/admin/stock.html` + `frontend/admin/js/stock.js`
→ `POST /api/stock` (ajuste manual) → `lib/handlers/stock.js`, y el resto
de sub-rutas absorbidas en el mismo handler (lotes, FEFO, sugerencias,
catálogo cliente, liquidación).

---

## 🔴🔴 Hallazgo 1 — El ajuste manual de stock no valida empresa ni lockea la fila: podía tocar stock de otra empresa y perder ajustes concurrentes

**Lo que encontré:** `POST /api/stock` reimplementaba a mano (select +
upsert) exactamente lo que la función `ajustar_stock()` (migración 201) ya
resuelve bien y que el propio frontend usa para transferencias entre
depósitos. La versión del handler:

- No validaba que `producto_id`/`deposito_id` (vienen del body, controlados
  por el cliente) pertenecieran a la empresa del usuario logueado —
  cualquier `depositero`/`admin` podía mandar el id de un producto o
  depósito de **otra empresa** y modificar su stock real.
- No lockeaba la fila (`FOR UPDATE`) antes de calcular el nuevo valor: dos
  ajustes concurrentes sobre el mismo producto podían pisarse (lost
  update).
- En egresos, clampeaba a 0 en vez de rechazar cuando la cantidad pedida
  superaba el stock disponible.

**Por qué pasó:** la RPC seleccion `ajustar_stock()` ya tenía todo esto
resuelto, pero solo funciona con contexto de sesión real
(`get_empresa_id()`/`get_rol_usuario()` dependen de `auth.uid()`), y el
backend llama a Supabase con la service role key (sin JWT de usuario) —
así que llamarla directo desde el backend siempre devolvía "Sin
autorización". Alguien resolvió eso reimplementando la lógica en el
handler en vez de adaptar la RPC para llamadas del backend.

**Severidad:** crítica — cross-tenant real sobre datos de stock.

**Fix aplicado:**
1. **Supabase (ya aplicado en producción):** `ajustar_stock()` acepta un
   `p_usuario_id` opcional. Si quien llama es `service_role`, salta el
   chequeo `get_empresa_id()`/`get_rol_usuario()` (el backend ya validó
   token+rol+empresa antes de invocarla) y usa el `p_usuario_id` explícito
   para el registro en `movimientos_stock`. Si quien llama es una sesión
   normal (`authenticated`, como ya hace el frontend hoy), el
   comportamiento no cambia. También se agregó verificación de que
   `producto_id` y `deposito_id` sean de la misma empresa entre sí. Mismo
   patrón ya usado en `anular_venta_pos`/`registrar_cobro_completo`
   (SEC-009). Migración: `fix_etapa2_h1_ajustar_stock_service_role_callers`.
2. **Código (pendiente de deploy):** `lib/handlers/stock.js` — el POST de
   ajuste manual ahora valida que `deposito_id` sea de la empresa (defensa
   adicional) y llama a `ajustar_stock()` en vez de hacer el select+upsert
   a mano.

---

## 🟡 Hallazgo 2 — Crear un lote no validaba que el depósito fuera de la empresa

**Lo que encontré:** en `handleLotes` (POST), se valida que `producto_id`
pertenezca a la empresa, pero `deposito_id` se insertaba sin chequeo — se
podía crear un lote apuntando al depósito de otra empresa (inconsistencia
de datos; no movía stock ajeno, a diferencia del Hallazgo 1).

**Severidad:** media.

**Fix aplicado (código, pendiente de deploy):** mismo chequeo que ya se
usa para `producto_id`, aplicado también a `deposito_id`.

---

## Revisión adicional de interfaz (frontend/admin/js/stock.js)

La primera pasada de esta etapa fue solo de backend. Esto es lo que
encontré al revisar la experiencia real en pantalla del modal de ajuste
de stock.

**Dato importante que cambia el contexto del Hallazgo 1:** el modal de
ajuste (`stock.html`/`stock.js`) **no usa** `POST /api/stock` — llama
directo a la RPC `ajustar_stock()` con la sesión del usuario (`sb.rpc(...)`),
igual que ya hacía para transferencias. Confirmé que ningún otro lugar del
frontend llama al endpoint que arreglé en el Hallazgo 1. Eso no invalida el
fix — el endpoint sigue vivo y llamable directo por cualquiera con un
token válido (por ejemplo con curl, sin pasar por ninguna pantalla) — pero
sí significa que **hoy nadie lo dispara desde la interfaz real**; es una
ruta huérfana, más que una que el usuario común encuentre.

### 🔴 Hallazgo 3 — Una transferencia entre depósitos puede dejar el stock "perdido" a mitad de camino, y el usuario no se entera

**Lo que encontré:** transferir stock entre depósitos son **dos llamadas
RPC separadas** desde el navegador (débito en origen, después crédito en
destino) — no una transacción única. Si la primera tiene éxito y la
segunda falla (corte de red, depósito destino inválido, lo que sea), el
código anterior mostraba el mismo toast genérico ("No se pudo acreditar
el stock en destino") que si nada se hubiera tocado. En los hechos, el
stock ya había salido del depósito de origen — quedaba fuera de los dos
depósitos, sin que nada en la pantalla lo dijera.

**Severidad:** alta — pérdida de stock real sin aviso, en una operación
que se hace seguido (mover mercadería entre depósitos).

**Fix aplicado:** si el segundo paso falla, ahora se intenta revertir
automáticamente el primero (devolver el stock a origen). Si la reversión
funciona, el mensaje dice explícitamente que no se perdió stock. Si la
reversión también falla (caso extremo), el mensaje le dice al usuario que
revise manualmente ese producto entre ambos depósitos antes de seguir
operando, en vez de un genérico "no se pudo".

### 🟡 Hallazgo 4 — "Verificá la consola" como mensaje de error

**Lo que encontré:** el `catch` general de `guardarAjuste()` mostraba
"Error al guardar. Verificá la consola." — un depositero o vendedor
promedio no sabe qué es la consola del navegador ni cómo abrirla.

**Fix aplicado:** mensaje que explica qué hacer (reintentar, y si sigue
fallando, avisar a soporte) sin asumir conocimiento técnico.

---

## Resumen de la etapa

| Hallazgo | Severidad | Estado |
|---|---|---|
| 1 — Ajuste manual de stock sin validar empresa ni lock atómico | 🔴🔴 Crítica | ✅ Corregido (DB aplicada, código pendiente de deploy) — endpoint no usado hoy desde la UI, pero sigue expuesto y llamable directo |
| 2 — Alta de lote sin validar depósito de la empresa | 🟡 Media | ✅ Corregido (código pendiente de deploy) |
| 3 — Transferencia en dos pasos puede perder stock sin avisar | 🔴 Alta | ✅ Corregido (código pendiente de deploy) |
| 4 — Mensaje de error no accionable ("verificá la consola") | 🟡 Media | ✅ Corregido (código pendiente de deploy) |

## Pendiente para el usuario
- `git push` / deploy a Vercel para que los fixes de código tengan efecto.
- Decisión de negocio, no técnica: el Hallazgo 1 corrige un endpoint que
  hoy no usa ninguna pantalla — si no tenés planes de usarlo (app externa,
  integración futura, etc.), podría directamente eliminarse en vez de
  mantenerlo corregido. Lo dejé corregido y no lo borré por las dudas.
- `handleSugerencias` (motor de reposición) y `handleLiquidacion` siguen
  sin auditar en profundidad, ni en backend ni en interfaz.
