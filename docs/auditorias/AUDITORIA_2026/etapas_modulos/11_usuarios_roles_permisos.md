# Etapa 11 — Usuarios, roles y permisos

Alcance: `lib/handlers/usuarios.js`, `lib/auth-helpers.js` (helper
`verificarToken`, compartido por ~16 handlers del panel admin),
`frontend/admin/usuarios.html`, `frontend/admin/js/usuarios.js`,
`frontend/admin/js/nav-data.js` (gating del menú), `supabase/migrations/
012_fase1_roles_rls.sql` (RLS de referencia — no aplica en la práctica,
ver nota). Se excluye el PIN de supervisor / umbral de descuento por
usuario (`usuarios.supervisor_umbral_descuento_pct`) — eso se gestiona
desde el panel de configuración de POS, no desde esta pantalla; queda
para la etapa 7 (POS), todavía pendiente.

## Nota sobre RLS vs. capa de aplicación
`lib/repos/_db.js` usa `SUPABASE_SERVICE_ROLE_KEY` para **todos** los
handlers del backend — es decir, las policies de `012_fase1_roles_rls.sql`
(incluida `usuarios_update`) nunca se evalúan en estos endpoints; son
documentación de intención, no protección real. Toda la autorización de
este módulo depende exclusivamente de los chequeos escritos a mano en
`lib/handlers/usuarios.js` y en el helper `verificarToken`. Esto explica
por qué los tres hallazgos de esta etapa son del mismo tipo: reglas que
estaban bien pensadas pero solo aplicadas parcialmente en el código.

## Resumen de hallazgos

| Hallazgo | Severidad | Estado |
|---|---|---|
| 1. `verificarToken` (usado por ~16 handlers) no filtraba por `activo` — un usuario desactivado podía seguir operando toda la API mientras su JWT no expirara, si el ban en Supabase Auth fallaba en silencio | 🔴 Alta | ✅ Corregido en código |
| 2. El `DELETE` de `/api/usuarios` no repetía el chequeo "solo el dueño toca a un dueño/admin" que sí tenía el `PATCH` | 🔴 Alta | ✅ Corregido en código |
| 3. Un `admin` podía editar o desactivar a **otro admin** (par), algo que el propio comentario de reglas de negocio del archivo dice que no debería poder hacer | 🟡 Media | ✅ Corregido en código |
| 4. El `<select>` de rol en el modal no tenía la opción "Dueño" — editar a un usuario dueño (incluso su propio nombre/teléfono) fallaba con "Rol inválido" | 🟡 Media | ✅ Corregido en código |

Ningún hallazgo requirió migración SQL — todo el fix es de código
(`lib/auth-helpers.js`, `lib/handlers/usuarios.js`,
`frontend/admin/usuarios.html`, `frontend/admin/js/usuarios.js`).
**Todo queda pendiente de `git push`/deploy a Vercel**, igual que las
etapas anteriores.

## Hallazgo 1 — `verificarToken` no chequeaba `activo` (🔴 Alta)

`lib/auth-helpers.js` expone `verificarToken(req, sb)`, usado por
`usuarios.js` y otros ~15 handlers del panel admin (pedidos, stock,
clientes, migración, score, etc.) para resolver el perfil a partir del
JWT de Supabase. La query buscaba el perfil por `id` sin filtrar
`activo`.

Esto ya se había detectado y corregido para la carga de perfil del
**frontend** (`auth.js`, Etapa 2 de la auditoría de seguridad — ver el
comentario ahí: *"ni las policies de RLS ni get_empresa_id()/
get_rol_usuario() filtraban por este campo — un usuario desactivado
seguía operando el panel completo hasta que expiraba su JWT"*), pero el
mismo fix nunca se replicó en este helper del **backend**, que es el que
de verdad autoriza cada escritura.

En condiciones normales el `ban_duration` que `usuarios.js` aplica en
Supabase Auth al desactivar corta el acceso igual (el propio
`sb.auth.getUser(token)` rechaza a un usuario baneado). El problema es
que esa llamada de ban está envuelta en `.catch(() => {})` — si falla
(red, rate limit de Supabase Auth, etc.), la fila queda `activo=false`
en la tabla pero el usuario sigue baneado=false en Auth, y desde ese
momento el desactivado conserva acceso completo a todos los endpoints
que dependen de `verificarToken` mientras no expire su JWT (por defecto,
hasta 1 hora en Supabase).

**Fix aplicado:** se agregó `.eq('activo', true)` a la query de
`verificarToken`, igual que ya hace `auth.js` del lado del cliente. Ahora
la protección no depende de que el ban en Auth haya funcionado.

## Hallazgo 2 — `DELETE` sin el chequeo que sí tiene `PATCH` (🔴 Alta)

El `PATCH` bloquea (línea ~142, antes del fix) que alguien que no sea
`dueno` edite a un usuario `dueno`. El `DELETE` (alias de "desactivar")
no repetía ese chequeo: solo validaba que no fueras vos mismo y que no
quedara la empresa sin dueño activo, pero **no** validaba el rol de
quien hacía el pedido. Un `admin` con su propio token válido podía
desactivar directamente a un `dueno` (o a otro `admin`) llamando
`DELETE /api/usuarios?id=<uuid>`, siempre que quedara al menos otro
dueño activo — sin pasar nunca por la restricción que sí se aplicaba si
lo intentaba vía `PATCH { activo: false }`.

La interfaz nunca expone esta ruta para esos casos (el botón
"Desactivar" llama a `PATCH`, no a `DELETE`), pero el endpoint queda
igual de alcanzable con el token real de un admin (curl, devtools, un
script) — es una falla de autorización de API real, no solo de UI.

**Fix aplicado:** se agregó al `DELETE` el mismo chequeo
`ROLES_PRIVILEGIADOS.includes(objetivo.rol) && perfil.rol !== 'dueno'`
→ 403, antes de tocar la fila.

## Hallazgo 3 — Un admin podía tocar a otro admin (🟡 Media)

El comentario de reglas de negocio al principio de `usuarios.js` dice:
*"Solo 'dueno' puede crear/editar a otro 'dueno' o 'admin' (un admin no
puede fabricarse pares ni tocar al dueño)"* — pero el código solo
chequeaba `objetivo.rol === 'dueno'`, no `'admin'`. En la práctica, un
`admin` sí podía editar el nombre/teléfono de otro `admin`, y sobre todo
**desactivarlo** (`activo:false`) o degradarlo a un rol menor, sin que
el dueño interviniera — el único límite real era no poder asignarle el
rol `admin`/`dueno` a alguien (eso sí estaba bien bloqueado).

