# Etapa 12 — Riesgo de cheques

**Estado: 🟢 Cerrada.** Auditado contra el código y la base real (no había
archivo de detalle previo — solo el título del hallazgo sobrevivió de la
sesión que lo generó; esta es la reconstrucción completa).

## Alcance auditado
- `frontend/admin/riesgo-cheques.html` + `frontend/admin/js/riesgo-cheques.js`
- `supabase/migrations/261_rpc_riesgo_cheques_lista_server_side.sql`
  (`fn_riesgo_cheques_lista`)
- RLS de `public.cheques`
- `lib/handlers/bcra.js` (consulta libre + verificación por cliente contra
  el Banco Central)
- `lib/handlers/score.js` (dependencia: alertas de score y cobranza
  priorizada que la pantalla combina con los datos de cheques)

## Lo que ya estaba bien (verificado, sin cambios)
- `fn_riesgo_cheques_lista()`: `SECURITY DEFINER`, deriva la empresa de
  `get_empresa_id()` de la sesión (no recibe `p_empresa_id` del cliente),
  `GRANT` solo a `authenticated`/`service_role`. Definición en producción
  verificada byte a byte contra el archivo del repo — sin drift.
- RLS de `cheques`: `SELECT`/`ALL` restringidas a
  `empresa_id = get_empresa_id() AND rol IN (dueno, admin, contador)`.
- `lib/handlers/bcra.js`: autenticado, rate-limited (30/min), roles
  `[dueno, admin, contador]`, CUIT/código de entidad/número de cheque
  validados (regex/`parseInt`) antes de interpolarse en la URL de la API
  del BCRA — sin riesgo de inyección en el path.

## Hallazgos encontrados y corregidos en esta sesión

### 🔴 CRÍTICO — `login.html` bloqueaba el login de vendedor/depositero/contador
No es del módulo de cheques en sí, pero se encontró **investigando por qué
`riesgo-cheques.html` necesitaba el rol `contador`** y verificando si ese
rol podía siquiera loguearse. `ROLES_ADMIN` en `frontend/admin/login.html`
era literalmente `['dueno', 'admin']` — cualquier usuario con rol
`vendedor`, `depositero` o `contador` que intentara loguearse en
`/admin/login` recibía "Sin acceso al panel administrativo." y se le
cerraba la sesión, **sin importar qué páginas tuviera habilitadas**
(`pos.html` para vendedor, `stock.html`/`compras.html` para depositero,
`facturacion.html`/`cheques.html`/etc. para contador). Confirmado contra
la base real: hay usuarios activos con esos 3 roles en producción que no
podían iniciar sesión. Corregido: `ROLES_ADMIN = ['dueno', 'admin',
'vendedor', 'depositero', 'contador']` (chofer y cliente quedan afuera
a propósito — tienen portales propios). `dashboard.html` (landing
post-login) también se actualizó para incluir a `vendedor`, que faltaba.

### 🟠 MEDIA — 4 acciones de `score.js` sin ningún chequeo de rol
Detectado siguiendo la dependencia real de `riesgo-cheques.js`
(`/api/score?accion=alertas`). Comparado contra `cobranza-priorizada` (que
sí tiene el chequeo correcto) se encontró que otras 4 acciones del mismo
handler no verificaban `perfil.rol` en absoluto — solo que hubiera *algún*
token válido de *algún* usuario de la empresa, incluido un cliente del
portal (rol `cliente`):
- `GET  accion=alertas` — nombre, teléfono y caída de score de **todos**
  los clientes de la empresa.
- `POST accion=resolver-alerta` — cualquiera podía marcar como resuelta
  cualquier alerta adivinando/enumerando `alerta_id`.
- `GET  accion=reglas` — exponía los umbrales internos de scoring (permite
  intentar "gamear" el propio score).
- `GET  accion=ranking` — ranking de score de todos los clientes.

Corregido: las 4 acciones ahora exigen `[dueno, admin, vendedor, contador]`,
mismo set que ya usaba `cobranza-priorizada`. `ranking`/`reglas` (la parte
de `score.js`, no la de `liquidacion.js`) no tienen ningún caller en el
frontend hoy — quedaron gateadas igual, por las dudas.

## Pendiente de deploy
Todo lo de esta etapa es código (frontend + backend), no hay migraciones
SQL nuevas más allá de las ya aplicadas directo en Supabase en sesiones
anteriores. **No tiene efecto hasta `git push`/deploy a Vercel.**
