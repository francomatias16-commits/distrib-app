# Etiquetas de precio: fix 500 en config + códigos de barras de prueba inválidos (v980)

Analizando la captura de pantalla (banner "No se pudo guardar la
configuración de etiquetas.", consola con 500 en
`/api/etiquetas/config?_svc=config` y "No se pudo generar código de
barras" para los 3 productos con EAN-13 de `datosDePrueba()`).

## 1) 500 en GET/PUT `/api/etiquetas/config?_svc=config` — bug real, confirmado

**Causa raíz:** la migración `20260824060000_543_etiquetas_etapa4_promociones.sql`
(Etapa 4, agrega `config_etiquetas.mostrar_promociones` + la función
`resolver_precios_etiquetas`) estaba en el repo pero **nunca se había
corrido contra producción** (proyecto `jgiquzjwoedmzwqgzubr`) — mismo
patrón de "disaster-recovery gap" ya documentado antes en este
proyecto (ver v892). Confirmado contra la DB real vía MCP antes de
tocar nada: la tabla tenía todas las columnas de la Etapa 1 pero no
`mostrar_promociones`, y `resolver_precios_etiquetas` no existía.

El repo (`lib/repos/etiquetas.js`, desde v976/977) ya asume esa
columna en el `SELECT`/`UPSERT` de `obtenerConfigEtiquetas`/
`guardarConfigEtiquetas` — con la columna inexistente, Postgres
rechazaba la query, `errorSeguro()` la convertía en 500, y el front
mostraba el mensaje genérico "No se pudo guardar/cargar la
configuración de etiquetas." exactamente como en la captura.

**Fix:** se aplicó la migración `20260824060000` directo en
producción vía MCP (columna + función + registro en
`schema_migrations_registry`, incluyendo la fila de la Etapa 1 que
tampoco estaba registrada). Verificado después: la columna y la
función ya existen en la DB real. Sin cambios de código — el bug
era 100% de migración pendiente, igual que v899/v892.

## 2) "No se pudo generar código de barras" en los 3 productos EAN-13 de prueba

**Causa raíz:** los 3 códigos EAN-13 de `datosDePrueba()` (Yerba
Mate, Fideos, Jabón en Polvo) tenían el dígito verificador mal
calculado — son datos inventados a mano, no códigos reales. JsBarcode
valida el checksum real de EAN-13 antes de dibujar, y tira excepción
si no cierra (capturada por el `try/catch` de `montarGrilla()`, que
por eso no rompía toda la grilla — pero tampoco dibujaba nada, y
avisaba por `console.warn`, tal como se ve en la consola de la
captura para los 3 productos).

**Fix:** recalculados los 3 checksums con el algoritmo estándar
GTIN-13 (`frontend/admin/js/etiquetas-print.js`):
- `7790070410123` → `7790070410122`
- `7790040012225` → `7790040012226`
- `7791234567890` → `7791234567898`

Sin cambios de lógica — solo los datos de prueba estaban mal.

## No tocado
- `lib/handlers/etiquetas.js`, `lib/repos/etiquetas.js`,
  `etiquetas-config.html`: el código en sí ya estaba bien (incluye
  el fix de `mostrarAlerta()` y la CSP de v979) — el problema era
  100% la migración faltante en producción.
- `etiquetas-preview.js`/Compras: usa productos reales, no
  `datosDePrueba()` — no afectado por el bug #2.