**Fix aplicado:** el chequeo ahora usa
`ROLES_PRIVILEGIADOS.includes(objetivo.rol)` (dueno **o** admin) en vez
de comparar solo contra `'dueno'`, tanto en `PATCH` como en `DELETE`, con
una excepción explícita para que cada quien pueda seguir editando su
propio perfil (`objetivo.id !== perfil.id`).

## Hallazgo 4 — Falta la opción "Dueño" en el `<select>` de rol (🟡 Media)

`frontend/admin/usuarios.html` solo listaba `vendedor, depositero,
chofer, contador, admin` en el `<select id="f-rol">` — nunca `dueno`,
porque la pantalla no está pensada para *crear* dueños. El problema es
que `abrirModalEditar()` reutiliza el mismo `<select>` para mostrar el
rol de **cualquier** fila, incluida una con rol `dueno`: al hacer
`f-rol.value = 'dueno'` sin que exista esa opción, el navegador deja el
select sin ninguna opción seleccionada (`value` pasa a ser `""`).

Consecuencia real: al editar a un usuario dueño — incluido el propio
dueño editando su propio nombre o teléfono desde esta pantalla — el
`PATCH` se mandaba con `rol: ""`, que el backend rechaza con `400 Rol
inválido`, bloqueando el guardado completo (no solo el cambio de rol).

**Fix aplicado:**
- Se agregó `<option value="dueno" id="opt-rol-dueno">Dueño</option>` al
  `<select>`, oculta por defecto.
- `abrirModalNuevo()` la mantiene oculta (no se crean dueños desde acá).
- `abrirModalEditar()` la muestra solo si el usuario editado es `dueno`,
  y además deshabilita todo el `<select>` si quien edita no es un
  `dueno` (no puede cambiarle el rol de todas formas, ver Hallazgo 3).
- De paso, en la tabla: las filas de `dueno`/`admin` ajenas ya no
  muestran botones de Editar/Desactivar cuando quien mira no es `dueno`
  — antes los mostraba igual y el backend recién rechazaba al guardar.
  Ahora dice directamente "Solo el dueño".

## Lo que ya estaba bien
- El resto de las reglas de negocio del módulo (no poder desactivarse a
  uno mismo, no dejar a la empresa sin ningún dueño activo, el rol
  `cliente` fuera de alcance de esta pantalla, el límite de plan
  excluyendo clientes) ya estaban implementadas y correctas — no se
  tocó nada de eso.
- El rollback de `POST` (si falla el insert en `usuarios`, se borra el
  usuario recién creado en Supabase Auth para no dejar huérfanos) es
  correcto.
- El baneo/desbaneo en Supabase Auth al activar/desactivar sigue siendo
  la primera línea de defensa — el Hallazgo 1 es específicamente sobre
  el caso en que esa llamada falla, no un reemplazo de ella.

## Pendiente / fuera de alcance de esta etapa
- No se agregó un mecanismo de reintento o alerta si
  `db.auth.admin.updateUserById(..., ban_duration)` falla al desactivar
  a alguien — hoy sigue fallando en silencio (`.catch(() => {})`). Con
  el fix del Hallazgo 1, ya no es una falla de seguridad (el `activo`
  de la tabla sigue cortando el acceso), pero sí podría dejar a alguien
  "desactivado en la tabla, pero no baneado en Auth" sin que nadie se
  entere. Si se quiere ser más estricto, convendría loguear ese error o
  reintentarlo, no solo tragarlo.
- El PIN de supervisor y el umbral de descuento por usuario (mencionados
  en `docs/ayuda/usuarios-y-roles.md`) no se auditaron acá — viven en el
  módulo de POS (etapa 7, pendiente).
