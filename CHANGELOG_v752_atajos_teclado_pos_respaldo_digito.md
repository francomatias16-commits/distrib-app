# v752 — Atajos de teclado del POS: respaldo con dígito (1-0) cuando la fila F no llega al navegador

## Motivo
Verificación en notebook real de los atajos F1-F10 agregados en v751: la fila
F1-F12 está mapeada de fábrica a funciones de hardware (touchpad, brillo,
volumen, captura de pantalla). El navegador nunca recibe el `keydown` de la
tecla de función — no es un bug de `pos.js`, el evento no llega. `Enter` sí
se registraba bien, porque no está en esa fila.

No hay forma de detectar esto desde JS (el evento no llega), así que la
solución no es "arreglar" la detección sino dar una segunda tecla que sí
llegue siempre.

## Cambio (frontend/admin/js/pos.js)
Cada atajo F1-F10 ahora responde también al dígito de la fila superior con
el mismo número (sin Fn): **1**=Ayuda, **2**=Cobrar, **3**=Descuento,
**4**=Nueva venta, **5**=Buscador, **6**=Cliente, **7**=Movimiento de caja,
**8**=Cerrar caja, **9**=Reporte Z, **0**=Cámara.

- Nueva función `esAtajo(e, teclaF, digito)`: devuelve `true` si `e.key` es
  la F-key, o si es el dígito **y** el foco no está en un campo de texto.
  Los 10 `if` del handler pasaron de `e.key === 'F2'` a
  `esAtajo(e, 'F2', '2')` — misma lógica de cada bloque sin tocar, solo
  cambió la condición de entrada.
- Nueva función `enCampoDeTexto()`: extraída del chequeo que ya usaban
  Supr/Backspace y +/- (estaba duplicado inline en los dos), ahora la
  reusan esos dos bloques más `esAtajo()`.
- El dígito **solo** dispara el atajo si el foco no está en un
  input/textarea/contenteditable — si el cajero está tipeando un código de
  barras, una cantidad o un % de descuento, los números se escriben como
  texto normal, no accionan nada. Las F-keys siguen sin esa restricción
  (igual que antes: no escriben texto, no hace falta excluir inputs).
- `Enter` no se tocó — sigue exactamente igual que en v751 (confirma cobro
  dentro del modal, agrega producto en el buscador).

Se optó por **agregar** el respaldo en vez de reemplazar F1-F10 por los
dígitos: en teclados donde la fila F sí funciona, seguir andando igual que
antes; en los que no, el número de arriba es el atajo real.

## UI (frontend/admin/pos.html)
- Tooltips y hints actualizados para mostrar ambas teclas: "F7 o 7",
  "F2 / 2", etc. (quickbar, botón Cobrar, accesos rápidos, elegir cliente,
  cerrar caja, cámara, botón Atajos).
- Modal de ayuda (`#modal-atajos-overlay`): tabla con las dos teclas por
  fila (`F2 / 2`, etc.) y nota explicando cuándo usar el dígito en vez de
  la F-key.

## Notas
- Verificado: `node --check` sobre pos.js sin errores.
- No se modificó ninguna función de acción (abrirModalCobro, vaciarCarrito,
  etc.), solo la condición de entrada de cada atajo y las dos funciones
  helper nuevas.
- Pendiente (no bloqueante): confirmar en la notebook donde falló F1-F10
  que ahora 1-0 dispara cada acción correctamente, y que tipear un código
  de barras o una cantidad con dígitos no dispara ningún atajo por error.
