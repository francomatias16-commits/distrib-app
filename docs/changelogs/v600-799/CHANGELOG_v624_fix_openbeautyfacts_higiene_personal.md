# CHANGELOG v624 — Fix: higiene personal sin nombre ni foto (Open Beauty Facts)

## Problema reportado
Al escanear códigos de productos de limpieza/higiene personal (Plax, Colgate,
desodorantes, jabones, pasta dental, enjuague bucal) el formulario de alta de
producto solo cargaba el código — sin nombre ni imagen — aunque el mismo flujo
funcionaba bien para alimentos y bebidas.

## Diagnóstico exacto (código del screenshot: 7891024136409 — Plax)

Se probaron todas las fuentes disponibles contra el código real:

| Fuente                   | Resultado           |
|--------------------------|---------------------|
| Open Food Facts (OFF)    | ❌ status 0 — no encontrado |
| Open Products Facts (OPF)| ❌ status 0 — no encontrado |
| **Open Beauty Facts (OBF)** | ✅ nombre: "Plax fresh mint" + imagen |
| UPCItemDB trial          | ❌ 0 resultados     |
| Mercado Libre            | ❌ 0 resultados     |

El producto es de higiene personal (higiene bucal). Este tipo de producto no
figura en Open Food Facts ni en Open Products Facts — vive en **Open Beauty
Facts** (`world.openbeautyfacts.org`), que es una base de datos SEPARADA del
proyecto Open*Facts con el mismo formato de API pero enfocada en cosméticos,
higiene personal, cuidado bucal, desodorantes, jabones y productos similares.

Esta fuente no estaba siendo consultada en ninguna versión anterior (v622/v623).

## Cobertura por tipo de producto (después del fix)

| Base de datos              | Categorías cubiertas                            |
|----------------------------|-------------------------------------------------|
| Open Food Facts            | Alimentos, bebidas, golosinas                   |
| Open Products Facts        | Limpieza del hogar, detergentes, bazar          |
| **Open Beauty Facts** ← nuevo | Higiene personal, cosméticos, desodorantes, jabones, pasta dental, enjuague bucal, shampoo |
| Mercado Libre              | Fallback general para lo que no esté en ninguna base |

## Fix aplicado en `lib/handlers/banco-codigos.js`

Se agrega `world.openbeautyfacts.org` como 4ª fuente en el `Promise.all` de
`buscarEnFuentesExternas`. La función `consultarOpenFacts` ya existente funciona
sin cambios para OBF (mismo protocolo de API).

```js
// ANTES (v623) — solo 3 fuentes
const [off, opf, ml] = await Promise.all([
  consultarOpenFacts('world.openfoodfacts.org', codigo),
  consultarOpenFacts('world.openproductsfacts.org', codigo),
  consultarMercadoLibre(codigo),
]);

// AHORA (v624) — 4 fuentes: se agrega Open Beauty Facts
const [off, opf, obf, ml] = await Promise.all([
  consultarOpenFacts('world.openfoodfacts.org', codigo),
  consultarOpenFacts('world.openproductsfacts.org', codigo),
  consultarOpenFacts('world.openbeautyfacts.org', codigo),   // ← NUEVO
  consultarMercadoLibre(codigo),
]);
```

También se corrige `consultarOpenFacts` para chequear `data?.status !== 1`
antes de procesar — evita falsos positivos cuando la API responde 200 OK
pero con `status: 0` (producto no encontrado en esa base).

## Sin cambios necesarios
- Base de datos / Supabase: no requiere migración
- Frontend (`productos-scanner-remoto.js`): sin cambios
- API (`api/index.js`): sin cambios

## Archivos modificados
- `lib/handlers/banco-codigos.js`
