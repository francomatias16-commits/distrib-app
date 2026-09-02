# v970 — Verificación dinámica real de Etapa 8 + cierre hallazgo #5 (robots/sitemap)

## Contexto

`v969` no había podido correr `npx vitest run` porque esa sesión no tenía
salida de red (`npm install` devolvía 403). Quedaba pendiente confirmar en
verde de forma dinámica el conteo citado en `AUDITORIA_BUGS_v954.md`
("1095/1095" esperado) y cerrar el hallazgo suelto #5 (robots.txt/sitemap.xml
faltantes).

## 1. Verificación dinámica de la suite completa

Con red disponible en esta sesión:

```
npm install
npx vitest run
```

Resultado: **68 archivos, 1097 tests — 100% en verde.**

El documento decía "1095/1095" esperado; el número real y correcto es
**1097/1097** (2 tests más que la cita original, sin relación con ningún
cambio de código — solo una desactualización menor del número citado en el
documento). Corregido en `AUDITORIA_BUGS_v954.md`.

## 2. Hallazgo #4 revisitado (presupuesto "aceptado" sin pedido) — alcance acotado, no bug activo

Se releyó el bloque completo de aceptación de presupuesto en
`lib/handlers/pedidos.js`. Confirmado: ya existe compensación manual
(`revertirPresupuestoAEnviado`) en los 3 puntos de falla conocidos —
creación del pedido, creación de ítems, reserva de stock. El riesgo real
que queda es más acotado de lo que sugería el comentario original: como no
es transaccional a nivel DB (son pasos secuenciales), solo un
crash/timeout de la función lambda a mitad de camino podría dejar el
presupuesto trabado en `aceptado` sin pedido asociado. No es un bug activo
— es la ausencia de un job de reconciliación de respaldo para ese caso de
borde. Se deja documentado como mejora futura opcional, no como hallazgo
de severidad real.

## 3. Hallazgo #5 cerrado — robots.txt y sitemap.xml

No existían en `frontend/`. Creados:

- **`frontend/robots.txt`**: permite indexar landing, registro, términos,
  privacidad, eliminación de datos y el catálogo público por empresa
  (`/cliente/catalogo`); bloquea admin, portales privados
  (cliente/chofer/proveedor autenticados), scan-pos, superadmin, `/api/` y
  `/frontend/` (paths crudos).
- **`frontend/sitemap.xml`**: URLs estáticas públicas (home, registro,
  términos, privacidad, eliminación de datos). El catálogo público es
  dinámico por empresa (`/cliente/catalogo/:slug`) y no se hardcodea en el
  sitemap estático — queda fuera a propósito.
- **`vercel.json`**: 2 rewrites nuevos, `/robots.txt` → `/frontend/robots.txt`
  y `/sitemap.xml` → `/frontend/sitemap.xml`, mismo patrón que
  `/manifest.json`.

**Pendiente de completar (no se pudo autocompletar):** ningún dominio de
producción está hardcodeado en el repo. Ambos archivos usan el placeholder
`TU-DOMINIO-DE-PRODUCCION` — hay que reemplazarlo por el dominio real antes
de deployar.

## Verificación

- Suite completa (`npx vitest run`): 68/68 archivos, 1097/1097 tests, OK.
- `node --check` sobre `vercel.json` (validación JSON) y sintaxis de los
  rewrites nuevos: OK.

## Con esto

Quedan cerrados los 2 hallazgos sueltos que seguían abiertos de
`AUDITORIA_BUGS_v954.md` (#4 acotado a mejora futura, #5 resuelto salvo el
dominio). Etapa 8 queda formalmente cerrada con verificación dinámica real.
Sigue Etapa 9 (informe final de cierre del plan de 9 etapas).
