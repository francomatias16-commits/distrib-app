# Fix: preloader sin overlay real + salto de scroll en Panel principal

## Problema
Cada vez que se cargaba `/admin/dashboard` aparecía un "despliegue negro"
que luego se cerraba de golpe, ensuciando el scroll.

## Causa raíz
`#app-preloader` nunca tuvo estilos base (`position: fixed`, overlay,
transición) en ningún CSS del proyecto. Se renderizaba como un bloque
normal dentro del flujo del documento, ocupando espacio real arriba del
layout. Al removerlo (siempre a los 5s fijos, sin importar si los datos
ya habían cargado), todo el contenido saltaba hacia arriba.

Además, el tema oscuro del panel (`body.dash-bento`) se aplicaba recién
con la última hoja de estilos en cargar, generando un flash claro→oscuro.

## Cambios

- **frontend/shared/skeletons.css**: agregado `.preloader` /
  `#app-preloader` como overlay `position: fixed; inset: 0` con
  transición de opacidad y `.oculto { opacity:0; pointer-events:none }`.
  Beneficia a las 6 páginas que comparten este preloader (dashboard,
  stock, pos, cajas, clientes, pedidos).

- **frontend/admin/dashboard.html**:
  - CSS crítico inline en `<head>` para pintar el fondo oscuro
    (`#0e0c1a`) desde el primer frame, sin depender de que cargue
    `dashboard-dark-bento.css` (última hoja de estilos en la cadena).
  - `defer` en todos los `<script src>` del final del body — se
    descargan en paralelo en vez de bloquearse uno a otro, manteniendo
    el orden de ejecución.
  - El `setTimeout(ocultarPreloader, 5000)` fijo ahora es una red de
    seguridad de 6s; ya no es el mecanismo principal de cierre.

- **frontend/admin/js/dashboard-optimizado.js**: se llama a
  `window.ocultarPreloader()` apenas terminan de pintarse KPIs,
  pedidos recientes, stock bajo y gráfico de ventas (normalmente <1s),
  en vez de esperar el timeout fijo. Alertas, notificaciones y push
  siguen cargando en segundo plano sin bloquear la vista.

## Resultado esperado
- Sin salto de layout/scroll al desaparecer el preloader.
- Sin flash de tema claro→oscuro.
- El panel se siente disponible apenas hay datos reales, no siempre
  después de 5 segundos fijos.
