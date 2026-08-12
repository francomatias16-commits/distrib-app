# v389 — Traducción ES→EN para Capa 2 (Pexels), multi-rubro

## Problema
El producto se va a vender a cualquier tipo de comercio (ferretería, bebidas,
kiosco, lo que sea), no solo distribuidoras de limpieza. La Capa 1 (barcode
vía Open Food Facts + Open Products Facts, v388) ya es agnóstica de rubro
porque busca por código de barra real. Pero la Capa 2 (banco de fotos
genérico, opt-in) buscaba el nombre del producto tal cual en español contra
Pexels, que está indexado en inglés — dando falsos positivos documentados en
el propio código (ej. "Agua Mineral" → fotos de rocas, "mineral" en inglés).
Esto se repite con cualquier categoría, no es un caso aislado.

## Solución
Se agregó `traducirAIngles(texto)`, que traduce la consulta vía MyMemory
(api.mymemory.translated.net — gratis, sin key) antes de pegarle a Pexels.
Si la traducción falla o tarda más de 4s, se sigue con el texto original en
español (Pexels a veces igual matchea nombres de marca ya en inglés). No
rompe nada si MyMemory está caído — es un mejor-esfuerzo, no una dependencia
dura.

## Archivos tocados
- `lib/handlers/auto-imagenes.js`
  - Nueva función `traducirAIngles(texto)`.
  - `buscarPorPexels()` ahora traduce antes de armar la URL de búsqueda.

## Nota de arquitectura
Con v388 + v389, el pipeline completo queda así, agnóstico de rubro:
Open Food Facts (alimentos) → Open Products Facts (todo lo demás con
barcode) → Pexels traducido (representativo, opt-in, para lo que no tiene
barcode o no matcheó en ninguna base). Los productos sin código de barra real
(códigos internos cortos tipo "81", "9000") solo pueden resolverse por la
Capa 2 — eso es una limitación de datos, no de la búsqueda.
