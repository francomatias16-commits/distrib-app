# v920 — Fix de los 4 hallazgos de la auditoría de la landing

Todo dentro de `frontend/landing/app.js` (y sin tocar `styles.css` salvo
lo ya hecho en v918).

## 1. Carrusel del hero saltaba de golpe al último módulo al scrollear

**Causa:** v918 dejó `.hero-stage{min-height:auto!important}` para eliminar
la franja blanca. Pero el carrusel de módulos (`hero-rail`) seguía
calculando su progreso como `(scrollY - offsetTop) / (offsetHeight -
innerHeight)`. Al no quedar espacio real reservado, ese denominador
colapsaba casi a 0 y el progreso saltaba a 0.999 con el primer pixel de
scroll.

**Fix:** la interpolación por scroll ahora solo se aplica si queda un
rango real (`> 200px`) de espacio de scroll-jack. Si no lo hay (caso
actual), el riel de módulos sigue funcionando por autoplay (620ms) y
por click manual, sin el salto brusco.

## 2. "Precios" en el menú apuntaba al FAQ

No existe ninguna sección de precios/planes en el sitio; el `id="precios"`
siempre fue el FAQ (`"PREGUNTAS FRECUENTES"`). En vez de inventar una
sección de precios sin datos reales del negocio, se renombró el botón de
navegación (desktop + mobile) de **"Precios"** a **"Preguntas"**, para
que el texto del nav coincida con el destino real. El ancla `#precios`
no se tocó (para no romper enlaces existentes).

**Pendiente de decisión de producto:** si en algún momento quieren una
sección de precios real, hay que diseñarla y agregar el nav item de
nuevo — esto no la crea, solo deja de prometer algo que no está.

## 3. Grid de "Producto" mostraba 6 módulos, no los 8 prometidos

Se agregaron al array `WN` (el que alimenta el grid visible de la
sección Producto) los 2 módulos que ya existían en el carrusel del hero
(`Lo`) pero no en el grid:
- "Importación y migración"
- "Automatización del cobro"

Ahora `WN` tiene 8 items, igual que `Lo`, coincidiendo con el "Ocho
módulos" del hero.

## 4. Email de contacto con dominio de marca vieja

`hola@distrib.app` → `hola@fluxo.app` en las 3 apariciones (footer y
sección de FAQ/contacto), para que coincida con la marca "Fluxo" que se
usa en todo el resto del sitio.

## Verificación

`node --check app.js` pasó sin errores en cada paso. No se tocó
`styles.css` en esta iteración.

## 5. Footer: link duplicado y links legales rotos

- La columna "Compañía" tenía **"Contacto"** y **"Ayuda"** apuntando los
  dos a `#contacto` — se eliminó "Ayuda" por ser un duplicado sin
  contenido propio.
- La columna "Legal" (**Privacidad**, **Términos de servicio**,
  **Seguridad**) apuntaba también a `#contacto`, que en realidad es el
  banner final de CTA ("EL PRÓXIMO PASO ES OPERATIVO"), no una página
  legal. No existen páginas de Privacidad/Términos/Seguridad en el
  proyecto. Como no hay contenido legal real para publicar, se
  redirigieron esos 3 links a `mailto:hola@fluxo.app` en vez de dejarlos
  apuntando a un banner que no tiene nada que ver.

**Pendiente de decisión de producto:** esto es un parche honesto, no la
solución final — en algún momento van a necesitar páginas de
Privacidad/Términos/Seguridad reales (por temas de compliance, sobre
todo si van a facturar y guardar datos de clientes).

## 6. `manifest.json` de la landing describía otra cosa

`frontend/manifest.json` (enlazado desde `index.html` de la landing)
tenía:
- `name`/`short_name`: "Fluxo Admin" (no la landing pública)
- `start_url`: `/demo` (si alguien instalaba la landing como PWA, abría
  la demo, no la landing)
- `theme_color`: verde `#3f8a4f` y `background_color` casi negro
  `#0a1119` — no tienen relación con el sitio blanco/azul (`#0540AD`,
  el mismo azul que ya declara el `<meta name="theme-color">` del propio
  `index.html`) desde el que se enlaza.

Se corrigió para que describa la landing real: `name`/`description`
tomados del `<title>`/`og:description` del propio `index.html`,
`start_url:"/"`, `theme_color:"#0540AD"`, `background_color:"#ffffff"`.
Los íconos (`icon-192.png`/`icon-512.png`) sí existían y se dejaron
igual.

## 7. Selectores CSS repetidos — identificados, no corregidos

Se detectaron ~100 selectores hand-authored (`.product-grid`,
`.product-card`, `.hero-section`, `.site-header`, etc.) definidos en
múltiples bloques distintos a lo largo de `styles.css`, reflejo de que
cada iteración anterior agregó reglas al final del archivo en vez de
editar el bloque existente. La cascada CSS hace que gane la última
definición, así que hoy no rompe nada visible, pero son ~143KB con
bastante redundancia.

**No se tocó en esta pasada:** consolidar ~100 selectores a mano sin
poder renderizar en un browser acá es alto riesgo de alterar el orden
de cascada por una limpieza cosmética. Si se quiere encarar, conviene
hacerlo aparte con capturas de verificación antes/después.

## Verificación adicional

`node --check app.js` y validación de `manifest.json` como JSON,
ambos OK después de estos 3 cambios.
