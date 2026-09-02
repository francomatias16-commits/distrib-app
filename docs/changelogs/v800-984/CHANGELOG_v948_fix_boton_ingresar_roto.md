# v948 — Fix: botón "Ingresar" roto en la landing (desktop y mobile)

## Problema
En `frontend/landing/app.js`, el botón "Ingresar" del nav (desktop: `.nav-download-app`,
mobile: `.nav-download-app-mobile`) hacía `onClick:()=>ee("acerca")`, que intenta
hacer scroll a `document.getElementById("acerca")`.

Esa sección ya no existe: `pricing-section-patch.js` la reemplaza en runtime por la
sección de precios (`outerHTML`, id pasa a ser `#precios`). Resultado: el botón
"Ingresar" —el más asociado a "entrar al sistema"— no hacía absolutamente nada al
tocarlo, en toda la landing, desde que se integró el patch de precios.

## Fix
Se cambió el `onClick` de ambos botones para navegar directo a `/admin/login` en vez
de intentar un scroll a una sección eliminada.

## Archivo modificado
- `frontend/landing/app.js`

## Nota
Este patrón (patches que reescriben el DOM en runtime vía `outerHTML`/reasignación de
`id`) es fragil por diseño: cualquier otro botón que dependa de un id tocado por un
patch puede romperse igual sin que se note en un review de código estático. Ver
auditoría completa para la recomendación de consolidar esto.
