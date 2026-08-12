# v390 — Capa 2 real: Google Custom Search Images (fotos reales por nombre)

## Motivación
Pexels es una fototeca de stock (paisajes, personas, conceptos genéricos) —
nunca va a traer la foto real de un producto puntual. Para catálogos de
cualquier rubro (ferretería, bebidas, kiosco, lo que sea), lo efectivo para
productos sin barcode real o que no matchearon en Open Food/Products Facts
es buscar la foto real por nombre en la web, no una imagen representativa.

## Solución
Nueva Capa 2: Google Custom Search API en modo imagen
(GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX, cuota gratis diaria, después $/1000).
Busca por nombre limpio del producto, sin traducir (nombres de marca/modelo
funcionan igual en cualquier idioma), y prioriza el resultado de imagen más
grande entre los primeros 5 (para evitar íconos/miniaturas de baja calidad).

Pexels pasa a ser la **Capa 3**, último recurso solo si Google Images no
encontró nada o no está configurado.

## Cascada completa (de más a menos precisa)
1. Open Food Facts (barcode, alimentos)
2. Open Products Facts (barcode, no alimentos)
3. Google Custom Search Images (nombre, foto real) — opt-in
4. Pexels traducido ES→EN (nombre, foto representativa/genérica) — opt-in,
   último recurso

## Archivos tocados
- `lib/handlers/auto-imagenes.js`
  - Nueva función `buscarPorGoogleImages(nombreProducto)`.
  - `resolverImagenProducto()` prueba Google Images antes de Pexels.
  - Precheck de env vars ampliado: ahora alcanza con tener configurada
    GOOGLE_CSE_API_KEY+GOOGLE_CSE_CX **o** PEXELS_API_KEY (no las dos).
- `frontend/admin/js/productos.js`
  - Texto del modal `elegirModoImagenes()` actualizado: la opción ampliada
    ahora dice "Buscar por nombre además" en vez de "banco de fotos
    genérico", reflejando que primero intenta foto real (Google Images) y
    recién si eso falla cae a banco genérico (Pexels).

## Variables de entorno nuevas (Vercel)
- `GOOGLE_CSE_API_KEY` — API key de Google Cloud con Custom Search API habilitada.
- `GOOGLE_CSE_CX` — ID del Programmable Search Engine (configurado para
  buscar imágenes en toda la web, no solo un sitio).

## Consideración legal/de uso
Google Images trae fotos de terceros (sitios de venta, fabricantes) sin
licencia explícita para redistribución — es práctica estándar en catálogos
de distribuidoras, pero vale la pena que quien administre cada empresa lo
sepa antes de activar la opción ampliada.
