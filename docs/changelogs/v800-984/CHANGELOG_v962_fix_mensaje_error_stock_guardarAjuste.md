# v962 — Fix mensaje de error engañoso en `guardarAjuste()` (auditoría de bugs, Etapa 4 — Stock)

## Hallazgo 🟡 Medio #18

`frontend/admin/js/stock.js` — `guardarAjuste()` (modal único de
ingreso/egreso/transferencia/ajuste/producción, línea ~1354).

### El problema

Cada rama de `guardarAjuste()` (`transferir_stock`, `registrar_conteo_stock`,
`producir_con_insumos`, `ajustar_stock`) ya maneja bien sus dos casos
esperados:

- Error de red → se detecta con `esErrorDeRed(error)` y se encola offline
  vía `window.StockOffline`.
- Rechazo de negocio (stock insuficiente, conflicto de conteo, etc.) →
  `data.ok === false`, se muestra `data.error` (mensaje específico del
  backend).

Pero cualquier excepción que no encajara en ninguna de esas dos rutas —un
error de sintaxis del propio JS, un `throw error` de Supabase que no sea de
red (permiso RLS denegado, columna inexistente, timeout distinto a network
error, etc.)— caía en el `catch` final de la función, que mostraba siempre:

```
No se pudo guardar el movimiento por un problema de conexión.
```

sin importar cuál fuera la causa real. Un usuario viendo ese mensaje
reintentaba pensando que era su conexión a internet, cuando el problema
podía ser, por ejemplo, un permiso mal configurado — algo que ningún
reintento iba a arreglar. Del lado de soporte tampoco había forma de
distinguir el caso real sin pedirle al usuario que abra la consola del
navegador.

### El fix

El mensaje genérico del `catch` final ya no da por sentado que es un
problema de red — deja explícito que puede no serlo y orienta a pedir
ayuda si persiste, en vez de sugerir "reintentá, es tu conexión":

```js
} catch (err) {
  console.error(err);
  toast('No se pudo guardar el movimiento. Probá de nuevo en unos segundos; si persiste, avisá a soporte.');
}
```

El `console.error(err)` ya existía y se mantiene — es lo que le permite a
soporte pedir el log real de la consola en vez de asumir a ciegas que fue
un corte de red.

### Alcance

Con este fix, junto con el 🔴 #17 (`window.sanitize` en atributos) resuelto
en la misma ronda, la Etapa 4 — Stock (frontend) queda cerrada. Ver
`AUDITORIA_BUGS_v954.md` para el detalle completo y el estado del plan.
