# v803 — Fix 500 al aprobar/rechazar devoluciones (`.catch()` sobre thenable de Supabase)

## Bug

Cualquier aprobación o rechazo de devolución (`revisarDevolucion`) tiraba 500.
Confirmado en logs de runtime de Vercel (correlation_id `9a1c8bf1`):

```
TypeError: calcularScoreClienteRpc(...).catch is not a function
```

## Causa raíz

`calcularScoreClienteRpc()` (lib/repos/pedidos.js:611) devuelve el builder crudo
de `db.rpc(...)`. Ese objeto de `@supabase/postgrest-js` es **thenable**
(implementa `.then()`) pero no una `Promise` real hasta que se pasa por `.then()`
o se hace `await`. No tiene `.catch()` ni `.finally()` propios.

En `revisarDevolucion` (línea ~3004) se le encadenaba `.catch()` directo, sin
`await` ni `.then()` antes:

```js
await calcularScoreClienteRpc({...}).catch(() => {});
```

El `await` esperaba a que se resolviera la expresión completa, pero el error
saltaba antes: `.catch` no existía como método en el objeto devuelto por
`calcularScoreClienteRpc(...)`, así que explotaba en tiempo de armado de la
cadena, no en tiempo de ejecución de la promesa.

Contraste con el otro call site (alta manual, línea ~2728), que sí funciona
porque encadena `.then(() => {})` primero — eso devuelve una Promise nativa
real — y recién ahí `.catch()`.

## Fix

```js
try {
  await calcularScoreClienteRpc({
    p_cliente_id: devolucion.cliente_id, p_empresa_id: empresa_id,
    p_motivo: `devolucion_${estado}`,
  });
} catch { /* best-effort: no debe bloquear la revisión de la devolución */ }
```

Con `await` directo alcanza un `try/catch` normal — sobre un thenable `await`
funciona perfecto, el problema era específicamente encadenar `.catch()` como
método.

## Auditoría del resto del código

Se barrió todo `lib/repos/*.js`, `lib/handlers/*.js` y `lib/*.js` buscando el
mismo patrón (función no-async que devuelve un builder crudo de Supabase
—`.rpc(`/`.from(`— sin pasar por `.then()` antes, más todos los call sites que
le pegan `.catch()` directo sin `await`/`.then()` previo).

**Resultado: `calcularScoreClienteRpc` era el único caso.** No hay otra función
en el repo que devuelva un builder crudo sin `await` ni `.then()` de por medio.
Los demás ~90 usos de `.catch()` detectados en el grep general son sobre:
- `fetch(...).json().catch(...)` (Promise nativa real, no builder de Supabase)
- Funciones `async` que internamente ya usan `await`/`.then()` sobre el builder
  antes de exponerlo
- El caso ya cubierto de línea 2728 (`.then().catch()`)

No se encontró ninguna otra "bomba" del mismo tipo pendiente.

## Archivos modificados
- `lib/handlers/pedidos.js` (línea ~3004, `revisarDevolucion`)
