# v287 — Fix layout roto en "Conectar WhatsApp" (Etapa 7)

## Problema
La página `frontend/admin/whatsapp-onboarding.html` (creada en la Etapa 7) no
incluía dos hojas de estilo que sí están presentes en el resto de las páginas
de admin:

- `/frontend/admin/css/nav.css` (define `--nav-rail-w`, `--nav-panel-w` y
  todos los estilos de `.nav-rail` / `.nav-panel`)
- `/shared/reskin-patch.css`

`nav.js` sí armaba correctamente el HTML del sidebar (riel + panel expandido),
pero sin `nav.css` esas reglas no existían, así que el panel se renderizaba
sin ancho/posición/flex y se desparramaba como una lista de links sin estilo
por fuera del contenedor `.layout`.

## Fix
Se agregaron los dos `<link>` faltantes al `<head>` de
`whatsapp-onboarding.html`, en el mismo orden que usan el resto de las
páginas (después de `base-layout.css`, con `reskin-patch.css` al final):

```html
<link rel="stylesheet" href="/frontend/admin/css/nav.css?v=223" />
<link rel="stylesheet" href="/shared/reskin-patch.css?v=197" />
```

## Pendiente (no es un bug de código)
El error "Parámetro no válido: se requiere 'config_id'" al tocar "Conectar mi
WhatsApp" ocurre en el diálogo OAuth de Facebook, no en nuestro JS (el
`FB.login()` en `whatsapp-onboarding.js` ya manda `config_id` correctamente).
Falta revisar en Meta for Developers:

1. Que la app tenga agregado el producto **Facebook Login for Business**.
2. Que la configuración `28288615890741251` sea del tipo "WhatsApp Embedded
   Signup" y pertenezca a la app `2765961223784707`.
3. Que `distrib-app-nine.vercel.app` esté en Allowed Domains / Valid OAuth
   Redirect URIs de esa configuración.
