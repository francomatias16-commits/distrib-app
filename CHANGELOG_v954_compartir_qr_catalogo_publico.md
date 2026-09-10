# v954 — Catálogo público: botón Compartir + QR descargable

Agrega dos formas rápidas de difundir el link del catálogo público de la
empresa, junto al botón "Copiar" que ya existía.

## Diseño

- `frontend/admin/empresa-config.html`: nuevo botón "Compartir"
  (`btn-compartir-catalogo`) que usa `navigator.share()` para abrir el
  selector nativo del sistema (WhatsApp, Instagram, etc.); si el
  navegador no lo soporta, cae automáticamente al mismo flujo de
  copiar link que ya usa el botón "Copiar". También agrega la descarga
  del QR (pide el PNG al endpoint nuevo vía `fetch`, no `<a href>`
  directo, para no exponerlo sin sesión).
- `lib/handlers/empresa.js`: nuevo endpoint `GET
  /api/empresa/catalogo-qr`, con el mismo gate de admin que el resto
  de la sección. Reutiliza `bwip-js` (ya usado para el código de
  barras ARCA) con `bcid: 'qrcode'` — no se agregó ninguna dependencia
  nueva. El link que se codifica se recalcula del lado del server
  (mismo criterio que el frontend: slug si existe, si no UUID), para
  no confiar en lo que mande el cliente.
- `vercel.json`: rewrite `/api/empresa/catalogo-qr` →
  `/api/index?_mod=empresa&_svc=catalogo-qr`.
- `tests/handlers/empresa-permisos.test.js`: tests del endpoint nuevo
  (permisos, slug vs UUID, manejo de error); el bwip-js real se
  mockea para no generar un PNG de verdad en cada corrida.

## Pendiente (fuera de alcance de esta versión)

Tracking de origen (`?src=ig-bio`, tabla nueva `catalogo_visitas`)
para que el dueño vea de qué canal le llegan más visitas al catálogo
— requiere migración de base de datos, queda para una sesión aparte.

## Nota

El código había quedado comentado como "951" en una sesión anterior
cuyos cambios no llegaron a este repo; se renombró a 954 (el próximo
número libre real) al reincorporar el trabajo.
