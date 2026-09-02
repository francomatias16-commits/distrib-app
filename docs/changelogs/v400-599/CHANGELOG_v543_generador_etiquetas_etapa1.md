# CHANGELOG v543 — Generador de etiquetas de precio/código de barras, Etapa 1 (motor de impresión)

**Fecha:** 2026-08-24.

Continuación de `PLAN_ETIQUETAS_PRECIO_CODIGO_BARRAS.md` (sección 6,
Etapa 1: "Motor de impresión. Migración de `config_etiquetas` (+ alta en
el ciclo demo), pantalla de configuración en Admin → Hardware, función de
armado de la grilla imprimible con datos estáticos de prueba, sin integrar
selección real todavía").

## Qué entra en esta etapa

- **Migración `20260824050000_543_config_etiquetas.sql`**: tabla
  `config_etiquetas` (singleton por empresa — mismo patrón que
  `facturacion_config`, 102), RLS `service_role`-only, y alta en
  `fn_snapshot_demo_v2`/`fn_reset_demo_v2` como ord 56 (no-hija). No se
  tocó el esquema de `productos` — ya tenía todo lo necesario (`codigo`,
  `codigo_es_barras`, `precio_base`, `iva`, `vendido_por_peso`).
- **`lib/repos/etiquetas.js`** + **`lib/handlers/etiquetas.js`**: GET/PUT
  `/api/etiquetas/config`, gateados con el permiso `empresa_config`
  (mismo gate que el resto de Admin → Hardware/Config). Cableado en
  `api/index.js` (LOADERS) y `vercel.json` (rewrite) — verificado con
  `check-api-wiring.js` y `check-handler-dispatch.js`.
- **`frontend/admin/js/etiquetas-print.js`** (nuevo): motor de impresión
  100% client-side. Mismo principio que `pos-printer.js` (v758,
  modo navegador): inyecta un `<style>` con `@page` en las medidas reales
  de la etiqueta (mm) y deja que `window.print()` + el driver del sistema
  resuelvan la salida física. Implementa la regla de código de la
  sección 4 del plan (EAN-13 / CODE128 / código de balanza para
  `vendido_por_peso`) y usa JsBarcode (CDN) para el render SVG.
- **Sub-sección "Etiquetas de precio / código de barras"** dentro del
  panel Admin → Hardware existente en `pos.html` (junto a la config de
  impresora térmica, como pide la sección 5 del plan), con guardado
  independiente (`guardarConfigEtiquetas`) y un botón "Vista previa de
  prueba" que imprime una grilla con 6 productos ficticios
  (`EtiquetasPrint.datosDePrueba()`) cubriendo los 3 casos de la regla de
  código.
- Checklist de prueba manual agregado a `checklist_pase_manual.md`.

## Qué queda afuera (siguiente etapa)

- **Etapa 2** (selección real): botón "Generar etiquetas" en el listado
  de Productos (Admin) sobre la selección múltiple existente de esa
  grilla, con filtros por categoría/proveedor. Reemplaza
  `EtiquetasPrint.datosDePrueba()` por los productos realmente
  seleccionados — el motor de impresión (`armarGrilla`/`imprimir`) ya
  está listo para recibirlos tal cual (acepta `_copias` por producto
  desde ahora, pensando en la Etapa 3).
- **Etapa 3**: precarga desde Recepción de mercadería.
- **Etapa 4** (futura): precio promocional tachado con `reglas_precio`.

## Gotcha para no repetir

`config_etiquetas` ya quedó en el ciclo de snapshot/reset del demo en
esta misma migración — si alguna etapa futura agrega una tabla nueva
relacionada (ej. una tabla de plantillas de etiqueta), sumarla al ciclo
en el mismo commit en que se crea, no "después": es el mismo bug que ya
apareció dos veces esta sesión según el plan (ver PLAN, sección 3.1).
