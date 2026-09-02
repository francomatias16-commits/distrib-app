# Plan — Generador de etiquetas de precio / código de barras

**Fecha:** 2026-08-24.

**Estado:** ✅ v1 completo — Etapas 1 a 4 implementadas. Ver changelogs
`CHANGELOG_v543_generador_etiquetas_etapa1.md`,
`CHANGELOG_v976_generador_etiquetas_etapa3.md` (incluye la Etapa 2, que
se había entregado sin changelog propio) y
`CHANGELOG_v977_generador_etiquetas_etapa4_promociones.md`.

**Objetivo de este documento:** definir la forma más eficiente y prolija
de sumar un generador de etiquetas de precio con código de barras para
`productos`, reutilizando patrones que el proyecto ya tiene resueltos
(impresión por navegador con `@page`, configuración de hardware por
empresa, ciclo de reset/snapshot de la demo) en vez de inventar un
mecanismo nuevo.

---

## 1. Alcance

**Entra en v1:**
- Selección de productos (por categoría, proveedor, búsqueda de texto,
  o carga masiva por recepción de mercadería recién ingresada).
- Vista de impresión con grilla de etiquetas: nombre, precio (con IVA),
  código de barras escaneable y unidad (si es por peso).
- Formato de etiqueta configurable por empresa (ancho/alto, columnas por
  hoja, márgenes) — mismo criterio que el ancho de papel del ticket POS.
- Generación de código de barras 100% client-side (sin backend nuevo).
- Precio promocional tachado usando `reglas_precio` vigente (general,
  sin zona ni piso de cantidad — ver Etapa 4).

**Queda afuera de v1 (fase futura, no bloquea el lanzamiento):**
- Impresión nativa ZPL/EPL a impresoras industriales dedicadas de
  etiquetas (Zebra/Argox). v1 se apoya en el diálogo de impresión del
  navegador, igual que ya hace el ticket POS en "modo Navegador".

## 2. Por qué browser-print y no un driver nativo

El proyecto ya resolvió un problema equivalente en **v758** (`pos-printer.js`):
en vez de pelear con drivers específicos, inyecta un `<style>` con
`@page { size: <ancho>mm auto; margin: 0 }` antes de `window.print()` y
deja que el navegador/el driver del sistema operativo (el que sea:
impresora de etiquetas térmica, impresora de escritorio con hojas
troqueladas tipo Avery, etc.) resuelva la salida física. Es el mismo
principio que conviene aplicar acá:

- No depende de qué marca de impresora de etiquetas tenga cada cliente.
- No requiere instalar nada del lado del navegador.
- El ancho/alto de la etiqueta queda en una configuración de empresa, no
  hardcodeado — un cliente con etiquetas de 40×30mm y otro con rollos de
  50×25mm usan la misma pantalla.

La contra (aceptable para v1): el usuario tiene que elegir la bandeja o
el driver correcto en el diálogo del navegador la primera vez, como ya
pasa hoy con el ticket POS en modo Navegador.

## 3. Modelo de datos

### 3.1 Tabla nueva: `config_etiquetas` (config por empresa, 1 fila)

Mismo patrón que `facturacion_config` (tabla #1 del ciclo de reset —
singleton por `empresa_id`):

| Columna | Tipo | Notas |
|---|---|---|
| `empresa_id` | uuid PK/UNIQUE, FK → empresas | |
| `ancho_mm` | numeric | default 50 |
| `alto_mm` | numeric | default 25 |
| `columnas` | integer | columnas por hoja al imprimir en A4/carta con hojas troqueladas; irrelevante para rollo continuo |
| `margen_mm` | numeric | default 2 |
| `formato_simbologia` | text | `'auto'` (regla de la sección 4), `'ean13'`, `'code128'` |
| `lista_precio_default_id` | uuid, FK → listas_precios, nullable | qué lista de precio se imprime por defecto |
| `incluir_iva` | boolean | default true — precio final al público |
| `mostrar_codigo_interno` | boolean | default true — texto legible del código debajo de las barras |
| `mostrar_promociones` | boolean | default true — precio tachado si hay una `reglas_precio` general vigente (Etapa 4) |
| `updated_at` | timestamptz | |

> **Gotcha a no repetir:** esta tabla tiene que sumarse a
> `fn_snapshot_demo_v2` y `fn_reset_demo_v2` en el mismo momento en que
> se cree — como singleton no-hija, es un alta trivial (mismo patrón que
> `reglas_score`, agregado hoy mismo). Si se posterga "para después" queda
> exactamente el mismo tipo de bug que ya aparecieron dos veces esta
> sesión: config que se prueba una vez, funciona, y al primer reset de
> las 6hs desaparece o — peor, si en el futuro alguna tabla hija le
> apunta con `ON DELETE CASCADE` sin estar en el ciclo — rompe el reset
> entero como pasó con `combo_items`.
> ✅ Resuelto en la Etapa 1 (ord 56 en ambas funciones).

