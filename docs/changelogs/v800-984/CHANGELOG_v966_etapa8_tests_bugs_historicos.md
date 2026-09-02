# v966 — Etapa 8 (cobertura de tests vs. bugs históricos), en curso

Siguiendo el plan de 9 etapas de `AUDITORIA_BUGS_v954.md`. Con la Etapa 7
cerrada (v965), se arrancó la Etapa 8: cruzar los hallazgos 🔴/🟠 ya
resueltos en todo el documento contra `tests/` para encontrar bugs
históricos reales sin ningún test de regresión.

Se priorizó por severidad real (no orden de aparición en el documento) y
aparecieron, sin sorpresa, los dos hallazgos 🔴 Crítico de mayor impacto
real:

## Hallazgo — `whatsappHandler` sin ningún test (bug histórico #14, v960)

El endpoint que hasta v960 no tenía **ningún** control de acceso (cualquiera
con la URL podía disparar WhatsApp reales sin login, y de paso elegir de
qué empresa se descontaba el envío) seguía sin cobertura de regresión —
nada impedía que un refactor futuro reintrodujera el mismo agujero sin que
ningún test lo detectara.

Se exportó `whatsappHandler` (antes interna, mismo criterio que
`whatsappEmbeddedSignupHandler`) y se agregó
`tests/handlers/whatsapp-notif-permisos.test.js`:
- 401 sin token / sin usuario autenticado.
- 403 para un rol sin permiso (`chofer`).
- 200 para un rol autorizado (`vendedor`).
- **El caso que importa de verdad**: body con un `empresa_id` de otra
  empresa — se confirma que `obtenerCredencialesWhatsapp` se llama SIEMPRE
  con `perfil.empresa_id` (el de la sesión), nunca con el del body.
- Fail-safe: sin credenciales propias conectadas y con el interruptor
  global apagado, responde `bloqueado: true` sin intentar enviar nada real.
- 400 por falta de `template`/`telefono` (validación existente).

## Hallazgo — `crearDevolucionCore` sin ningún test (bug histórico #0, incidente real v805)

Es la función que causó el incidente real de producción del 17/08/2026:
una devolución de 4.555 unidades de un producto que el cliente había
comprado 42 en total, vinculada a un pedido que ni siquiera lo incluía —
generó stock fantasma y una nota de crédito pendiente por
**~$9.865.288,69**. Es además el punto de alta compartido por la app del
chofer, el alta manual del admin, y desde v955 también la tool de voz del
asistente (`registrar_devolucion_pedido`) — tres superficies de ataque
distintas para el mismo bug si algún día se rompe el control.

Se agregó `tests/repos/crear-devolucion-core.test.js` (8 casos), fijando
como contrato los 3 controles agregados en v805:
1. **Tope contra lo comprado histórico** — reproduce el caso real (42
   comprados, intento de devolver 4.555 → rechazado).
2. **Descuento de lo ya reservado** en otras devoluciones no rechazadas del
   mismo producto+cliente.
3. **Rechazo si el cliente nunca compró** el producto.
4. **Pertenencia al pedido vinculado** — rechaza si el producto no está en
   el `pedido_id` que se pasó (el caso real: "pedido que ni siquiera lo
   incluía").
5. **Precio recalculado server-side**, con pedido vinculado (usa el precio
   real del pedido) y sin él (usa `precio_base` actual) — en ambos casos
   ignora el `precio_unitario` que venga en el body.
6. Camino feliz: dentro de límites, crea la devolución y notifica al admin.
7. Nota de débito a proveedor por `producto_defectuoso` usa el monto
   recalculado (cantidad × precio real), nunca el manipulable del body.

Se mockeó `lib/repos/pedidos.js` completo (`vi.importActual` + overrides
solo de las funciones que toca `crearDevolucionCore`) para no depender de
Supabase real, y se stubearon con mocks mínimos el resto de las ~15
dependencias que arrastra `lib/handlers/pedidos.js` al importarse (ninguna
participa de la lógica bajo test).

## Verificación

```
npx vitest run tests/handlers/whatsapp-notif-permisos.test.js  # 6/6 OK
npx vitest run tests/repos/crear-devolucion-core.test.js       # 8/8 OK
npx vitest run                                                  # suite completa
```

La suite completa (1031 tests) corre con **5 fallos preexistentes, sin
relación con este trabajo**, en `tests/handlers/usuarios.test.js`,
`tests/repos/empresas.test.js` y `tests/repos/migracion.test.js` — tests
desincronizados de la implementación actual:
- Un mock de `lib/repos/usuarios.js` no expone
  `revocarSesionesRefreshTokens` (el handler la llama, el test la mockea
  sin ese export).
- `obtenerDatosEditables` ahora hace `select('..., slug')`, un test todavía
  espera el `select()` sin esa columna.
- Un test de `listarSesionesPorEmpresa` espera `.limit(20)` pero el mock no
  registra la llamada.

No se tocaron en esta pasada — quedan para decidir si es el mock el que
está desactualizado o si hay un bug real detrás.

## Alcance

Etapa 8 queda **en curso, no cerrada**: falta barrer el resto de hallazgos
🟠/🟡 del documento contra `tests/` (esta ronda se priorizó por severidad
real) y resolver los 5 fallos preexistentes encontrados. Sigue en la
próxima sesión.
