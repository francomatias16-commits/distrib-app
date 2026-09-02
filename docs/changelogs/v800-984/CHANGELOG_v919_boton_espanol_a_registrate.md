# v919 — Header landing: botón "Español" reemplazado por "Regístrate"

## Qué se hizo

En el header de la landing (`frontend/landing/app.js`) había un botón
"Español" (ícono de globo + selector de idioma) que no tenía ninguna
funcionalidad real detrás — el sitio no tiene i18n, todo el contenido
está hardcodeado en español. Se reemplazó por un link "Regístrate" que
apunta a `/registro` (la página real de registro del sitio, ya existente
en `frontend/registro.html` y ruteada en `vercel.json`).

## Detalle técnico

Se editó directamente el bundle `app.js` (el `<button className="language">`
con el ícono `zO` y el texto " Español") y se reemplazó por un
`<a className="login-link" href="/registro">Regístrate</a>`, reusando la
clase `login-link` que ya existe en el CSS (mismo estilo visual sutil que
"Inicio de sesión", nada nuevo que definir). No se tocó `styles.css`.

Antes:
```
<button className="language"><GlobeIcon /> Español</button>
```
Después:
```
<a className="login-link" href="/registro">Regístrate</a>
```

## Verificación

`node --check app.js` pasó sin errores de sintaxis. Se confirmó que no
queda ninguna otra referencia a "Español" ni a la clase `language` en el
bundle.

## Pendiente

Igual que en v917: sigue sin resolverse la falta de CTA hacia
`/admin/login` (ingresar al sistema) en el header — el nuevo link de
"Regístrate" cubre el registro, pero no el login. Es una decisión de
producto, no la toqué.
