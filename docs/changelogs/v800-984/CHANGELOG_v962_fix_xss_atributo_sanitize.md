# v962 — Fix XSS de atributo en `window.sanitize()` (auditoría de bugs, Etapa 4)

## Hallazgo 🔴 Crítico #17

`frontend/admin/js/ui-utils.js` — `window.sanitize` (alias `window.s`, usada
como `escHtml()` en cada módulo). Es la única fuente de verdad de
sanitización XSS del panel admin: **53 archivos** la usan.

### El problema

```js
// Antes:
window.sanitize = function (str) {
  if (str === null || str === undefined) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
};
```

Este patrón delega en el algoritmo de serialización de **nodo de texto**
del HTML Living Standard, que solo escapa `&`, `<`, `>` (y U+00A0). Las
comillas no hacen falta ahí — un nodo de texto no las necesita.

El problema es que la función se usa por todo el admin para interpolar
valores de usuario **dentro de atributos HTML entre comillas dobles**,
patrón repetido decenas de veces por archivo:

```js
`<button data-nombre="${escHtml(nombre)}">…`
`<img alt="Foto de ${escHtml(nombre)}" …>`
```

Un nombre de producto/depósito/cliente/responsable (campos sin
restricción de caracteres, solo `maxlength`) como:

```
Producto" onmouseover="alert(1)
```

rompía el atributo y quedaba XSS persistente ejecutable con solo pasar el
mouse por encima — para cualquier usuario que viera esa fila, no solo
quien cargó el dato.

Se detectó auditando `frontend/admin/js/stock.js` (`renderTabla`,
`renderAvatarFoto`, `renderTablaDepositosAdmin`), pero el vector real está
en la función compartida, no en Stock específicamente.

### El fix

```js
// Ahora:
window.sanitize = function (str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};
```

Escapado manual, sin depender del DOM. El orden importa: `&` primero, para
no doble-escapar las entidades que agrega el resto de los `.replace()`.
Sigue siendo válida en contexto de texto (las entidades HTML se decodifican
igual al renderizar) y ahora también es segura en contexto de atributo.

Fix centralizado en el único archivo fuente — no hace falta tocar los 53
llamadores uno por uno.

### Tests

`tests/frontend/ui-utils-sanitize.test.js` (nuevo):
- Escapa comillas dobles y simples.
- Sigue escapando `&`, `<`, `>`.
- No doble-escapa el `&` de las propias entidades agregadas.
- `null`/`undefined`/número no rompen.
- `window.s` sigue siendo alias de `window.sanitize`.

El archivo real (`ui-utils.js`) tiene `document.addEventListener(...)` a
nivel de módulo (2 veces), así que el test lo carga en un sandbox `vm` con
un `document` mínimo — no hace falta DOM real para probar `sanitize`, que
ahora es puro string.

### Alcance / qué falta

Este fix cierra el vector en la fuente, pero **no** fue una revisión
exhaustiva de los 53 archivos que llaman a `sanitize()`/`escHtml()` — vale
la pena, en las próximas rondas de auditoría de cada módulo, seguir
verificando que efectivamente envuelvan TODO dato de usuario antes de
interpolarlo (como ya se hizo, por ejemplo, con el hallazgo 🟠 #16 en
`clientes.js`, que era un `innerHTML` sin ningún escapado).

Sigue en curso la auditoría de Stock (Etapa 4): falta revisar a fondo los
`sb.rpc()` de movimientos/transferencia/conteo/producción/ajuste de stock,
`stock-offline.js`, `lib/handlers/stock.js` y `stock-scanner-remoto.js`.
Ver `AUDITORIA_BUGS_v954.md` para el detalle completo y el estado del plan.
