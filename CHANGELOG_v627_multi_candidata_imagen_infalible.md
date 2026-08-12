# CHANGELOG v627 — Multi-candidata infalible para imágenes por scanner

## Problema raíz (no resuelto por v626)

v626 arregló dos bugs (botón invisible + refresco bloqueado silenciosamente),
pero el botón "Imagen incorrecta — intentar otra" seguía devolviendo la
**misma imagen incorrecta** cada vez que se clickeaba.

**Por qué**: el endpoint `?accion=refrescar` ejecutaba **la misma búsqueda
Serper** con el mismo código → mismos resultados de Google → misma imagen.
El usuario quedaba atrapado en un loop.

---

## Solución: arquitectura multi-candidata

### Cambio clave de contrato

**Antes:**
```
POST /api/banco-codigos?accion=refrescar  { codigo }
→ { ok, encontrado, nombre, foto_url, fuente }
```

**Ahora (v627):**
```
POST /api/banco-codigos?accion=refrescar
  { codigo, urls_rechazadas?: string[] }
→ { ok, encontrado, nombre, foto_url, candidatas: string[], fuente }
```

- `urls_rechazadas`: URLs que el usuario ya vio y rechazó. Serper las filtra
  de todos sus resultados → cada llamada devuelve imágenes **diferentes**.
- `candidatas`: hasta 8 URLs alternativas (raw Serper, sin rehostear). El
  frontend las consume localmente sin re-consultar al servidor.

---

## Cambios en `lib/handlers/banco-codigos.js`

### `_ejecutarBusquedaImagenSerper(query, urlsRechazadas = [])`
- Acepta `urlsRechazadas` y filtra esas URLs del resultado.
- **Devuelve `string[]`** (hasta 5 candidatas) en lugar de `string|null`.

### `buscarImagenPorNombreSerper(nombre, urlsRechazadas = [])`
- Las 3 estrategias ahora se ejecutan **en paralelo** (Promise.all).
  Antes: short-circuit secuencial (paraba en la primera que encontraba algo).
- Recolecta y deduplica candidatas de las 3 estrategias.
- **Devuelve `{ mejor, candidatas }`** en lugar de `string|null`.
  Con hasta 15 candidatas de entrada (5×3 queries), la probabilidad de
  tener varias alternativas reales es muy alta.

### `consultarSerper(codigo, urlsRechazadas = [])`
- Pasa `urlsRechazadas` a la Fase 2.
- Devuelve `candidatas` en el objeto resultado.

### `buscarEnFuentesExternas(codigo, urlsRechazadas = [])`
- Filtra también las imágenes de OFF/OPF/OBF/ML contra `urlsRechazadas`.
- Propaga `urlsRechazadas` a las llamadas Serper.
- Devuelve `candidatas` en el objeto resultado.

### Handler `refrescar`
- Lee `urls_rechazadas` del body (array, máx. 20 entradas, sanitizado).
- Pasa `urls_rechazadas` a `buscarEnFuentesExternas`.
- Filtra `candidatas` para excluir la imagen principal y las rechazadas.
- Devuelve `candidatas[]` en la respuesta JSON.

---

## Cambios en `frontend/admin/js/productos-scanner-remoto.js`

### Nuevo estado del módulo
```js
let candidatasLocales = [];  // pool de URLs alternativas ya obtenidas del server
let urlsRechazadas    = [];  // URLs vistas y rechazadas por el usuario
let ultimaFotoUrl     = null; // URL de la imagen actualmente mostrada
```

### Reset en cada nuevo scan
`onCodigoEscaneado` y `buscarInfoPorCodigo` resetean el estado completo,
así un código nuevo siempre empieza con la pizarra limpia.

### `refrescarImagen(codigo)` — flujo de 4 pasos

**Paso 1**: registra `ultimaFotoUrl` como rechazada.

**Paso 2**: si `candidatasLocales.length > 0` → usa la siguiente URL
del pool localmente, **sin llamar al server**. Rápido, sin costo de API.
Si la descarga falla (CORS/host caído), la descarta y permite reintentar.

**Paso 3**: si pool vacío → llama al server con `urls_rechazadas` acumuladas.

**Paso 4a**: server devuelve `foto_url` → aplica imagen; guarda `candidatas`
en el pool local; muestra toast con contador de alternativas disponibles.

**Paso 4b**: server no devuelve `foto_url` pero sí `candidatas` → aplica
la primera candidata; guarda el resto en el pool.

**Paso 4c**: todo agotado → quita la imagen, pide al usuario cargar a mano.

### Texto del botón dinámico
El botón muestra el contador de candidatas disponibles:
- `"⚠ Imagen incorrecta — intentar otra (3 disponibles)"`
- `"⚠ Imagen incorrecta — intentar otra"` (cuando no hay stock local)

---

## Archivos modificados

| Archivo | Cambio |
|---|---|
| `lib/handlers/banco-codigos.js` | Multi-candidata en Serper; urls_rechazadas en refrescar |
| `frontend/admin/js/productos-scanner-remoto.js` | Pool local + cycling; envío urls_rechazadas |

## Sin cambios necesarios en

- `frontend/admin/js/productos.js` — `forzarFotoProductoDesdeUrl` de v626 sigue siendo correcto
- Migraciones SQL — ningún cambio de esquema requerido

## Instrucción especial para TALCO VERITAS (7791520009729)

Si la imagen incorrecta ya está cacheada en Supabase, ejecutar una vez
en el SQL Editor para forzar que el próximo refrescar busque de nuevo:

```sql
UPDATE banco_codigos_producto
SET foto_url = NULL, fuente = 'manual'
WHERE codigo = '7791520009729';
```

Luego re-escanear → clickear "Imagen incorrecta — intentar otra".
El servidor buscará con la imagen anterior como rechazada → resultado diferente.
