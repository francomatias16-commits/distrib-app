# v779 — Fix: Store de MP rechazada por `state_name` mal casado + mejor mensaje de error

## Contexto
Con los fixes de v773 (coordenadas) y v777 (external_id/store_id numérico
de la caja) probados en producción, volvió a aparecer el error genérico de
siempre en la creación de la Store: "Mercado Pago rechazó los datos de la
sucursal. Revisá dirección/ciudad/provincia." — con una dirección real
(Olessio 1186, Reconquista, Santa Fe) que a simple vista se ve válida.

## Causa
La doc oficial de "Crear sucursal" documenta un error específico:
`validation_error: location.state_name was invalid`. MP valida
`state_name` contra su propio listado de provincias/jurisdicciones
argentinas, matcheo que no perdona mayúsculas — el campo "Provincia" del
formulario es texto libre, y en la prueba se había cargado "Santa fe" (con
"f" minúscula) en vez de "Santa Fe". Ese desajuste alcanza para el
bad_request.

Encima, el mensaje de error que devolvía el panel era siempre el mismo
genérico sin importar la causa real — quedaba imposible de diagnosticar
sin mirar los logs de Vercel a mano.

## Fix
1. **Normalización server-side** (`posQrSetupHandler`,
   `lib/handlers/pagos.js`): antes de armar el payload de la Store,
   `provincia` se matchea contra el listado real de las 24 jurisdicciones
   argentinas ignorando mayúsculas/acentos (`_normalizarProvinciaAR`) y se
   manda con el casing exacto que usa MP; `calle`/`ciudad` se pasan por
   Title Case (`_capitalizarPalabras`). Esto corrige el problema sin
   depender de que el usuario tipee bien, y protege a cualquier otro
   caller futuro del endpoint (asistente por voz, etc.), no solo al
   formulario.
2. **Selector de provincia en el frontend** (`mercadopago-config.html`):
   el campo "Provincia" pasó de `<input type="text">` a un `<select>` con
   las 24 jurisdicciones — saca de raíz la posibilidad de typo/casing en
   el origen. `configurarQr()` no necesitó cambios (`.value.trim()`
   funciona igual sobre un `<select>`).
3. **Mensaje de error con el detalle real de MP**: tanto en la creación de
   Store como de POS, si `err.responseBody.message` viene con un texto
   legible de MP, ahora se agrega al mensaje que ve el usuario (acotado a
   140 caracteres) en vez de mostrar siempre la misma frase genérica.
   Esto también sirve para diagnosticar sin depender de mirar los logs.

## Pendiente
- Falta confirmar en producción que la Store se crea con "Santa Fe" bien
  casado.
- El error de MP mencionaba también que `state_name` puede fallar si "no
  corresponde a la ciudad previamente definida" — sugiere que MP valida
  la combinación ciudad+provincia contra su propio diccionario geográfico,
  no solo el nombre de provincia aislado. Si vuelve a fallar con una
  ciudad+provincia real que sí coincide en el listado, ese sería el
  próximo sospechoso — no se pudo confirmar sin acceso a la respuesta real
  de MP (por eso el punto 3 del fix, para verla la próxima vez sin
  depender de mí).
