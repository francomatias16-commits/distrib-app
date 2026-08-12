# v396 — Capa 2 en dos etapas: MercadoLibre primero, búsqueda general como fallback

## Motivación
Matías probó "+ Buscar foto real por nombre" con un catálogo de bazar/limpieza/
perfumería mayorista (marcas SINA, JOS MAR, El Coloso, Saphirus, Ariel, Cif,
etc.) y el resultado, aunque descargaba imágenes, seguía siendo "muy
genérico" — el mismo problema de fondo que tenía Pexels, aunque la fuente
ahora fuera búsqueda web real.

La causa: una búsqueda de Google Images sin restricción de sitio para un
nombre como "ACONDICIONADOR FRESCURA 1LT" matchea con cualquier blog,
Pinterest o sitio de otra marca que use esas palabras — no hay garantía de
que sea LA foto del producto puntual. Antes de esto también se confirmó que
la Capa 1 (barcode) da 0% de matches en este rubro: se probó en vivo contra
Open Food Facts y Open Products Facts con varios códigos de la lista de
Matías (incluida una marca internacional grande, pilas Duracell) y ninguno
matcheó — ninguna de esas bases de datos crowdsourced tiene cobertura real
de bazar/limpieza mayorista argentino.

## La solución: MercadoLibre como fuente prioritaria
Estos productos mayoristas casi siempre terminan revendidos en
MercadoLibre — es el marketplace dominante en Argentina y cualquier
distribuidor/revendedor que suba un producto ahí sube la foto real del
producto que tiene para vender, no una ilustrativa. A diferencia de una
búsqueda general, restringir la query a `site:mercadolibre.com.ar` reduce
drásticamente el ruido: si hay resultado, es prácticamente siempre la foto
correcta.

## Cambios

### Backend (`lib/handlers/auto-imagenes.js`)
- `buscarPorImagenReal()` ahora hace **dos consultas en secuencia**:
  1. `buscarImagenSerper('site:mercadolibre.com.ar ' + nombre, 'busqueda_web_mercadolibre')`
  2. Si la etapa 1 no encuentra nada: `buscarImagenSerper(nombre, 'busqueda_web')`
     (el comportamiento de antes, sin restricción de sitio).
- Se extrajo la lógica común de fetch + filtro a `buscarImagenSerper(query, fuente)`,
  reutilizada por ambas etapas.
- Nuevo filtro de proporción (`proporcionRazonable`): descarta candidatos con
  relación ancho/alto fuera de 0.4–2.5 — banners, infografías y logos sueltos
  suelen ser mucho más anchos que altos (o viceversa) y no son fotos de
  producto real. Si Serper no informa alto, no se descarta (no hay con qué
  evaluar, mejor no perder el candidato por las dudas).
- `productos.foto_fuente` ahora puede guardar `'busqueda_web_mercadolibre'`
  además de `'busqueda_web'` — permite auditar después cuántas fotos vinieron
  de cada etapa si hace falta.

### Costo de Serper (importante)
Esto puede **duplicar el consumo de consultas por producto** en el peor caso:
si un producto no aparece en MercadoLibre, se gastan 2 consultas (etapa 1 +
etapa 2) en vez de 1. Para catálogos grandes de bazar/limpieza esto puede
comerse las 2.500 gratis más rápido de lo esperado — el contador agregado en
v395 (visible en el modal del admin) es la forma de vigilar esto en vivo.

### Frontend (`frontend/admin/js/productos.js`)
- El resumen final (`totalConFotoBusqueda`) ahora cuenta ambas fuentes
  (`busqueda_web` y `busqueda_web_mercadolibre`) como una sola categoría
  "búsqueda web" — la distinción entre etapas es interna, no se expone al
  usuario por ahora.

## Qué NO se tocó
- El filtro de dominios de stock (istockphoto, shutterstock, etc.) sigue
  igual, se aplica en ambas etapas.
- La Capa 1 (barcode) no cambia — sigue siendo la más confiable cuando
  matchea, solo que para este tipo de catálogo casi nunca matchea.

## Pendiente / a revisar después de la primera corrida
Correr un lote chico (20-30 productos) de la lista de bazar/limpieza y
revisar visualmente el resultado con el filtro "Foto real" antes de tirarle
el catálogo completo — la restricción a MercadoLibre debería mejorar mucho
la precisión, pero conviene confirmarlo con una muestra real antes de gastar
el resto de las consultas gratis.

## Deploy
```
vercel --prod
```
Sin cambios de base de datos en esta versión.
