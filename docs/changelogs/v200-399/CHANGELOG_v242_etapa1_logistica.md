# CHANGELOG v242 — Etapa 1 del plan por etapas: Logística

Implementa los 3 puntos de la **Etapa 1 (Logística)** de `Plan por etapas — todas las ideas.txt`.

## 0. Diagnóstico primero (por qué el alcance quedó así)

Antes de tocar código se auditó todo lo que ya existía para no duplicar
trabajo. Resultado:

| Ítem del plan | Estado antes | Qué faltaba realmente |
|---|---|---|
| Optimización de rutas | ✅ Ya implementado (`rutas-live.js accion=reoptimizar`, nearest-neighbor vía Google Distance Matrix con fallback) | Nada — no se tocó |
| Tracking en vivo del chofer | Backend ✅ y mapa admin ✅ (Leaflet + Realtime en `rutas.js`), pero **nadie mandaba el GPS** desde la app del chofer, y el cliente no tenía ninguna pantalla de seguimiento | Emitir el GPS + pantalla de seguimiento para el cliente |
| Notificación al cliente ("a 15 min") | No existía | Nuevo evento `proximidad` |
| Firma digital / foto de conformidad | Columnas `firma_url`/`foto_url` y bucket `remitos` ya existían en la base (Etapa 8.3), el PATCH de entregar ya los aceptaba, pero **el frontend nunca los mandaba** — solo estaba conectado el flujo de fotos de devolución | UI de firma+foto en "Marcar entregado" + endpoint de subida |

Esto redujo bastante el trabajo real vs. lo que parecía a primera vista en el
plan.

## 1. Base de datos

- **Migración `242_etapa1_logistica_aviso_proximidad_entrega.sql`** (ya aplicada en producción vía MCP de Supabase, incluida en el repo para que quede versionada):
  - `entregas.aviso_proximidad_enviado boolean default false` — evita reenviar el aviso de "a 15 min" en cada ping de GPS (~cada 25s).
  - Registrada en `schema_migrations_registry`.

## 2. Tracking en vivo del chofer

- **`frontend/chofer/gps-tracker.js`** (nuevo): se auto-inicia solo en `index.html` y `remito.html` del chofer. Cada ~25s manda `POST /api/rutas-live?accion=posicion` con la posición del navegador, pero **solo si el chofer tiene una ruta hoy con algún pedido "despachado"** (para no gastar batería/datos innecesariamente el resto del día). Si el navegador no da permiso de geolocalización, la app sigue funcionando igual que antes — es 100% best-effort.
- `GET /api/chofer/remitos` ahora devuelve `ruta_id` (general y por remito) — antes no existía forma de que el front supiera a qué ruta pertenecía, así que nadie podía llamar a `accion=posicion`.
- Se agregó `gps-tracker.js` al precache del Service Worker (`sw-chofer.js`) y `rutas-live`/`entrega-foto` a los patrones network-only (nunca se sirven ni cachean desde el SW).

## 3. Notificación automática al cliente ("tu pedido está a ~15 min")

- **`lib/handlers/rutas-live.js`**: cada `accion=posicion` recibido ahora dispara `avisarProximidadSiCorresponde()`, que mira la próxima entrega pendiente de la ruta, calcula un ETA simple (mismo criterio que ya usaba `accion=seguimiento`: paradas restantes × 12 min) y, si cruza el umbral de 15 min y todavía no se avisó para esa entrega puntual, dispara el aviso — sin bloquear la respuesta al chofer.
- **`lib/handlers/notif.js`**: nuevo evento `proximidad` en `/api/notif/notif-entrega` (`{ tipo: 'proximidad', pedido_id, empresa_id, eta_minutos }`) y nuevo template `pedido_por_llegar` en el diccionario de WhatsApp.

  ⚠️ **Acción manual pendiente, fuera del repo**: hay que dar de alta y aprobar el template `pedido_por_llegar` en Meta Business Manager (mismo lugar donde ya están `pedido_despachado`, `pedido_entregado`, etc.), con 3 variables de body: nombre del cliente, número de pedido, minutos estimados. Hasta que esté aprobado, el envío falla con `error_wa` pero queda logueado — no rompe el resto del flujo de tracking.

## 4. Seguimiento en vivo para el cliente

- **`frontend/cliente/pedidos.html`**: pedidos en estado "despachado" ahora muestran un botón **"📍 Ver seguimiento en vivo"** que abre un modal con mapa Leaflet (mismo proveedor que ya usa el admin, sin necesidad de API key de Google) + el texto de ETA, consumiendo el endpoint `accion=seguimiento` que ya existía pero no tenía ningún consumidor en el portal cliente. Polling cada 20s mientras el modal está abierto.

## 5. Firma digital y foto de conformidad en la entrega

- **`lib/handlers/pedidos.js`**: nuevo endpoint `POST /api/chofer/entrega-foto` (sube al bucket `remitos`, ya existente desde la Etapa 8.3 pero nunca conectado a nada). Sirve tanto para la firma (PNG exportado del `<canvas>`) como para la foto, según `tipo: 'firma' | 'foto'`. El PATCH de `entregar` ya aceptaba `firma_url`/`foto_url` desde hace tiempo — ahora además acepta `receptor` (nombre de quien recibe), que también ya existía como columna sin usar.
- **`frontend/chofer/remito.html`**: "Marcar entregado" ahora abre un modal que pide:
  - Firma con el dedo en un `<canvas>` (obligatoria).
  - Nombre de quien recibe (opcional).
  - Foto de conformidad (opcional, mismo mecanismo que ya usaban las devoluciones).
  - Notas (opcional).

  Sube ambas imágenes vía `entrega-foto` y recién después confirma la entrega con el PATCH existente.
- **`vercel.json`**: rewrite nuevo para `/api/chofer/entrega-foto`.

## Archivos tocados

```
supabase/migrations/242_etapa1_logistica_aviso_proximidad_entrega.sql   (nuevo, ya aplicado)
lib/handlers/rutas-live.js        (aviso de proximidad en accion=posicion)
lib/handlers/notif.js             (evento "proximidad" + template pedido_por_llegar)
lib/handlers/pedidos.js           (endpoint entrega-foto, ruta_id en GET remitos, receptor en PATCH entregar)
vercel.json                       (rewrite de entrega-foto)
frontend/chofer/gps-tracker.js    (nuevo)
frontend/chofer/index.html        (incluye gps-tracker.js)
frontend/chofer/remito.html       (incluye gps-tracker.js + modal de firma/foto)
frontend/chofer/sw-chofer.js      (precache + network-only patterns)
frontend/cliente/pedidos.html     (modal de seguimiento en vivo)
```

## Pendiente / próximos pasos sugeridos

1. Dar de alta el template `pedido_por_llegar` en Meta Business Manager (único paso fuera del repo).
2. Probar en el demo el flujo completo: chofer despacha → GPS empieza a mandarse → admin ve el marcador moverse en `/admin/rutas` → cliente abre "seguimiento en vivo" → al acercarse llega el WhatsApp → chofer firma y confirma entrega con foto.
3. Opcional (no bloqueante): si una ruta se reoptimiza y una entrega "avisada" se corre más lejos en el orden, `aviso_proximidad_enviado` no se resetea solo — quedaría sin re-avisar si vuelve a acercarse. No se resolvió en esta etapa por ser un caso borde poco frecuente; se puede sumar un reset condicional en `accion=reoptimizar` si en la práctica llega a pasar.
