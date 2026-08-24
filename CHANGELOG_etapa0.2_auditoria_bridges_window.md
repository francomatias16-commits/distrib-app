# Etapa 0.2 — Auditoría automatizada de bridges `window.*` faltantes

## Contexto
Continuación de v798 (bridge faltante en `pedidos.js` → buscador/filtros
rotos). Esa vez la auditoría del resto del admin se hizo a mano. La Etapa
0.2 del Plan de Auditoría Funcional Pre-Lanzamiento 2026 pide automatizar
ese chequeo para que corra en cada distribución.

## Qué se agregó
`scripts/audit-bridges-window.js` — recorre las 71 páginas HTML de los 4
portales (admin/cliente/chofer/proveedor), arma el set de nombres
disponibles en `window` por página (top-level de scripts classic +
`window.X=` explícitos de scripts module) y lo compara contra cada llamada
usada en atributos `on*` — tanto escritas directo en el HTML como armadas
dentro de template strings de JS (filas de tabla, botones dinámicos).

## Corrida contra v815
Primera corrida: 5 posibles bridges rotos en 4 páginas
(`clientes.html`, `comparador-precios.html`, `pedidos.html`,
`riesgo-cheques.html`). Los cinco resultaron **falsos positivos**, por 3
causas distintas en el script, todas corregidas:

1. **Llamadas dentro de `${...}`** (ej. `onclick="algo(${escOnclickArg(nombre)})"`)
   se evalúan en scope JS normal al construir el string, no en scope
   global del navegador — no necesitan bridge. Se excluyen del chequeo.
2. **Comentarios explicativos** que citan el patrón `onclick="funcion(...)"`
   como ejemplo (`clientes.js`, `comparador-precios.js`,
   `riesgo-cheques.js`) se matcheaban como si fueran código real. Ahora se
   descartan líneas/bloques de comentario antes de buscar llamadas.
3. **Palabra reservada `async`** antes de una arrow function
   (`onclick="btnAsyncClick(this, async () => {...})"`) se leía como
   llamada a una función `async`. Se agregó a la lista de palabras
   reservadas ignoradas (junto con `function`, `class`, `catch`, etc.).

Una corrección expuso un caso real de nombre de función **parcialmente**
interpolado (`onclick="exportarExcel_${tipo}('${fecha}')"` en
`reportes-financieros.js` / `reportes-stock.js` / `reportes-ventas.js`):
al quitar `${tipo}` a secas, el prefijo `exportarExcel_` quedaba pegado al
paréntesis siguiente y se leía como llamada a una función inexistente. Se
resolvió insertando un separador no-identificador en el lugar del tramo
interpolado, para que estos casos se traten como "nombre no resoluble
estáticamente" (mismo criterio que la interpolación total) en vez de
generar un nombre inventado.

## Resultado final
```
node scripts/audit-bridges-window.js
Páginas revisadas: 71
Llamadas on* detectadas (HTML + templates JS): 1138
[OK] Ningún bridge roto detectado en los 71 páginas auditadas.
```

## Validación del script (no solo del código auditado)
Test de regresión manual: se borró temporalmente un `window.X=` real
(`window.verCatalogoCliente` en `clientes.js`) y se confirmó que el script
lo detecta correctamente como bridge roto; se restauró el archivo y volvió
a dar 0 roto. Confirma que las correcciones de falsos positivos no
introdujeron un falso negativo.

## Conclusión
**No hay bridges `window.*` rotos en v815.** El script queda listo para
correr en cada distribución futura (`node scripts/audit-bridges-window.js`,
o `--json` para CI, o `--portal=admin` para acotar).
