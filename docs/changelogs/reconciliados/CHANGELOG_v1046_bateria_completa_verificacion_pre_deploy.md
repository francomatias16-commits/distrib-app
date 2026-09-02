# v1046 — Batería completa de verificación en verde, checkpoint pre-deploy (2026-08-31)

## Contexto

Cierre de la sesión de trabajo del 2026-08-31 (migraciones 568/569,
fix de `scripts/load-test.js` y suba de `KPIS_CACHE_TTL_MS`, v1042-v1045).
Antes de dar por buena esa tanda de cambios se corrió la batería
completa de verificación del repo — reportada en verde por Matías:

| Comando | Qué cubre | Resultado |
|---|---|---|
| `npm test` | Lógica pura de `lib/` (unitarios, vitest) | OK |
| `npm run test:e2e` | UI del admin contra mocks (Playwright) | OK |
| `npm run test:integration` | CRUD/RPCs reales contra Supabase (DB real, no mock) | **93/93** |
| `npm run check-schema` | Tablas/columnas que el código referencia vs. lo que existe de verdad en la DB | OK |
| `npm run check:migrations` | Migraciones duplicadas o no registradas ("disaster-recovery gap") | OK |
| `npm run check-wiring:all` | `fetch('/api/...')` del frontend → rewrite en `vercel.json` → handler real; assets `<script>`/`<link>` rotos en las ~75 páginas | OK |
| `npm run check-handler-dispatch` | Que cada `accion=X` que manda el frontend tenga algo que lo atienda del lado del handler | OK |
| `npm run check:shared-selectors` | CSS compartido duplicado/divergente entre páginas | OK |
| `npm run audit:mobile` / `audit:breakpoints` | Overflow horizontal y roturas visuales en mobile y en varios anchos | OK |
| `npm run audit:security` | Funciones `SECURITY DEFINER` sin filtro de `empresa_id`, vistas sin `security_invoker` | OK |
| `npm run audit:funciones-fantasma` | Funciones que viven en la DB pero no están versionadas en `supabase/migrations/` (ver v1043) | OK |
| `npm run loadtest` | Los 9 endpoints del incidente RL-01, bajo 20-50 usuarios concurrentes (ver v1044/v1045) | OK |

`npm run predeploy` ya encadena varios de estos (migraciones + smoke
test + los 3 wiring checks), pero no incluye vitest, e2e, ni los
audits de seguridad/mobile/carga — de ahí que se hayan corrido por
separado para tener el cuadro completo antes de este checkpoint.

## Qué NO cubre esta batería

Ni sumando todo esto se llega a "100%" en sentido estricto:
accesibilidad (lectores de pantalla, contraste) y auditoría de
performance de carga de página (Lighthouse) no tienen script propio en
el proyecto todavía. Dentro de lo que el sistema sabe verificarse a sí
mismo hoy (lógica, UI, DB real, esquema, wiring, mobile, seguridad y
carga), quedó todo en verde.

## Resultado

Checkpoint limpio — sin hallazgos nuevos que abrir a partir de esta
corrida. Sirve de respaldo para dar por cerrada la tanda v1042-v1045
(trackeo de funciones fantasma, backfill de la migración 568, fix del
falso "OK" en `load-test.js`, y la suba de TTL de caché en los 4
dashboards pesados) antes de deployar.
