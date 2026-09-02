# CHANGELOG v620 — Stock: mismo patrón de vínculo persistente que POS

## Contexto
Después del fix de Productos (v619), se revisó Stock con el mismo
criterio: **el vínculo (token + canal Realtime) debe quedar vivo después
del primer escaneo, y cortarse solo por inactividad o porque el usuario
elige "Cerrar vínculo" a mano** — igual que ya está planteado en el POS
desde el vamos (ver comentario en `pos-scanner-remoto.js`).

Stock ya cumplía la mitad de esto: nunca llamaba a `desvincular()`, así
que el vínculo en sí nunca se cortaba solo. Pero le faltaba la otra
mitad — nunca escondía el modal del escáner al recibir un código, y como
`vc2-overlay` (z-index 1400) es más alto que el modal "Ajustar stock"
(z-index 400), el cartel "Celular conectado" quedaba tapando el modal de
ajuste que se abre automáticamente después de cada escaneo — el usuario
tenía que cerrar el cartel a mano para poder ver el modal de abajo.

## El fix
Al recibir un código en Stock, ahora se llama a
`VincularCelular.ocultar()` (nunca `desvincular()`) antes de buscar el
producto y abrir el modal de ajuste — mismo criterio que Productos:
esconde el modal del escáner, pero el vínculo sigue vivo para el próximo
código. Se agrega también el mismo aviso (toast, una sola vez por sesión
de vínculo) confirmando que el celular sigue conectado.

## Resumen de las 3 pantallas (estado final, todas consistentes)
| Pantalla   | Vínculo persiste tras 1er escaneo | Se corta solo por |
|------------|:---:|---|
| POS        | ✅ (ya lo tenía) | Inactividad o "Cerrar vínculo" |
| Stock      | ✅ (fix v620 — antes ya persistía el vínculo, pero tapaba el modal de ajuste) | Inactividad o "Cerrar vínculo" |
| Productos  | ✅ (fix v619 — antes se desvinculaba solo tras el primer código) | Inactividad o "Cerrar vínculo" |

## Archivo tocado
- `frontend/admin/js/stock-scanner-remoto.js`
