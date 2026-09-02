# v949 — Metadata para compartir (og:image, twitter:card)

## Problema
`frontend/landing/index.html` no tenía `og:image` ni `twitter:card`. Al compartir el
link de la landing (WhatsApp, redes), no aparecía ninguna imagen de preview.

## Fix
Se agregaron `og:image`, `twitter:card`, `twitter:title`, `twitter:description` y
`twitter:image`, reusando el logo existente (`img/logo-fluxo.png`, 226×194px) como
imagen provisoria.

## Pendiente — necesita decisión/dato del usuario
- El logo actual (226×194px) no es el tamaño ideal para preview social (lo recomendado
  es ~1200×630px). Funciona como placeholder pero una imagen dedicada se vería mejor.
- `og:image` debería ser una URL absoluta según el spec de Open Graph (algunos clientes
  la resuelven igual como relativa, pero no todos). No agregué el dominio de producción
  real porque no está confirmado en el zip (el fallback que aparece en el código,
  `distrib.vercel.app`, es solo un default de desarrollo). Falta también un tag
  `canonical` por el mismo motivo — necesito el dominio real de producción para
  cerrar esto bien.

## Archivo modificado
- `frontend/landing/index.html`
