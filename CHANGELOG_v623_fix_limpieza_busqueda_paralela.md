# CHANGELOG v623 — Fix: productos de limpieza sin nombre ni foto al escanear

## Problema
Al escanear el código de barras de un producto de limpieza (jabón, desodorante, detergente, etc.)
el formulario de alta de producto no completaba ni el nombre ni la imagen, aunque el mismo
flujo funcionaba bien para alimentos y bebidas.

## Root cause
En `lib/handlers/banco-codigos.js`, la función `buscarEnFuentesExternas` consultaba
Open Food Facts (OFF) y Open Products Facts (OPF) **en serie**, y cortaba en el primer
resultado que devolviera cualquier cosa — aunque fuera incompleto (solo imagen, sin nombre):

```js
// ANTES — v622
const off = await consultarOpenFacts('world.openfoodfacts.org', codigo);
if (off) return off;  // ← si OFF devolvía algo parcial, nunca llegaba a OPF

const opf = await consultarOpenFacts('world.openproductsfacts.org', codigo);
if (opf) return opf;
```

- **OFF** (alimentos/bebidas) puede tener una entrada para un código de limpieza con imagen
  pero sin `product_name` — eso hacía que `off` fuera truthy y se saltara OPF por completo.
- **OPF** (Open Products Facts) es justamente la base de datos para limpieza, bazar y
  cuidado personal — pero el código anterior raramente llegaba a consultarla.
- Además, las tres consultas eran **secuenciales**: esperaban hasta 4 s de timeout cada una
  antes de pasar a la siguiente, sumando hasta 12 s en el peor caso.

## Fix aplicado
`buscarEnFuentesExternas` ahora usa `Promise.all` para consultar las tres fuentes en
**paralelo** y mergea el mejor resultado:

```js
// AHORA — v623
const [off, opf, ml] = await Promise.all([
  esValido ? consultarOpenFacts('world.openfoodfacts.org', codigo)     : Promise.resolve(null),
  esValido ? consultarOpenFacts('world.openproductsfacts.org', codigo) : Promise.resolve(null),
  consultarMercadoLibre(codigo),
]);

const nombre    = off?.nombre    || opf?.nombre    || ml?.nombre    || null;
const imagenUrl = off?.imagenUrl || opf?.imagenUrl || ml?.imagenUrl || null;
const fuente    = off?.fuente    || opf?.fuente    || ml?.fuente    || null;
```

## Impacto
| Caso | Antes | Después |
|------|-------|---------|
| Alimento/bebida en OFF con nombre+foto | ✅ funcionaba | ✅ igual |
| Limpieza en OPF (OFF tiene entrada parcial) | ❌ no completaba | ✅ mergea nombre de OPF |
| Limpieza solo en OPF (OFF sin entrada) | ❌ dependía del orden serial | ✅ consulta en paralelo |
| Código no en ninguna base, solo en ML | ✅ funcionaba (3er fallback) | ✅ igual, más rápido |
| Latencia máxima (ninguna base responde) | ~12 s (3 × 4 s) | ~4 s (Promise.all) |

## Archivos modificados
- `lib/handlers/banco-codigos.js` — función `buscarEnFuentesExternas` (líneas ~169-181)

## Sin cambios necesarios
- Base de datos: no requiere migración
- Frontend (`productos-scanner-remoto.js`): sin cambios
- API (`api/index.js`): sin cambios
- Todos los demás handlers: sin cambios
