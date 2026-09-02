# v540 — Login admin: nunca más auto-inicio de sesión

## Bug reportado
Después de loguearse una vez, las siguientes veces que se abría
`/admin/login` entraba directo al dashboard sin pedir email/contraseña.

## Causa
La sesión de Supabase se persiste en `localStorage` entre reinicios del
navegador (comportamiento por defecto del SDK). El `DOMContentLoaded` de
`login.html` chequeaba `sb.auth.getSession()` y, si encontraba una sesión
viva, redirigía directo a `/admin/dashboard` (o al setup-wizard) sin pasar
por el formulario.

## Fix
Se eliminó el redirect automático. Ahora, si al entrar a `/admin/login` hay
una sesión viva, se cierra en el acto (`sb.auth.signOut()`) y se muestra el
formulario normalmente — el login siempre pide credenciales.

No se tocó el resto del flujo de sesión de la app (auth.js en las demás
pantallas del panel sigue funcionando igual; esto solo afecta la pantalla
de login en sí).

## Alcance
Aplicado únicamente a `frontend/admin/login.html`. Los logins de
`/cliente` y `/chofer` no se tocaron — avisar si necesitan el mismo fix.

## Archivos modificados
- `frontend/admin/login.html`
