# CHANGELOG v619 — Fix: escáner de producto se desvinculaba tras el primer código

## El problema
En el modal "Nuevo producto", apenas llegaba el primer código escaneado se
llamaba a `VincularCelular.desvincular()` — que **revoca el token en el
servidor y cierra el canal Realtime**, no es un simple "ocultar la
ventanita". Resultado: al escanear el segundo producto de una tanda, el
celular ya no tenía ningún vínculo activo del otro lado y no pasaba nada
(ni el código se cargaba). No era una desconexión de red ni un timeout:
era el diseño original ("un código, listo") que no encajaba con el caso
real de cargar varios productos seguidos.

## El fix
Se cambia `desvincular()` por `ocultar()` al recibir un código: el modal
de "Vincular celular" se esconde de la vista, pero el canal sigue vivo. El
celular queda disponible para seguir escaneando el próximo producto sin
volver a mostrar el QR ni volver a emparejar — se puede repetir el ciclo
"abrir Nuevo producto → escanear → completar/ajustar → guardar" tantas
veces como haga falta.

El vínculo se sigue cerrando solo por:
- Inactividad (el mismo timeout que ya existía en `vincular-celular.js`).
- El usuario tocando "Cerrar vínculo" a mano en el modal, si quiere
  cortarlo antes.

Se agrega también un toast (una sola vez por sesión de vínculo, no en
cada producto) avisando que el celular sigue conectado, para que quede
claro que no hace falta volver a escanear el QR.

## Archivo tocado
- `frontend/admin/js/productos-scanner-remoto.js`

## Notas
No se tocó `vincular-celular.js` ni `stock-scanner-remoto.js` — Stock ya
tenía este comportamiento correcto desde v617 (nunca llamaba a
`desvincular()` entre escaneos), el bug era específico del flujo de
Productos.
