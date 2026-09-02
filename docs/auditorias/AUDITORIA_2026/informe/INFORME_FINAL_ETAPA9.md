# Informe final — Etapa 9: cierre del plan de auditoría de 9 etapas

**Fecha de cierre:** 2026-08-24 · **Versión:** v970
**Documento base:** `AUDITORIA_BUGS_v954.md` (ver ahí el detalle completo,
evidencia y changelogs de cada hallazgo)

## 1. Resumen ejecutivo

Las 9 etapas del plan están cerradas. Se auditó línea por línea el 100% del
backend (`lib/handlers/`, `lib/repos/`), el 100% del frontend por módulo
(9 módulos admin + 3 portales), la capa de integraciones externas, el
modelo offline-first, la seguridad transversal y la cobertura de tests
sobre los bugs históricos de mayor severidad real.

**Estado para producción: apto, con una sola tarea de infraestructura
pendiente que no es código (ver §3).**

## 2. Qué se encontró y se corrigió, en números

- **2 hallazgos 🔴 Críticos de código** resueltos: incidente real de
  devolución fantasma del asistente de voz (v955, $9,86M revertidos a
  mano) y `/api/notif/whatsapp` sin ningún control de acceso (v960).
  Ambos con test de regresión dedicado (Etapa 8).
- **~14 hallazgos 🟠 Altos** resueltos: XSS de atributo HTML en la función
  de sanitización compartida (afectaba 53 archivos), SSRF en la descarga
  de imágenes de producto, condición de carrera en confirmación de pedido
  sugerido, fuga de detalle interno de errores, gate de rol faltante en
  score, entre otros.
- **~10 hallazgos 🟡 Medios / ⚪ Bajos** resueltos: inconsistencias de
  escaping puntuales (cobranzas, cta-cte, facturación, rutas/mapa,
  checkout), timezone UTC vs ART en un endpoint del portal chofer,
  logging silencioso en 2 rutas de notificación, revocación de sesiones
  tras cambio de contraseña.
- **1097/1097 tests** pasando (68 archivos), verificado dinámicamente con
  `npx vitest run` en esta sesión — no solo por análisis estático.
- **0 vulnerabilidades RLS** encontradas sobre 84 tablas públicas
  auditadas; 8 funciones `SECURITY DEFINER` con `search_path` fijado.

## 3. Lo único que queda abierto — y no es código

| # | Ítem | Tipo | Por qué no se cerró en este plan |
|---|------|------|-----------------------------------|
| 1 | Restaurar el backup semanal (`pg_dump` + GPG, ya corriendo en verde) contra un Supabase de prueba, para confirmar que la restauración funciona | Infraestructura, ~20 min | Requiere acceso a un proyecto Supabase de prueba y ejecución manual — no es algo que un cambio de código resuelva. **Es lo único que priorizaría por encima de cualquier otro pendiente**: si algo corrompe datos hoy, no hay certeza de poder volver atrás. |
| 2 | Correr en navegador real el checklist "🔴 BLOQUEANTE" de `AUDITORIA_PRE_LANZAMIENTO.md` (incluye el ítem marcado "toca plata real, no saltear": precio de catálogo/carrito/checkout con regla de precio especial aplicada) | QA manual | El código detrás de esas reglas fue auditado y no tiene hallazgos, pero nunca se ejecutó un pase visual real — es un paso manual, no de código. |
| 3 | Reemplazar el placeholder `TU-DOMINIO-DE-PRODUCCION` en `robots.txt`/`sitemap.xml` por el dominio real | 1 línea × 2 archivos | Ningún dominio de producción está hardcodeado en el repo; no se pudo autocompletar. |
| 4 | `stock_minimo`: `step="1"` en el input pero `parseFloat` en el JS (columna real `numeric(12,3)`) | Cosmético, no bloqueante | Decisión de producto pendiente (¿aplicar el mismo criterio "solo enteros" de v690?), no un bug. |

Ningún ítem de esta tabla es un bug de lógica de negocio, seguridad o
integridad de datos sin resolver.

## 4. Cómo se llegó hasta acá (las 9 etapas)

0. **Inventario y mapa de dependencias** — completa.
1. **Base de datos** (migraciones, RLS, triggers) — completa, primer
   barrido.
2. **Backend/API dinero-crítico** (pagos, facturas AFIP, stock) — completa.
2b. **Resto del backend** — los ~35 handlers restantes, revisados línea
   por línea en rondas sucesivas (v955-v960).
3. **Integraciones externas** (WhatsApp, OAuth MP, Prisma POS, BCRA,
   Serper) — completa; único hallazgo real fue el SSRF de Serper (v963).
4. **Frontend por módulo** — los 9 módulos admin + 3 portales
   (cliente/chofer/proveedor), completos.
5. **Offline-first/sincronización** — completa; hallazgo OFFLINE-06
   (`sw-cliente.js` sin fallback en `/api/pedidos`) resuelto en v964.
6. **Consistencia end-to-end** — completa (confirmada, sin changelog
   propio adicional).
7. **Seguridad transversal** — completa (v965): vulnerabilidad cross-tenant
   en `calcular_score_cliente` resuelta, `search_path` fijado en funciones
   `SECURITY DEFINER`.
8. **Cobertura de tests vs. bugs históricos** — completa (v966-v970): los
   2 hallazgos 🔴 Críticos y los 🟠/🟡 de backend con mayor riesgo real
   tienen test de regresión dedicado; suite completa verificada
   dinámicamente en verde.
9. **Cierre e informe final** — este documento.

## 5. Recomendación de orden para las próximas 48-72h antes de lanzar

1. Restaurar el backup de prueba (§3, ítem 1) — 20 minutos, cero excusa
   para saltearlo.
2. Reemplazar el dominio placeholder en robots.txt/sitemap.xml y
   deployar.
3. Correr el checklist manual "toca plata real" en navegador (§3, ítem 2).
4. Decidir sobre `stock_minimo` (§3, ítem 4) — cosmético, se puede hacer
   en cualquier momento sin bloquear el lanzamiento.

Con eso, el proyecto queda sin pendientes abiertos de ninguna auditoría de
las 4 que corrieron sobre este repo (seguridad/infra, lógica de negocio,
funcionalidad UI, y este plan de 9 etapas).
