# v237 — Panel de administración del POS rediseñado

## Problema
El botón "Administrar" abría un modal chico (max-width 560px) con 7 pestañas
horizontales apretadas (Ventas, Stock, Favoritos, Devoluciones, Promociones,
Hardware, Config POS). Todo el contenido —incluyendo configuración sensible
como PIN de supervisor, umbrales de descuento y terminales de pago— quedaba
escondido y comprimido dentro de esa ventana pequeña.

## Cambio
El mismo modal ahora se despliega como un panel de administración estilo
dashboard, ocupando casi toda la pantalla:

- **Sidebar lateral fijo** con las 7 secciones (con íconos), en vez de tabs
  horizontales angostas. Se ve todo el menú de opciones de un vistazo.
- **Modal ampliado** a ~1180px de ancho x 88% del alto de la ventana (antes
  560px), con más aire y contenido más legible.
- **Encabezado con subtítulo** ("Ventas, stock, promociones y configuración
  del punto de venta") para dar contexto profesional al panel.
- **Responsive**: en pantallas angostas (celular/tablet) el sidebar se
  convierte automáticamente en tabs horizontales con scroll, igual que antes.
- Ningún cambio de lógica: los mismos ids (`tab-ventas`, `panel-admin-stock`,
  etc.) y las mismas funciones de `pos.js` (`cambiarTabAdmin`, `abrirModalAdmin`,
  etc.) siguen funcionando sin tocar una línea de JS.

## Archivos modificados
- `frontend/admin/pos.html` — reestructuración del modal (sidebar + content)
- `frontend/admin/css/pos.css` — nuevos estilos del panel + responsive
  (bump de cache `?v=198` en el `<link>` de pos.css dentro de pos.html)

## Cómo aplicar
Reemplazá estos dos archivos en tu repo por los de este paquete y deployá.
No requiere migraciones ni cambios de backend.
