# v394 — Se saca Pexels del pipeline; Google CSE se reemplaza por Serper.dev

## Motivación
Decisión explícita de Matías tras revisar el v393: el banco de fotos
genérico (Pexels) es "muy poco efectivo" — una foto representativa de stock
no es la foto del producto, y en la práctica venía siendo la única capa que
corría (ver CHANGELOG_v393). Se saca por completo, no se deja ni siquiera
como opt-in.

Además, Google Custom Search JSON API (la Capa 2 real desde v390) está
cerrada a cuentas nuevas desde 2025 y se discontinúa el 1/1/2027 — si
Matías no tenía ya un proyecto de Google Cloud con esa API activada de
antes, no la puede dar de alta. Se reemplaza por **Serper.dev**, que
scrapea los mismos resultados de Google Images, acepta cuentas nuevas sin
restricción, y sale más barato (~USD 1/1000 consultas contra USD 5/1000 de
Google CSE, sin el tope duro de 10.000/día).

## Pipeline resultante (de más a menos precisa)
1. **Open Food Facts** (barcode, alimentos) — sin cambios.
2. **Open Products Facts** (barcode, no alimentos) — sin cambios.
3. **Serper.dev** (nombre del producto → foto real de la web) — opt-in,
   reemplaza a Google Custom Search.

Ya no hay Capa 4. Lo que no matchea en ninguna de las tres queda con
`foto_url = NULL` y el frontend de catálogo muestra el ícono de categoría —
sin excepción, sin fallback a foto genérica.

## Cambios

### Backend (`lib/handlers/auto-imagenes.js`)
- Se borraron por completo `buscarPorPexels()` y `traducirAIngles()` (la
  traducción ES→EN vía MyMemory solo existía para mejorar el match contra
  Pexels — sin Pexels, no hace falta).
- `buscarPorGoogleImages()` → `buscarPorImagenReal()`: mismo rol (Capa 2,
  foto real por nombre) pero contra `https://google.serper.dev/images` en
  vez de `googleapis.com/customsearch/v1`. Nueva env var: `SERPER_API_KEY`
  (reemplaza a `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX`, una sola key en vez
  de dos). Se manda `gl: 'ar', hl: 'es'` para priorizar resultados de
  sitios argentinos/en español, más relevantes para este catálogo que
  resultados genéricos.
- El filtro de dominios de stock (istockphoto, shutterstock, freepik, etc.)
  que se agregó en v393 para Google Images se mantiene igual, adaptado al
  formato de respuesta de Serper (`domain`/`link` en vez de
  `link`/`image.contextLink`).
- Flags del body vuelven a ser uno solo: `incluirBusquedaReal` (reemplaza a
  los dos flags separados de v393 — ya no hace falta separar "real" de
  "genérico" porque genérico no existe más).
- `fuente` que se guarda en `productos.foto_fuente` para esta capa pasa de
  `'google_images'` a `'busqueda_web'` (más genérico, no ata el nombre de
  columna a qué proveedor de búsqueda esté detrás).

### Frontend (`frontend/admin/js/productos.js`)
- `elegirModoImagenes()` vuelve a 2 tarjetas (era 3 en v393): "Solo código
  de barras" y "+ Buscar foto real por nombre" — se sacó la tarjeta de
  banco genérico.
- `buscarImagenesAutomaticas()` manda `incluirBusquedaReal` en vez de los
  dos flags de v393.
- El resumen final ya no menciona "banco de fotos genérico" — ahora avisa
  cuántas fotos vinieron de "búsqueda web" y sugiere revisarlas (por más
  que ya no sean genéricas, siguen siendo un match automático por nombre,
  no gráficamente verificado).

### Base de datos
Ningún cambio de schema — `productos.foto_fuente` ya era `text` libre desde
v388/v391, así que el nuevo valor `'busqueda_web'` no necesita migración.
El filtro `p_foto_fuente = 'generica'` de `fn_productos_lista` (v392, que
identifica productos con `foto_fuente = 'pexels'`) queda sin uso hacia
adelante — no se tocó la función porque no rompe nada dejarlo (0 productos
van a matchear esa condición de acá en más) y sirve como red de seguridad
si en el futuro se reintroduce algo similar.

## Pendiente (acción de Matías, no de código)
- **Generar `SERPER_API_KEY`** en https://serper.dev (cuenta nueva, sin
  restricciones) y configurarla en Vercel (Project Settings → Environment
  Variables, ambiente Production).
- Se puede borrar `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_CX` y `PEXELS_API_KEY`
  de Vercel si estaban cargadas — ya no las usa nada.
- Serper.dev da créditos gratis de arranque para cuentas nuevas y después
  es pago por consulta (no hay cuota diaria gratis fija como Google CSE) —
  revisar el pricing actual en serper.dev antes de correr el catálogo
  completo (~1000 productos sin foto en el tenant de prueba).

## Deploy
```
vercel --prod
```
