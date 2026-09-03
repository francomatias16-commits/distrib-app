# v1058 — Auditoría "resto de admin" (clientes/proveedores/fidelización/stock): hallazgo real en acceso portal cliente

## Alcance de esta pasada

Fuera de lo que cubrió la etapa 6 (que quedó cerrada por completo, ver
`CHANGELOG_v775...md` y `CHANGELOG_v776...md`), se revisaron las páginas
admin que quedaron explícitamente afuera del plan: `clientes.js`,
`proveedores.js` + `cc_proveedores.js`, `fidelizacion.js`, `stock.js` +
`stock-auto.js`.

**Sin hallazgos en:** `proveedores.js`/`cc_proveedores.js` (permisos y
`empresa_id` consistentes en todo el CRUD de proveedores/compras/recepciones;
la validación de archivo por contenido de BUG-04 ya está aplicada al path de
Storage), `fidelizacion.js` (scoping correcto por `empresa_id`/`cliente_id`
derivados de la sesión), `stock.js`/`stock-auto.js` (mismo patrón
`CRON_SECRET` ya auditado en notif.js, permisos vía `puede()` consistentes).

## Hallazgo — colisión cross-tenant en el email ficticio del portal cliente (`lib/handlers/clientes.js`)

`crearAccesoPortal()` deriva el email de auth **solo del teléfono**
(`${telNorm}@portal.distrib`), sin ningún namespacing por empresa. El
proyecto usa una única base de Supabase para todas las empresas del SaaS
— es decir, `auth.users` es un espacio compartido entre tenants.

**Impacto:** si el mismo número de teléfono es cliente de dos empresas
distintas en la plataforma (escenario plausible: un comercio que le compra
a más de un distribuidor que usa este mismo SaaS), otorgar acceso portal
para la segunda empresa:

1. Encuentra el mismo `auth.users` ya creado para la primera empresa
   (`listUsers()` + match por email ficticio).
2. Le resetea la contraseña (y la manda por WhatsApp al mismo teléfono).
3. Repisa sin aviso la fila de `usuarios` (`empresa_id`, `cliente_id`) para
   que apunte a la segunda empresa.

Resultado: el cliente de la primera empresa pierde su acceso portal en
silencio — el mismo login (mismo teléfono) ahora resuelve a los datos de
otra empresa. No hay ningún error ni log visible para el admin de la
primera empresa; se entera solo si el cliente le avisa que "no puede
entrar más" o si ve datos que no son los suyos.

`chofer_invitacion.js` ya tenía un comentario reconociendo este *tipo* de
riesgo (colisión con el espacio de emails de clientes) y lo resolvió con un
dominio ficticio propio (`@chofer.distrib`) — pero eso solo separa
choferes de clientes, no resuelve la colisión cliente-vs-cliente entre dos
empresas distintas, que es el caso real encontrado acá. Ese mismo archivo,
para el caso de email ya registrado, corta con un 409 explícito en vez de
reusar/repisar la cuenta — ese es el patrón que se aplica ahora también acá.

## Fix

En `crearAccesoPortal()`: antes de reutilizar un `auth.users` existente,
se consulta a qué empresa pertenece hoy (via su fila en `usuarios`). Si
pertenece a una empresa distinta a la que está pidiendo el acceso, se
corta con un error explícito en vez de repisar en silencio:

> "Este número de teléfono ya tiene acceso al portal de otra empresa en
> la plataforma. No se puede otorgar acceso acá sin antes resolver ese
> conflicto (contactá soporte)."

Si es la misma empresa (regenerar acceso) o el auth user no tiene fila en
`usuarios` todavía, sigue el flujo normal sin cambios.

**Nota de alcance:** este fix convierte un secuestro silencioso de cuenta
en un error visible — no resuelve el diseño de fondo (¿debería un mismo
teléfono poder tener un perfil de cliente-portal por empresa? Requeriría
repensar el esquema de login, hoy 100% global por teléfono en
`frontend/cliente/login.html` y en el reset por WhatsApp de `auth.js`).
Queda como decisión de producto para más adelante si el caso real llega a
aparecer.

## Hallazgo secundario (encontrado al escribir el test del fix de arriba) — `errorSeguro()` en el catch de `/api/clientes/acceso` ocultaba TODOS los mensajes de negocio

El catch de `POST /api/clientes/acceso` llamaba
`errorSeguro(res, err, 400, 'No se pudo completar la operación.')` con un
mensaje público fijo, ignorando `err.message` — así que ningún mensaje de
`crearAccesoPortal`/`revocarAccesoPortal` llegaba nunca al admin, ni
siquiera los que ya existían y estaban escritos explícitamente para
mostrarse: "El cliente no tiene teléfono registrado. Agregalo primero en
Ver / Editar.", "Cliente no encontrado", "Este cliente no tiene acceso
portal activo" (y ahora el nuevo mensaje de colisión de arriba). El admin
solo veía el genérico + un `correlation_id`, sin pista de qué corregir.

**Fix:** ese catch puntual ahora pasa `err.message` como mensaje público
(`errorSeguro(res, err, 400, err.message || 'No se pudo completar la
operación.')`) — los throws de estas dos funciones son mensajes de
negocio pensados para el usuario, no detalle interno de DB/schema (que es
para lo que existe `errorSeguro` en primer lugar). El resto de los catches
del archivo sigue igual, sin tocar.

## Verificación

- `node --check lib/handlers/clientes.js`: OK.
- Test de regresión nuevo,
  `tests/handlers/clientes-acceso-portal-colision.test.js` (3 tests):
  primera vez sin colisión, misma empresa (regenerar) permitido, y el caso
  de colisión cross-tenant cortando con el mensaje correcto sin repisar
  `usuarios`. Corrido con vitest: 3/3 OK.
- Suite completa (`tests/handlers/` + `tests/repos/`, 74 archivos / 947
  tests): **947/947 OK**, sin regresiones.
