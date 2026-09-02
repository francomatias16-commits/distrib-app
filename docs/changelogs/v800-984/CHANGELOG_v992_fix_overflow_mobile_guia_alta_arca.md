# v992 — Fix overflow de texto en mobile: guía de alta ARCA (facturacion-config.html)

## Contexto

En `frontend/admin/facturacion-config.html`, la tarjeta "Alta del
certificado ARCA (Argentina)" muestra 7 pasos numerados (`.paso`), cada
uno con un círculo de número (`.paso-n`) y el texto (`.paso-t`), varios
con comandos/valores en `<code>` (el comando `openssl`, el subject del
CSR, `.crt`, `wsfe`, etc.). En mobile, el texto largo dentro de esos
`<code>` se salía del borde derecho de la tarjeta en vez de hacer wrap.

## Causa

`.paso` es `display:flex`. `.paso-t` es un ítem flex sin `min-width:0`
explícito — por default un flex item no se achica por debajo del ancho
intrínseco de su contenido (`min-width:auto`). Como el `<code>` con el
comando `openssl req -new -newkey rsa:2048 -keyout privada.key -out
solicitud.csr -subj "/C=AR/O=NOMBRE_EMPRESA/serialNumber=..."` tampoco
tenía ninguna regla de wrap propia, ese ancho intrínseco terminaba
empujando a `.paso-t`, y con él a toda la tarjeta, más allá del viewport
en pantallas chicas.

## Fix

`frontend/admin/facturacion-config.html`:

- `.paso-t`: agregado `min-width:0` (deja que el flex item se achique al
  ancho disponible) y `overflow-wrap:anywhere` (corta el texto largo sin
  espacios si hace falta, en vez de desbordar).
- `.paso-t code`: agregado `overflow-wrap:anywhere`, `white-space:normal`
  (por si algún reset global lo dejaba en `pre`/`nowrap`) y
  `display:inline` explícito.

No se tocó el layout de escritorio (`.cfg-grid-2col`, `min-width:1024px`)
ni el contenido de los 7 pasos — es un fix puramente de CSS de wrap.

## Verificación

- Revisé que no hay ninguna regla global `code { white-space: ... }` en
  `base-layout.css`/`tokens.css`/`skeletons.css`/`adminlte-components.css`
  que compita con este fix.
- No verificable en este entorno: render real en un viewport angosto
  (375–390px) para confirmar visualmente que el comando `openssl` del
  paso 1 ahora hace wrap dentro de la tarjeta.
