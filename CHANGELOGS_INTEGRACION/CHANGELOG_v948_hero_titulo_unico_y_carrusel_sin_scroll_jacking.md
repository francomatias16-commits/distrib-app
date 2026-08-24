# CHANGELOG v948 — Hero simplificado: título único + carrusel sin scroll-jacking

**Fecha:** 2026-08-23
**Contexto:** pedido explícito: simplificar el hero de la landing para que
tenga un solo título (original, representativo de todo el flujo pedido →
cobro, y vendedor) y que las diapositivas de la derecha corran en carrusel,
quitando el efecto de scroll-jacking (el que hacía que scrollear la página
avanzara/retrocediera diapositivas).

## Qué se hizo

### 1) Título único (se elimina `hero-copy-correlacionado.js`)

Ese script cambiaba el `<h1>` y el párrafo grande de la izquierda del hero
según qué diapositiva estuviera activa (8 títulos distintos rotando). Se
borra por completo: sin él, el hero vuelve a mostrar el título único que ya
trae el bundle de forma nativa (`Home.tsx`, no editable en este ZIP porque
solo se cuenta con el `app.js` compilado) — **"Todo tu negocio, en
movimiento."**, con el copy "Fluxo conecta pedidos, pagos, stock, reparto y
cobranzas para que vendas más y gestiones menos.", que ya es representativo
de las 8 funcionalidades del flujo y tiene tono de venta. No hizo falta
escribir ningún reemplazo: alcanzaba con dejar de pisarlo.

### 2) Se elimina el scroll-jacking, no el carrusel

Al revisar el bundle (`app.js`) se confirmó que el componente `Home` **ya
trae su propio autoplay** para las diapositivas: un `setInterval` de 6.2s
que rota las 8 escenas, más navegación por teclado (flechas) y por swipe
táctil, con pausa automática (~2.8s) cuando el usuario interactúa a mano.
Ese mecanismo nativo estaba tapado por dos cosas que se agregaron en
sesiones anteriores para lidiar con el scroll-jacking:

- `hero-scroll-throttle-v940.js` y `hero-sequential-controller-v946.js`
  interceptaban wheel/touch/scroll para convertir cada gesto en "un paso",
  peleando por el mismo índice que el autoplay nativo y el swipe nativo.
  **Se borran los dos archivos** (y sus `<script>` en `index.html`): no
  cumplen ninguna función una vez que se resuelve la causa raíz (punto
  siguiente).
- El bundle también calcula la diapositiva a partir de cuánto mide
  `.hero-stage` de más que la pantalla (`raw = offsetHeight - innerHeight`;
  si `raw > 200`, la diapositiva pasa a depender de cuánto se scrolleó).
  `hero-transitions-v937.css` (v939/v943) inflaba `.hero-stage` a
  `calc(100vh + 4000px)` en escritorio y `+7200px` en mobile, más
  `position: sticky`, precisamente para darle recorrido a ese cálculo. Se
  reemplaza ese bloque por reglas que hacen que `.hero-stage` mida lo mismo
  que su contenido real (`.hero-sticky`, sin sticky) — con eso `raw` da ~0
  y esa rama del bundle deja de ejecutarse. La sección pasa a comportarse
  como cualquier otra de la página: se scrollea de largo, sin quedar
  "pegada" ni consumir miles de píxeles de scroll.

Con los dos scripts fuera y el alto normalizado, lo único que sigue
cambiando las diapositivas es el autoplay + navegación nativos del bundle,
que ya venían con las pausas correctas y no había que reconstruir.

### 3) Qué se deja intacto

- `hero-visuals-v2.js` (mockups reales por escena) y
  `hero-fade-transition-v941.js` (crossfade entre diapositivas): siguen
  funcionando igual, están escritos para reaccionar al remount de
  `.hero-offer` sea cual sea el disparador (antes scroll+gesto, ahora
  autoplay nativo).
- `mobile-hero-v935.css`: ya traía el layout mobile del hero en flujo
  normal (`min-height: auto`, sin sticky) — quedaba pisado por el bloque
  viejo de `hero-transitions-v937.css`, que cargaba después. Al sacar ese
  bloque, el layout mobile de v935 vuelve a aplicarse tal como estaba
  documentado en su propio archivo.

## Archivos

- Eliminados: `frontend/landing/hero-scroll-throttle-v940.js`,
  `frontend/landing/hero-sequential-controller-v946.js`,
  `frontend/landing/hero-copy-correlacionado.js`.
- Editados: `frontend/landing/index.html` (se sacan los `<script>` de los
  tres archivos eliminados, se bump la query string de
  `hero-transitions-v937.css`), `frontend/landing/hero-transitions-v937.css`
  (se reemplaza el bloque v939/v943 de scroll-jacking por el reset de
  altura descrito arriba).

## Pendiente de verificar en dispositivo/navegador real

No hay forma de renderizar la landing en este entorno para confirmar
visualmente. Falta confirmar a mano:

- Que el hero ya no “atrapa” el scroll (la rueda del mouse/trackpad pasa
  de largo hacia la siguiente sección sin saltar diapositivas).
- Que las 8 diapositivas siguen rotando solas cada ~6s.
- Que el swipe táctil en mobile sigue cambiando de diapositiva.
- Que el título de la izquierda ya no cambia al rotar las diapositivas.
