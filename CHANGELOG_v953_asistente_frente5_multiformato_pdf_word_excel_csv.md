# v953 — Asistente: Frente 5 de PLAN_OPTIMIZACION_ASISTENTE_2026.md (multi-formato)

Cierra el Frente 5 del plan: el asistente ahora acepta, además de foto
(JPG/PNG/WEBP), PDF, Word (.docx), Excel (.xlsx) y CSV como adjunto.

## Diseño

- `lib/utils/image-sniff.js`: `validarArchivoPorContenido()` extendida
  para reconocer docx/xlsx (son ZIP — se busca el path canónico
  `word/document.xml` / `xl/workbook.xml` dentro del buffer crudo, sin
  sumar una librería de ZIP) y CSV (validación laxa de "texto plano").
- `lib/utils/extraer-texto-archivo.js` (nuevo): despacha a
  `pdf-parse`/`mammoth`/`xlsx` según el mime real, con import perezoso de
  cada librería.
- `lib/handlers/asistente.js`: si el archivo real es imagen, sigue el
  camino de visión de siempre; si es documento, se extrae texto y se
  concatena a `pregunta` (truncando a `MAX_LARGO_PREGUNTA` si hace
  falta, con aviso — `archivo_truncado` en la respuesta). Un PDF sin
  texto extraíble se manda tal cual a Gemini como `application/pdf`
  (mismo camino de visión, sin rasterizar a mano).
- `frontend/shared/chat-widget.js`: input de adjuntos amplía `accept`,
  valida por mime+extensión (respaldo para SO que no setean bien el
  mime de .docx/.csv), y el chip de adjunto pendiente muestra el nombre
  sin miniatura para documentos (la miniatura sigue siendo solo para
  imágenes).
- `package.json`: se suman `pdf-parse`, `mammoth`, `xlsx`.

## Bug encontrado y corregido durante las pruebas (no estaba en el plan original)

`pdf-parse` (pdf.js v1.10 embebido, viejo) no siempre degrada con
gracia: un PDF real, estructuralmente válido pero sin texto (ej.
generado con una app de escaneo moderna, con xref streams comprimidos)
puede tirar una excepción (`bad XRef entry`, `Invalid PDF structure`)
en vez de devolver texto vacío. Confirmado con un PDF en blanco real
generado con `pdfkit` en el test. Si no se corregía esto, un PDF
escaneado real habría sido *rechazado* con un error genérico en vez de
degradar al camino de visión — exactamente el caso que el Frente 5 más
necesitaba cubrir. Se corrigió tratando cualquier falla de `pdf-parse`
como "posible escaneado" en `extraerTextoDeArchivo()`, en vez de dejar
que la excepción se propague.

## Tests

`tests/asistente/extraer-texto-archivo.test.js` (nuevo, 14 casos):
sniffing por contenido real de docx/xlsx/pdf/csv, rechazo de un .zip
genérico (ej. .pptx) y de binario no reconocido, extracción de texto de
cada formato con fixtures reales (`tests/asistente/fixtures/`), el caso
de PDF escaneado (tanto por texto vacío como por falla de `pdf-parse`),
y propagación de error para un docx corrupto (que el handler atrapa con
un 400 en vez de un 500 crudo).

Corrida completa de `tests/asistente/*`: **373/373 tests en verde**
(29 archivos, incluyendo los del Frente 1 ya cerrado — nada se rompió).

## Pendiente de tu lado

- `npm install` (suma las 3 dependencias nuevas).
- Si todavía no lo hiciste: aplicar la migración
  `600_asistente_tools_reportes_stock_facturas_empresa_id_explicito.sql`
  (Frente 1) contra Supabase.
- Probar en el frontend desplegado con un PDF, un .docx y un .xlsx
  reales de tu operación (factura de proveedor, lista de precios, etc.)
  — los tests cubren la lógica con fixtures controlados, pero vale la
  pena una pasada manual con un archivo real antes de dar por cerrado
  el frente.
- Frente 3 (logging de fallas de selección de tools) sigue siendo el
  próximo paso sugerido en el plan original, ahora que 1 y 5 están
  cerrados.
