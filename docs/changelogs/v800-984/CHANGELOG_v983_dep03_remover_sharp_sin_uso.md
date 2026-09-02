# v983 — DEP-03: remover `sharp` (devDependency sin uso)

## Contexto
Continuación de DEP-01/DEP-02 (ya cerrados en v447 y confirmados en esta sesión con `npm ci` real contra el registro de npm).

## Hallazgo
`npm audit` real (con acceso al registro, no disponible en la auditoría original) mostró 2 vulnerabilidades ALTAS:

1. **nanoid** (GHSA-2v37-7h3g-55p8) — cadena `vitest → vite → postcss → nanoid@3.3.16`. Solo test runner, nunca corre en producción. Requiere generador custom con `size=0` (no usado en este código). Riesgo real: nulo. **No accionable sin downgrade de vitest** — se deja documentado, no se toca.
2. **sharp** (CVEs de libvips) — declarado en `package.json` como devDependency (`^0.33.4`) pero **sin ningún import en el repo** (grep exhaustivo a `lib/`, `api/`, `scripts/`, `frontend/`: cero resultados). Peso muerto.

## Acción
`npm uninstall sharp` → confirmado removido de `package.json` y `package-lock.json`.

## Resultado
- Vulnerabilidades: 11 (9 moderate, 2 high) → **10 (9 moderate, 1 high)**
- El high restante (nanoid) es dev-only y no accionable sin tocar vitest/vite — riesgo real nulo, documentado arriba.
- Los 9 moderate son todos la misma cadena `uuid` vía `gaxios/hyperid/teeny-request/@google-cloud/storage/retry-request` (dependencias transitivas de `firebase-admin`, no de código propio) + `esbuild` (dev-server, no corre en Vercel prod). Ya contemplados en DEP-01/DEP-02.

## Verificación
- `npm ci --dry-run`: limpio, 490 paquetes (antes 491, uno menos por sharp).
- Suite completa (`npx vitest run`): **1095/1097 OK**. 2 fallas preexistentes en `tests/scripts/migraciones-orden.test.js` (orden de prefijo de 2 migraciones RLS), **sin relación con este cambio** — quedan fuera de este alcance, avisar si querés que las revise.

## Archivos en este delta
- `package.json`
- `package-lock.json`

## Estado DEP-01/02/03
Los 3 frentes de dependencias quedan cerrados. Frente restante conocido en el proyecto: ninguno abierto en esta auditoría de dependencias.
