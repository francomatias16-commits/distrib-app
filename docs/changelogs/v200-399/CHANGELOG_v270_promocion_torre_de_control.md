# v271 — Promoción de la Torre de Control a panel principal

Decisión de producto de la auditoría UX v2 (sección 6, "dos paneles
principales sin coordinar"): se promueve `dashboard-v2.html` ("Torre de
Control") a panel principal, reemplazando a `dashboard.html` en las rutas
`/admin` y `/admin/dashboard`.

**Se promovió tal cual, sin portar antes las funciones que le faltan** (a
pedido: "promoverla ya y agregar lo que falta después, en varias tandas").
Esto significa que el panel principal, desde ahora, NO tiene todavía:

- Resumen de arranque (3 preguntas del día: "Qué tengo para vender" / "Qué
  hay que repartir hoy" / "Algo prendido fuego") — el punto que la
  auditoría UX marcó como el más fuerte del panel anterior.
- Checklist de onboarding
- Anomalías
- Alertas de score de cliente
- Gráfico de ventas
- Alertas de migración pendiente / cheques vencidos
- Tareas sugeridas por el piloto

Ninguna de estas funciones se perdió — siguen andando en el panel viejo,
que no se borró (ver más abajo). Se van a portar a la Torre de Control en
próximas tandas.

## Cambios

### 1. `vercel.json`
- `/admin` y `/admin/dashboard` ahora sirven `frontend/admin/dashboard-v2.html`
  (antes servían `dashboard.html`).
- Nueva ruta `/admin/dashboard-legacy` → `frontend/admin/dashboard.html`,
  para no perder acceso al panel anterior mientras se portan sus funciones.
- `/admin/dashboard-v2` se mantiene como alias (mismo destino), por si
  quedó algún bookmark.

No se renombró ni movió ningún archivo — sólo cambió a qué archivo apunta
cada ruta. Se verificó que ningún HTML/JS del proyecto haga referencia
literal a `dashboard-v2.html` como archivo (sólo `vercel.json` la usaba
como ruta), así que el swap no rompe nada.

### 2. `frontend/admin/sw-admin.js` (service worker PWA admin)
- Bump de versión (`admin-v146` → `admin-v147`) para forzar la
  actualización del cache en los dispositivos que ya tenían la PWA
  instalada — si no, seguirían viendo el panel viejo cacheado.
- Se agregó `/admin/dashboard-legacy` y los CSS de la Torre de Control
  (`base-layout.css`, `dashboard-control-tower.css`) al precache. Se
  mantiene `dashboard.css` para que el panel legacy siga funcionando
  offline.

### 3. Comentarios de estado en los 3 archivos de la decisión
- `dashboard-v2.html`: comentario marcándolo como panel principal desde
  v270, con el checklist de lo que falta portar.
- `dashboard.html`: comentario marcándolo como legacy, disponible en
  `/admin/dashboard-legacy`, con el mismo checklist (para saber qué mirar
  a la hora de portar cada función).
- `setup.html`: comentario documentando que está huérfano (nada lo
  enlaza — el onboarding real usa `setup-wizard.html`) y que se conserva
  sin borrar a pedido, no porque haga falta.

## Lo que NO cambió

- `nav-data.js`, `login.html` y `manifest.json` ya apuntaban a la ruta
  `/admin/dashboard` (no al archivo), así que no necesitaron tocarse — el
  cambio de panel es transparente para ellos.
- No se tocó `dashboard-optimizado.js` ni `dashboard-control-tower.js`.

## Verificación

- `vercel.json` sigue siendo JSON válido.
- `node --check` OK en `sw-admin.js`.

## Siguiente paso sugerido

Portar a la Torre de Control, en el orden que la auditoría UX señaló como
más importante primero: el resumen de arranque (3 preguntas del día) —
es lo que más se va a notar que "falta" para quien ya usaba el panel
anterior todos los días.
