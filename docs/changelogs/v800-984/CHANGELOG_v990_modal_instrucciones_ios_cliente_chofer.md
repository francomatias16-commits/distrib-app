# v990 — Modal de instrucciones iOS también en los portales cliente y chofer

## Contexto

En v989 (`CHANGELOG_v989_fix_modal_instrucciones_ios_safari.md`) se
reemplazó, solo en `frontend/admin/js/auth.js`, el aviso de instalación en
iOS que era un párrafo de texto plano ("Tocá el botón Compartir (□↑)...")
por un modal con estilos propios inyectados e íconos SVG reales (Compartir
→ Agregar a inicio), paso a paso.

Los portales de cliente y chofer nunca tuvieron ese párrafo — directamente
no tenían ningún tratamiento para iOS: el botón "Instalar app" solo
aparecía si el navegador disparaba `beforeinstallprompt` (Android
Chrome/Edge), evento que Safari en iOS no dispara nunca. Un usuario de
iPhone entrando a `cliente/` o `chofer/` simplemente no veía forma de
instalar la PWA.

## Cambios

- `frontend/cliente/pwa-init.js`
- `frontend/chofer/pwa-init.js`

En ambos, mismo patrón que en admin:

- `esIOS()`: detecta iPhone/iPad/iPod y Mac táctil (iPadOS con
  `navigator.platform === 'MacIntel'` y `maxTouchPoints > 1`).
- Si es iOS y la PWA no está corriendo ya en `display-mode: standalone`, se
  muestra el botón "Instalar app" existente (`btn-instalar-cliente` /
  `btn-instalar-chofer`, mismo estilo y posición que ya tenían) sin esperar
  `beforeinstallprompt`.
- En iOS, el click del botón abre `mostrarInstruccionesIOS()` en vez de
  intentar `deferredPrompt.prompt()`. En Android/Chrome/Edge el
  comportamiento no cambió: sigue disparando el prompt nativo.
- Modal (`#modal-instalar-ios`) con estilos inyectados una sola vez
  (`#estilos-instalar-ios`) e íconos SVG reales para los dos pasos
  (Compartir → Agregar a inicio) — el mismo HTML/CSS que quedó en admin,
  cambiando solo la paleta: verde (`#6A9873`/`#487050`) en admin, azul
  (`#2563EB`/`#1D4ED8`) en cliente/chofer para que combine con el botón
  "Instalar app" que ya usan esos dos portales.

## Fuera de alcance

- `frontend/proveedor/pwa-init.js` no se tocó: ese portal no ofrece botón
  de instalación (acceso por link con token, sin sesión propia — ver nota
  en el propio archivo), así que no aplica.
- No se tocaron los HTML de cliente/chofer: a diferencia de
  `frontend/admin/js/auth.js`, ninguno de los `<script src="/cliente/pwa-init.js">`
  ni `<script src="/chofer/pwa-init.js">` usa query string `?v=` de cache
  busting, así que no hace falta bumpear versión en cada página.

## Verificación

- Ambos archivos pasan `node -c` (sintaxis válida).
- El único diff entre `cliente/pwa-init.js` y `chofer/pwa-init.js` es el
  esperado: ruta/scope del service worker, id del botón y el aria-label —
  igual que en la versión anterior a este cambio.
