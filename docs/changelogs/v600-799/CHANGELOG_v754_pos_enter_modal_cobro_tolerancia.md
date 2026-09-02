# v754 — POS: Enter en el modal de cobro no confirmaba con centavos de diferencia

## Motivo
Prueba en vivo (screenshot real): carrito con Total a cobrar $28.246,24,
cajero tipeó $28.246 en efectivo (nadie paga centavos sueltos), la
"Diferencia" mostrada era $0,24 — dentro de lo normal, el botón
"Confirmar venta ↵" lo hubiese aceptado sin problema. Pero apretando
Enter no pasaba nada, sin error ni aviso.

## Causa (frontend/admin/js/pos.js)
`_intentarConfirmarCobroPorEnter()` tenía su propia validación en vez de
reusar la del botón:

```js
if (Math.abs(pagado - total) < 0.01) { window.confirmarCobro(); }
```

Un centavo de tolerancia (`0.01`), hardcodeado, exigía el monto exacto.
El botón, en cambio, usa `TOLERANCIA_REDONDEO_PAGO = 1` (un peso) y solo
bloquea si el pago **no alcanza** el total por más de esa tolerancia —
permite pagar de más (vuelto), paga a cuenta corriente sin pedir
centavos exactos, etc. Con $0,24 de diferencia el botón confirmaba y
Enter no hacía nada, en silencio — ni siquiera mostraba el mensaje de
error, porque la función de Enter nunca llegaba a esa parte del código.

## Fix
`_intentarConfirmarCobroPorEnter()` ahora llama exactamente al mismo
camino que el botón:

```js
function _intentarConfirmarCobroPorEnter() {
  const btn = document.getElementById('btn-confirmar-cobro');
  if (btn) window.btnAsyncClick(btn, confirmarCobro);
}
```

Mismo `btnAsyncClick` (anti-doble-click, deshabilita el botón, spinner),
misma función `confirmarCobro` con toda su validación real (tolerancia
de redondeo, cuenta corriente, terminal de pago, mensajes de error en
`#pos-cobro-error`). Se eliminó la validación duplicada y desactualizada
— una sola fuente de verdad para "¿este cobro cierra o no?".

## Notas
- No se tocó el chequeo de `esCancelar` (excluir Enter cuando el foco
  está en el botón "Cancelar") ni la detección de modal abierto — eso
  seguía funcionando bien, el problema era solo la tolerancia.
- Verificado: `node --check` sobre pos.js sin errores.
- Con este fix, si el pago no alcanza (por más que la tolerancia de $1),
  Enter ahora sí muestra el mismo error que el botón ("El monto pagado
  no alcanza el total.") en vez de no hacer nada.
