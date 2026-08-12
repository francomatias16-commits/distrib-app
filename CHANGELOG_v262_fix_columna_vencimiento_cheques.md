# v262 — Fix: alerta de cheques vencidos usaba la columna equivocada

## Bug encontrado
La alerta de "cheques vencidos" (v261) filtraba/ordenaba por la columna
`vencimiento`. Se detectó que esa columna **no es la canónica**:

- `fecha_vto` es la columna real: `NOT NULL`, con índice, y es la que usa
  `migracion_confirmar_cheques_lote()` (migración 174, wizard de migración
  masiva) al insertar cheques — ese INSERT nunca completa `vencimiento`.
  También es la que usa el cron de notificaciones (ver comentario en
  `scripts/test-integration.js`: "columna real es fecha_vto, no vencimiento").
- `vencimiento` es un alias legible que solo mantiene sincronizado a mano
  `cheques.js` (la UI manual de carga de cheques, uno por uno). No hay
  trigger de la base que la sincronice automáticamente con `fecha_vto`
  (a diferencia de `facturas`, que sí tiene ese trigger desde la
  migración 094).

Impacto confirmado contra la base real: 5 cheques ya tienen `vencimiento`
en NULL con `fecha_vto` cargado (los 5 entraron por el wizard de
migración). Ninguno está vencido todavía (`en_cartera` + `fecha_vto` en el
pasado) a la fecha de este fix, pero apenas uno lo esté, la alerta v261 no
lo iba a mostrar.

## Fix — `lib/handlers/admin.js`
- La query de detalle (hasta 5 cheques) y la de resumen agregado ahora
  filtran y ordenan por `fecha_vto` en vez de `vencimiento`.
- El cuerpo del mensaje sigue mostrando la fecha "amigable":
  `c.vencimiento || c.fecha_vto` (en la práctica van a coincidir siempre
  que `vencimiento` esté cargado).

## No incluido en este fix (decisión explícita)
- **No se deprecó `fecha_vto`** — es la columna que hay que conservar.
- No se agregó (todavía) un trigger de sincronización `vencimiento` ↔
  `fecha_vto` para `cheques` como el que ya existe para `facturas`
  (migración 094). Sería la forma más robusta de cerrar esto de raíz —
  cualquier código nuevo que solo escriba una de las dos columnas volvería
  a generar el mismo tipo de bug. Queda como mejora pendiente, a evaluar
  aparte por ser un cambio de esquema en producción.

## Verificación
- `node --check` sobre `admin.js`: OK.
- Confirmado contra la base real que la query por `fecha_vto` trae los
  mismos 6 cheques vencidos de la empresa de prueba que antes, y que
  ahora también alcanzaría a los 5 casos con `vencimiento` NULL si
  llegaran a vencer estando `en_cartera`.
