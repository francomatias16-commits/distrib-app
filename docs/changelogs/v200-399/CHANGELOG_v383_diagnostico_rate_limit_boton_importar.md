# v383 — Diagnóstico "Demasiadas solicitudes" + botón Importar en Productos

## 1) Diagnóstico del error del modal ("Se detuvo por un error")

**Mensaje**: `Demasiadas solicitudes. Intentá de nuevo en unos segundos.`

**Origen**: `lib/rate-limit.js` → `/api/auto-imagenes` tiene un limiter de
`max: 20` requests por `windowMs: 60_000` (60s), por IP + endpoint
(`lib/handlers/auto-imagenes.js:33`). No es un bug de la función en sí — es
el 429 del rate limiter, mostrado ahora en el modal de resultado gracias al
manejo de errores agregado en v382 (antes de v382 ese 429 se hubiera
tragado silenciosamente o roto el `confirm()`/`toast()` viejo).

**Por qué se disparó**: cada corrida completa contra 22 productos hace
`ceil(22/8) = 3` llamadas al endpoint (lote de 8). El límite de 20/min se
alcanza si se repite el ciclo *buscar → deshacer → volver a buscar* varias
veces dentro del mismo minuto (esperable durante las pruebas de esta
sesión). No hace falta tocar el límite: es intencional y bajo a propósito
porque cada llamada dispara trabajo pesado (HTTP externo a Open Food
Facts/Pexels + descarga + resize + upload a Storage) — ver comentario en
`auto-imagenes.js:31-32`.

**Nada que corregir en el código** — es el comportamiento esperado del
rate limiter frente a pruebas repetidas en poco tiempo. Si en producción
un cliente real con catálogos grandes empieza a toparse con esto en uso
normal (no solo pruebas), ahí sí conviene subir el `max` o hacerlo
proporcional al tamaño del lote — avisame si pasa y lo ajusto.

## 2) Botón "Importar" en Productos

**Gap real**: el wizard de migración masiva (`/admin/migracion.html`,
`frontend/admin/js/migracion.js`) ya soporta la entidad `productos`
(`entidad: 'productos'`, `url_admin: '/admin/productos'`) y `Dashboard` ya
tiene un link `Importar datos → /admin/migracion`, pero **Productos no
tenía ningún punto de entrada al wizard** — a diferencia de Clientes y
Proveedores, que sí muestran el badge de origen de migración en la ficha
(aunque tampoco tienen el botón de topbar).

**Cambio — `frontend/admin/productos.html`**: se agregó un botón
**Importar** al lado de **Exportar CSV** en el topbar, que linkea a
`/admin/migracion` (mismo destino que usa Dashboard). Usa la clase
`.btn-importar` (ya definida en `reskin-patch.css` junto a `.btn-exportar`,
mismo estilo base, pero sin ningún uso real en el admin hasta ahora)
combinada con `.btn-exportar` para heredar también el tema visual scoped
de `productos-gentelella.css` (que solo pega sobre `.btn-exportar`).

## No incluido en esta entrega
- Badge "Importado por migración" en la ficha de producto (como el que ya
  tienen Clientes/Proveedores vía `migracion-badge.js`). Se puede agregar
  igual que en esas páginas si lo querés — no lo sumé porque no lo
  pediste explícitamente y cambia la ficha de edición, no solo el topbar.
- Preselección automática de "Productos" al entrar al wizard desde este
  botón: `migracion.js` no soporta hoy leer la entidad desde query param,
  así que el wizard abre en su paso inicial normal (el usuario elige
  "Productos" en la lista, como ya hace cualquiera que entra desde
  Dashboard).

## Deploy
```
vercel --prod
```
