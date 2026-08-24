# CHANGELOG v739 — Rediseño visual de /admin/soporte.html (tarjetas genéricas → color pleno por categoría)

## Motivo

Las tarjetas de "Hablar con alguien" y "Elegí un tema" se veían genéricas
(rectángulos planos, íconos chicos, todas del mismo tono, sin relación con
los colores propios de cada workspace). Se rediseñó todo `soporte.html`
tomando como base el patrón **Bento Box Grid** del catálogo del skill de
UI/UX (moderno, bajo costo de performance, pensado para dashboards/SaaS),
pero llevándolo a un tratamiento con más color y vida, apoyado en la
paleta de marca ya existente del proyecto (verde `--color-primary` y los
7 colores `--nav-*` por workspace) en vez de una paleta genérica ajena al
producto.

Primera vuelta de este cambio (persistida por error en un commit
intermedio) usaba solo un toque de color en la esquina de cada tarjeta y
repetía el texto "Ver ayuda con X" ocho veces seguidas — feedback del
dueño: muy sutil, se sentía repetitivo. Se corrigió en esta misma
versión: ahora el color cubre toda la tarjeta y el CTA de texto se
reemplazó por una flecha (sin repetir la misma frase 8 veces). **No se
usó ningún emoji en ningún momento** — todos los íconos son SVG lineales,
como en el resto del panel.

## Cambios — `frontend/admin/soporte.html`

### Tarjetas de temas (`.soporte-card`)
- Fondo con degradado tenue del color propio del workspace cubriendo toda
  la tarjeta (antes: blanco liso con un pequeño resplandor en la
  esquina) + una burbuja de color translúcida en la esquina superior que
  crece al hover — dan la sensación de "vivo" que pedía el dueño.
- Ícono en badge de 46px, ahora con **fondo sólido del color de la
  categoría e ícono en blanco** (antes: ícono del mismo color que el
  fondo, muy sutil) — mismo criterio que ya usa el menú lateral
  (`--nav-{ws}` / `--nav-{ws}-bg`), así no hay paleta nueva que mantener.
- CTA de texto "Obtener ayuda con X" / luego "Ver ayuda" **eliminado**:
  se repetía de forma idéntica en las 8 tarjetas y sumaba ruido visual
  sin aportar información (el título ya identifica el módulo y la
  tarjeta entera es clickeable). Queda solo un botón circular con flecha,
  decorativo (`aria-hidden="true"`, la tarjeta ya tiene su propio texto
  accesible vía el `<p>` del título), que se llena de color y se desliza
  al hover.
- Hover: elevación + sombra teñida del color de la categoría + ícono con
  scale y rotación sutil, todo en 200ms.
- Entrada escalonada al cargar la página (`animation-delay` por
  `nth-child`), respetando `prefers-reduced-motion`.

### Contacto humano (`.canal-card`)
- Mismo criterio de color pleno: degradado de fondo + borde superior
  grueso (2.5px) con el color del canal, ícono en badge sólido en vez de
  ícono tenue sobre fondo tenue.
- Sin texto repetido: cada canal ya tenía su propio label distinto
  ("Preguntar" / "Escribir" / "Escribir"), no se tocó esa parte.

### Hero, buscador y panel de FAQ
- Sin cambios respecto a la iteración anterior (resplandor sutil detrás
  del título, buscador tipo píldora, `backdrop-filter` en el overlay de
  FAQ).

## Fix posterior (mismo v739) — los 3 botones "Escribir/Preguntar" salían verdes

Al revisar la pantalla ya en el navegador, los tres botones de contacto
(Preguntar / Escribir / Escribir) se veían todos del mismo verde de
WhatsApp, en vez de un color distinto por canal.

**Causa:** `frontend/admin/css/soporte-gentelella.css` (el reskin de esta
pantalla, se carga después del `<style>` inline y con mayor
especificidad — `body.dash-soporte-gentelella .btn-canal` vs `.btn-canal`)
tiene una regla base que pinta **todo** `.btn-canal` del verde de
WhatsApp con `!important`, y una regla `.btn-canal.mail` pensada para
pintar el botón de mail de azul — pero el `<a class="btn-canal">` del
mail en `soporte.html` nunca tuvo la clase `.mail`, así que esa regla no
matcheaba nunca y el botón de mail quedaba con el verde de la regla base.

**Fix:** en vez de agregar la clase `.mail` al HTML (frágil, depende de
no reordenar las tarjetas), se distinguen los 3 botones por su posición
dentro de `.canal-grid` con `:nth-child`:
- 1ª tarjeta (Asistente de IA) → `--ge-teal-dark` (`#487050`, el verde
  oscuro real de la paleta del proyecto), para no confundirse con el
  verde de WhatsApp.
- 2ª tarjeta (WhatsApp) → sin cambios, sigue con `--ge-whatsapp`.
- 3ª tarjeta (Email) → pill clara (`rgba(52,152,219,.16)`) con texto
  `--ge-blue`, un tono bien más tenue que los otros dos — se lee como el
  canal "no inmediato" en vez de competir visualmente con IA/WhatsApp.

Los tres tokens usados (`--ge-teal-dark`, `--ge-whatsapp`, `--ge-blue`)
ya existían en `frontend/shared/gentelella-tokens.css`; no se agregó
ningún color nuevo.


- No se tocó ninguna lógica JS de negocio (`renderGridSoporte`,
  `abrirPanelFAQ`, búsqueda, WhatsApp, envío al asistente de IA): solo se
  simplificó el markup que arma cada tarjeta (se sacó el `<span>` de
  texto del CTA) y se ajustaron los estilos vía las mismas variables
  `--acc` / `--acc-bg` que ya se pasaban inline.
- Se sigue usando `color-mix()` (soportado en navegadores modernos,
  target de este panel admin) para mezclar el acento de cada categoría
  sin duplicar valores RGB por color.
- Todo respeta `prefers-reduced-motion` y el contraste de texto existente
  (los textos siguen en `--color-text` / `--color-text-muted` sobre fondo
  claro; el color solo se usa en íconos, bordes y sombras, no en texto
  sobre fondo de color).

