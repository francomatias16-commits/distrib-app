# CHANGELOG v628 — Google Shopping (por GTIN) como fuente adicional para imagen

## Problema reportado

"Funciona razonablemente bien para alimentos y bebidas, pero para limpieza,
artículos del hogar y demás la imagen no carga o carga mal en la mayoría
de los casos."

## Diagnóstico

No es un bug puntual — es una diferencia estructural de cobertura entre
fuentes:

- **Open Food Facts** es la base con más años y más aportantes del
  proyecto Open*Facts, específicamente porque la industria alimenticia
  la adoptó masivamente. Cobertura muy buena para alimentos/bebidas.
- **Open Products Facts** y **Open Beauty Facts** son bases hermanas,
  mucho más chicas, con cobertura pobre para productos regionales
  argentinos de limpieza/bazar/higiene (confirmado en v624/v625: Axe,
  Dove, Ala, Blem, Schwarzkopf, Revlon, etc. no figuran en ninguna).
- **Mercado Libre** (búsqueda por texto del código) es hit-or-miss:
  depende de que algún vendedor haya puesto el EAN en el título de su
  publicación.
- El fallback a **Serper Fase 1+2** (v625/v627) ayuda, pero busca nombre
  e imagen en dos consultas *independientes* — nada garantiza que la
  imagen encontrada en la Fase 2 sea de la misma variante/gramaje que
  el nombre encontrado en la Fase 1. Con productos que tienen muchas
  presentaciones (180g/300g, distintos packs), esto produce la imagen
  de una variante equivocada — el síntoma que reportó el usuario.

No existe una base de datos pública con cobertura completa para estas
categorías en Argentina (la oficial, GS1 Argentina / verificar.com.ar,
requiere suscripción paga y no tiene una API pública de fotos). Por eso
"infalible al 100%" no es una meta alcanzable con fuentes gratuitas —
pero se puede acercar mucho más con una fuente que ancle nombre e imagen
al mismo producto exacto.

## Solución: Fase 0 — Google Shopping por código de barras

Los retailers que suben feeds a Google Shopping incluyen el GTIN (código
de barras) explícito. Cuando Google tiene un match para ESE código, el
título y la imagen que devuelve vienen del **mismo listing** — no hay
desacople entre "de dónde sacamos el nombre" y "de dónde sacamos la
imagen", que era la causa de las variantes cruzadas.

### Orden de fuentes actualizado

```
1. Banco propio (cache compartida entre empresas)
2. OFF / OPF / OBF / Mercado Libre (en paralelo, gratis)
3. Serper Fase 0 — Shopping por código (NUEVO, v628)
4. Serper Fase 1+2 — nombre por texto → imagen por nombre (fallback)
```

La Fase 0 se prueba tanto en `consultarSerper` (cuando ninguna fuente
gratuita devolvió nada) como en la rama de `buscarEnFuentesExternas`
donde ya hay nombre pero falta imagen (ej. Mercado Libre sin foto) —
en ambos casos, antes de recurrir a la búsqueda de imagen por nombre.

## Cambios en `lib/handlers/banco-codigos.js`

- Nueva función `buscarPorCodigoShopping(codigo, urlsRechazadas)`:
  llama a `POST https://google.serper.dev/shopping` con `q: codigo`,
  filtra resultados sin imagen/título y los ya rechazados, devuelve
  `{ nombre, imagenUrl, candidatas, fuente: 'serper_shopping' }`.
- `consultarSerper()`: prueba Shopping primero; si no hay imagen usable,
  cae al flujo Fase 1+2 existente (reutilizando el nombre de Shopping
  si lo encontró, para ahorrar una consulta).
- `buscarEnFuentesExternas()`: en la rama "nombre sin imagen", prueba
  Shopping antes de la búsqueda de imagen por nombre.
- `FUENTES_VALIDAS`: se agrega `'serper_shopping'`.

## Sin cambios necesarios en

- `frontend/admin/js/productos-scanner-remoto.js` — ya consume
  `foto_url` / `candidatas` / `fuente` genéricamente, no le importa el
  nombre exacto de la fuente nueva.
- Migraciones SQL — `fuente` ya era un texto libre validado contra
  `FUENTES_VALIDAS` en el handler, no un enum de base de datos.

## Qué NO resuelve esto

Sigue siendo un sistema de "mejor esfuerzo" por búsqueda web, no un
lookup determinístico. Para productos muy regionales/artesanales sin
presencia en ningún retailer online, seguirá sin encontrar nada — en
ese caso el flujo ya existente (botón "Imagen incorrecta — intentar
otra" + carga manual) sigue siendo la salida.

La mejora estructural de fondo, a mediano plazo, es el propio banco de
códigos compartido entre las 440 empresas: cada vez que alguien confirma
o corrige manualmente una imagen, ese dato queda disponible para todas
las demás. Cuantas más empresas usen el escáner, menos productos van a
necesitar pasar por Serper en absoluto.