### 3.2 Nada más nuevo en el modelo

`productos` ya tiene todo lo necesario: `codigo`, `codigo_es_barras`,
`precio_base`, `iva`, `vendido_por_peso`. No hace falta tocar el
esquema de productos.

`reglas_precio` (motor de descuentos por volumen/zona/temporada) ya
existía de una etapa anterior del proyecto (243), con pantalla propia
de administración en Admin → Descuentos automáticos — la Etapa 4 la
reutiliza sin duplicarla.

## 4. Regla de generación del código de barras

Client-side, con `JsBarcode` (CDN), sin ida y vuelta al backend:

1. Si `codigo_es_barras = true` **y** `codigo` son 13 dígitos numéricos
   válidos → renderizar **EAN-13** (compatibilidad con lectores de
   góndola ya calibrados para EAN).
2. Si `vendido_por_peso = true` → construir el código de balanza
   variable (prefijo `20`–`29` + código interno + importe/peso
   codificado + dígito verificador) en vez de imprimir el `codigo` tal
   cual — es el mismo formato que ya deben estar generando las balanzas
   del depósito, así que la etiqueta tiene que coincidir con eso o el
   escaneo en caja no va a matchear el producto.
3. En cualquier otro caso (código alfanumérico interno, sin flag de
   barras) → **CODE128**, que acepta el string tal cual sin
   checksum/formato especial y cualquier lector 1D moderno lo autodetecta.
4. `config_etiquetas.formato_simbologia` permite forzar `ean13` o
   `code128` para todo el lote si el criterio automático no sirve para
   un caso particular (ej. un proveedor que manda EAN de 12 dígitos
   UPC-A y hay que tratarlo aparte).

**✅ Implementado tal cual en `frontend/admin/js/etiquetas-print.js`,
Etapa 1.**

## 5. Flujo de UI (implementado)

- **Punto de entrada:** botón "Generar etiquetas" en el listado de
  Productos (Admin), sobre la selección múltiple de esa grilla
  (Etapa 2). Segundo punto de entrada: desde **Recepción de
  mercadería**, al confirmar un ingreso, modal "Recepción confirmada"
  ofreciendo "Imprimir etiquetas de esta recepción" con los productos y
  cantidades recién ingresados precargados (Etapa 3).
- **Pantalla de vista previa:** grilla que respeta `columnas` y
  `ancho_mm`/`alto_mm` de `config_etiquetas`, con controles rápidos
  (copias por producto, toggle de IVA, toggle de promociones —
  Etapa 4). Módulo compartido (`etiquetas-preview.js`) entre Productos
  y Compras, autocontenido en CSS propio (`etiquetas-preview.css`).
- **Impresión:** `EtiquetasPrint.imprimir()` (`etiquetas-print.js`)
  arma la grilla e inyecta el `@page` en mm de etiqueta, luego dispara
  `window.print()`.
- **Admin → Hardware:** sub-sección "Etiquetas de precio / código de
  barras" en `pos.html`, junto a la config de impresora térmica.

## 6. Etapas de implementación

1. ✅ **Etapa 1 — Motor de impresión.** Migración de `config_etiquetas`
   (+ alta en el ciclo demo), pantalla de configuración en Admin →
   Hardware, función de armado de la grilla imprimible con datos
   estáticos de prueba. Ver `CHANGELOG_v543_generador_etiquetas_etapa1.md`.
2. ✅ **Etapa 2 — Selección de productos.** Botón en el listado de
   Productos, selección múltiple, conexión con la Etapa 1. Entregada
   sin changelog propio — documentada retroactivamente en
   `CHANGELOG_v976_...etapa3.md` (que también completó el CSS que le
   faltaba).
3. ✅ **Etapa 3 — Integración con Recepción de mercadería.** Precarga
   automática de productos+cantidades desde una recepción confirmada
   (incluido el caso de excedente). Ver
   `CHANGELOG_v976_generador_etiquetas_etapa3.md`.
4. ✅ **Etapa 4 — Promociones en la etiqueta.** Precio tachado usando
   `reglas_precio` general (sin zona, cantidad mínima 1) vigente para
   ese producto/categoría. Ver
   `CHANGELOG_v977_generador_etiquetas_etapa4_promociones.md`.

## 7. Checklist de prueba manual

Ver `checklist_pase_manual.md`, secciones "Etiquetas de precio /
código de barras — Etapa 1/2/3/4 (543)". El detalle línea por línea
vive ahí, no se duplica en este documento.
