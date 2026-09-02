# v393 — Fix: Capa 2 (Google Images) y Capa 3 (Pexels) quedan opt-in por separado

## Diagnóstico (tenant "Distribuidora del Litoral S.A.", empresa_id `4462586e-e11a-4d34-a405-17103bb9cf9f`)

Se auditó la base contra el pipeline documentado en v381/v389/v390: de 1090
productos activos, 704 tienen código con formato EAN válido, pero **cero**
quedaron con `foto_fuente = 'openfoodfacts'` u `'openproductsfacts'` — la
Capa 1 (barcode) no está dando matches porque son productos de marcas
argentinas (Saphirus, Detrex, Cotella, etc.) que esas bases globales no
indexan. Es una limitación de cobertura de datos, no un bug.

56 productos quedaron con `foto_fuente = 'pexels'` (foto genérica de stock)
y **cero** con `foto_fuente = 'google_images'` en toda la base, pese a que
hubo corridas con la búsqueda ampliada activada. Eso apunta a que
`GOOGLE_CSE_API_KEY` / `GOOGLE_CSE_CX` nunca se configuraron en Vercel: el
código de `buscarPorGoogleImages()` corta en silencio (`if (!key) return
null`) y cae siempre a Pexels sin loguear nada distinto — desde la UI previa
(un solo flag `incluirBancoFotos` para las dos capas) no había forma de
notar que la Capa 2 nunca se estaba intentando.

Resultado: para cualquier producto sin barcode real, la única capa que
efectivamente corría era la de banco genérico — de ahí las fotos no
relacionadas con el producto (ej. chocolates, detergentes y esponjas con
fotos de stock intercambiables entre sí).

## Cambios

### Backend (`lib/handlers/auto-imagenes.js`)
- **Flags separados**: `incluirGoogleImages` e `incluirBancoGenerico` en vez
  de un solo `incluirBancoFotos`. Ahora se puede activar "foto real por
  nombre" sin arrastrar el fallback de banco genérico.
- **Precheck de env vars por flag**: pedir `incluirGoogleImages` sin
  `GOOGLE_CSE_API_KEY`/`GOOGLE_CSE_CX` configuradas devuelve error explícito
  en vez de fallar en silencio y terminar en Pexels.
- **Filtro de dominios de stock en Google Images**: se descartan resultados
  de istockphoto, shutterstock, gettyimages, alamy, dreamstime, freepik,
  123rf, pexels, pixabay, depositphotos, adobe stock, vecteezy — si se cuelan
  en los resultados de búsqueda por nombre, son una foto genérica disfrazada
  de "foto real", el mismo problema que esta capa existe para evitar.
- **`limpiarNombreParaBusqueda()` más agresiva**: ahora también saca códigos
  de empaque tipo "CX21", "BL6X12", "FARDO X 12", "FX6" — antes solo sacaba
  "x500ml"/"x1un". Estos códigos no aportan nada a la búsqueda de imagen y
  le restan precisión al motor de búsqueda.

### Frontend (`frontend/admin/js/productos.js`)
- `elegirModoImagenes()` pasa de 2 a 3 tarjetas: "Solo código de barras" →
  "+ Buscar foto real por nombre" (Google Images, recomendado) → "+ Además,
  banco de fotos genérico" (Pexels, último recurso, con aviso explícito de
  que hay que revisar esos productos después).
- `buscarImagenesAutomaticas()` manda los dos flags nuevos al endpoint en
  vez del combinado.

## Datos: limpieza de fotos incorrectas ya cargadas

Se resetearon a `foto_url = NULL, foto_fuente = NULL` los 56 productos de
"Distribuidora del Litoral S.A." que tenían foto de Pexels — quedan con el
ícono de categoría hasta reprocesar. No se pudo borrar el archivo huérfano
del bucket vía SQL directo (`storage.protect_delete()` lo bloquea a
propósito); quedan sin referenciar en `productos-fotos` y se van a
sobrescribir solos la próxima vez que se suba una foto a esa misma ruta
(`${empresa_id}/${producto_id}.jpg`, `upsert: true`).

## Pendiente (acción de Matías, no de código)

- **⚠️ Custom Search JSON API está cerrada a cuentas nuevas desde 2025** y
  se discontinúa por completo el 1/1/2027. Sigue funcionando para quien ya
  la tenía habilitada en un proyecto de Google Cloud de antes del cierre —
  si Matías ya tiene un proyecto con la API activada de antes, puede generar
  la key ahí sin problema. Si nunca la activó, no se puede dar de alta de
  cero en 2026: conviene confirmar esto primero, antes de asumir que esta
  capa va a estar disponible.
- **Configurar `GOOGLE_CSE_API_KEY` y `GOOGLE_CSE_CX` en Vercel** (Project
  Settings → Environment Variables, ambiente Production). Sin esto, la
  opción "Buscar foto real por nombre" del modal va a devolver error
  explícito en vez de fallar en silencio — comportamiento buscado, para que
  quede claro que falta el paso de configuración y no se caiga a Pexels sin
  avisar.
- Una vez configuradas las keys: correr "Solo código de barras" primero
  (gratis, sin cuota) y después "+ Buscar foto real por nombre" para el
  resto — dejar "banco de fotos genérico" para el final, revisando con el
  filtro "Foto genérica" del listado.
- La cuota gratis diaria de Google Custom Search es de 100 consultas/día
  (después $5/1000, tope de 10.000/día) — con ~1000 productos sin foto en
  este tenant, va a llevar varios días correrlo completo con cuota gratis.
- **Si la API no está disponible** (cuenta sin acceso previo): la
  alternativa real es conseguir códigos de barra reales para los productos
  con código interno "AUTO-..." — eso habilita la Capa 1, que es gratis,
  sin cuota, y trae la foto correcta por match exacto sin depender de
  ningún servicio de pago ni de calidad de búsqueda por nombre.

## Deploy
```
vercel --prod
```
