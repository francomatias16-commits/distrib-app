# v909 — Fix: banner de demostración tapaba toda la pantalla en Suscripciones SaaS

## Contexto

Reporte: "Suscripciones SaaS" (`/admin/saas-billing`) figuraba en el menú de
la demo pública pero al abrirla no se veía nada — pantalla completa en
verde sólido, solo el banner "Estás viendo una demostración en vivo...".

## Diagnóstico

No era un problema de datos ni de permisos: los RPC que arma la vista
tenant (`is_saas_owner`, `saas_mi_suscripcion`, `saas_mis_facturas`,
`saas_mi_plan_tier`) respondían 200 (verificado en logs de Supabase) y
los GRANT de `authenticated` sobre esas funciones están bien.

El problema era de layout, y es el mismo bug ya documentado y resuelto
en v456 (ver comentario en `auth.js`, banner de `perfil.solo_lectura`):
`auth.js` inserta el banner dentro de `.layout` (flex-direction:column
en `nav.css`), y solo si no encuentra ese elemento cae al fallback de
insertarlo directo en `document.body` — que es `display:flex` **sin**
`flex-direction` (fila). Sin alto propio y con `align-items:stretch`
default, el banner se estira al 100% de la altura de la pantalla y tapa
todo (con `z-index:10000`).

`saas-billing.html` era la única pantalla del admin (de 44) que no
seguía el patrón `<div class="layout">...</div>` — usaba un
`<div class="container">` directo — así que siempre caía en ese
fallback buggy para cualquier usuario con `solo_lectura = true`
(hoy: la cuenta demo pública, ver migración 456).

## Cambio

- `frontend/admin/saas-billing.html` — se envuelve todo el contenido
  (después de `#nav-root`) en `<div class="layout">...</div>`, igual
  que el resto de las pantallas del admin. No se tocó ningún ID, clase
  interna ni lógica de `init()` — es solo el wrapper estructural que le
  faltaba.

## No afectado

- `auth.js` — no se tocó; el fallback a `document.body` sigue existiendo
  como red de seguridad para páginas que legítimamente no tengan
  `.layout` (login, setup, sin-permiso, etc., que no muestran este
  banner de todos modos por no tener usuarios `solo_lectura` navegando
  ahí).
- El punto de "Suscripciones SaaS" no apareciendo para el dueño real en
  producción es un tema aparte (filtro por `rol: 'dueno'` en
  `nav-data.js`, no relacionado a este bug) — pendiente de confirmar con
  qué rol se probó en producción.
