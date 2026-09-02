# v867 — Fix: avisos de validación (toast) en rojo y más grandes

## Problema
Los avisos tipo "Seleccioná un chofer" (toast sin tipo explícito, usado en
~90% de los mensajes de validación de toda la app: rutas.js, clientes.js,
facturacion.js, etc.) se mostraban en gris/negro con letra chica y pasaban
desapercibidos.

## Causa
El componente de toast está definido en `/shared/tokens.css`, pero
`/shared/reskin-patch.css` redefine las mismas clases con `!important` y se
carga después en las ~78 páginas que lo incluyen — esa era la regla que
realmente ganaba.

## Fix
Se actualizó el estilo del toast "default" (sin `--success`/`--danger`/`--warning`)
en ambos archivos para que se vea en rojo (`--color-danger` / `--color-danger-mid`)
y en negrita, subiendo el tamaño de letra. Al ser un componente global
compartido por `ui-utils.js` (`window.toast`), el cambio aplica automáticamente
a todas las páginas y secciones del admin sin tocar cada llamado individual.

Los toasts ya tipados (`--success` verde, `--danger` rojo, `--warning` naranja)
mantienen su color, pero ahora heredan el mismo tamaño/negrita más grandes.

## Archivos tocados
- `frontend/shared/tokens.css`
- `frontend/shared/reskin-patch.css`
