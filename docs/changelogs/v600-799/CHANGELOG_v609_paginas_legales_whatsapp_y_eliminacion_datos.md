# v609 — Páginas legales: se agrega mención a WhatsApp Business y página de eliminación de datos

## Motivo

Al armar la solicitud de revisión de permisos de Meta (`whatsapp_business_management`,
`whatsapp_business_messaging`) en `developers.facebook.com`, la pantalla de
configuración básica de la app pedía tres URLs: Política de privacidad,
Condiciones del servicio, y URL de instrucciones para eliminación de datos.

Al revisar el sitio público de Fluxo (marca pública de distrib) para
completar esos campos, se encontraron dos problemas:

1. **`frontend/privacidad.html` no mencionaba en ningún lado los datos de
   WhatsApp Business** — ni el contenido de los mensajes, ni el teléfono
   del cliente final, ni que Meta interviene como proveedor de mensajería.
   Es justo lo que un revisor de Meta chequea primero para estos permisos.
2. **No existía ninguna página de "Eliminación de datos"** — Meta la exige
   como campo obligatorio y separado de la política de privacidad, con
   instrucciones concretas de cómo un usuario puede pedir el borrado de
   sus datos.

`frontend/terminos.html` sí existía y no tuvo que crearse — solo hacía
falta usar esa URL (`/terminos.html`) en el campo de Condiciones del
servicio del panel de Meta, en vez del placeholder `facebook.com` que
había quedado cargado.

## Cambios

- **`frontend/privacidad.html`**:
  - Sección 2 ("Qué datos recolectamos"): nuevo ítem "Datos de WhatsApp
    Business" — describe qué se procesa (teléfono y nombre de perfil del
    cliente final, contenido de mensajes con el asistente, metadatos de
    entrega) cuando una empresa conecta su propio número.
  - Sección 4 ("Con quién compartimos datos"): se agrega Meta / WhatsApp
    Business Platform como proveedor de mensajería.
  - Sección 6 ("Derechos del usuario"): se enlaza la nueva página de
    Eliminación de datos.
- **`frontend/eliminacion-datos.html`** (nueva): instrucciones separadas
  por tipo de usuario (dueño de cuenta / cliente final de una empresa que
  usa Fluxo / conversaciones de WhatsApp específicamente), plazos de
  respuesta, y el mismo layout visual que `privacidad.html`/`terminos.html`
  para consistencia. Es la URL a usar en el campo "URL de instrucciones
  para la eliminación de datos" de Meta for Developers.
- **`frontend/index.html`**: se agrega el link "Eliminación de datos" al
  footer, junto a Términos y Privacidad.

## Pendiente (fuera de este repo, en Meta for Developers y en el dominio del titular)

- Cambiar la URL de Política de privacidad en la configuración de la app
  de `http://www.mfwebsolutions.com/` a `https://` (Meta exige HTTPS).
- Cargar en el campo "Condiciones del servicio" la URL real
  `https://distrib-app-nine.vercel.app/terminos.html` (o el dominio final
  que corresponda), reemplazando el placeholder `facebook.com`.
- Cargar en el campo "URL de instrucciones para la eliminación de datos"
  la URL real `https://distrib-app-nine.vercel.app/eliminacion-datos.html`,
  reemplazando el placeholder `facebook.com`.
- `frontend/privacidad.html` todavía tiene dos campos `[COMPLETAR]` sin
  llenar (domicilio legal del titular, plazo de conservación post-baja) —
  no bloquean la revisión de los permisos de WhatsApp puntualmente, pero
  conviene completarlos antes de publicar el sitio en serio.

## Archivos

- `frontend/privacidad.html`
- `frontend/eliminacion-datos.html` (nuevo)
- `frontend/index.html`

## Testing

- Parseo básico de HTML (`html.parser`) sobre los tres archivos — sin
  errores de estructura.
- Pendiente: abrir las tres URLs en el sitio deployado y confirmar que
  `/eliminacion-datos.html` sirve igual que `/terminos.html` y
  `/privacidad.html` (mismo mecanismo de Vercel, sin rewrite adicional
  necesario en `vercel.json`).
