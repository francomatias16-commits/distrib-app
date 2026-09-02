---
slug: pos-apertura-cierre-caja
categoria: pos
roles: [admin, cliente, proveedor]
---

# Apertura y cierre de caja (turno)

Antes de vender en el POS, tenés que **abrir un turno de caja**. Un turno queda ligado a una caja física (`cajas_pos`) y a la persona que lo abre.

## Cómo abrir un turno

1. Elegí la caja donde vas a trabajar (una empresa puede tener varias cajas, por ejemplo una por depósito o sucursal).
2. Ingresá el **monto inicial**: el efectivo con el que arrancás el turno (fondo de caja).
3. Confirmá la apertura. Desde ese momento, todas las ventas quedan asociadas a ese turno.

## Cómo cerrar un turno

1. Al finalizar el turno, el sistema calcula automáticamente el **monto final calculado**: fondo inicial + ventas en efectivo + ingresos manuales − egresos manuales.
2. Vos ingresás el **monto final declarado**: lo que realmente contaste en la caja.
3. El sistema muestra la **diferencia** entre lo declarado y lo calculado. Si da distinto de cero, puede deberse a:
   - Efectivo mal contado.
   - Un movimiento de caja (ingreso/egreso) no registrado.
   - Una venta cobrada en efectivo que se anotó con otro medio de pago por error.
4. Confirmá el cierre. Una vez cerrado, el turno no admite más ventas.

## Preguntas frecuentes

**¿Puedo tener dos turnos abiertos en la misma caja al mismo tiempo?**
No. Una caja tiene un solo turno activo (estado `abierto`) por vez. Si necesitás que dos personas vendan en simultáneo, usá cajas distintas.

**¿Qué pasa si me olvido de cerrar el turno y sigo vendiendo al otro día?**
Las ventas van a seguir sumando al mismo turno hasta que alguien lo cierre. Conviene cerrar el turno todos los días para que el arqueo de caja sea preciso.

**¿Quién puede ver la diferencia de caja?**
El admin puede revisar todos los turnos y sus diferencias para detectar problemas recurrentes de un cajero o de una caja puntual.
