# CHANGELOG v601 — Fase 7: cierre de los 11 handlers "chicos" (repos dedicados)

## Contexto

La Auditoría UX 2026 / Fase 7 había migrado 22 handlers a repos dedicados en
`lib/repos/`, dejando pendientes 11 handlers "chicos" que todavía accedían
a Supabase directo (`.from()` / `.rpc()`) desde el propio handler. Este
paquete cierra los 11 que quedaban:

| Handler                | Usos directos migrados | Repo nuevo                        |
|-------------------------|:----------------------:|------------------------------------|
| setup.js                | 4                       | `lib/repos/setup.js`               |
| auto-imagenes.js        | 6                       | `lib/repos/auto-imagenes.js`       |
| busqueda.js              | 6                       | `lib/repos/busqueda.js`            |
| fidelizacion.js          | 6                       | `lib/repos/fidelizacion.js`        |
| importar.js              | 5                       | `lib/repos/importar.js`            |
| auditoria.js             | 4                       | `lib/repos/auditoria.js`           |
| piloto.js                | 12                      | `lib/repos/piloto.js`              |
| export-contable.js       | 8 (+1 en módulo dependiente) | `lib/repos/export-contable.js` |
| ciclos.js                | 10                      | `lib/repos/ciclos.js`              |
| asistente.js             | 8                       | `lib/repos/asistente.js`           |
| saas.js                  | 16                      | `lib/repos/saas.js`                |

`lib/repos/` pasa de 22 a 33 archivos. Los 11 handlers quedan con la misma
regla de negocio de siempre (auth, permisos, armado de respuesta) — solo
cambia dónde vive el I/O contra Supabase.

## Detalle por handler

- **setup.js**: repo nuevo con `verificarConexionSupabase`, `contarEmpresas`,
  Auth Admin API (`crearUsuarioAuth`/`eliminarUsuarioAuth`) y el RPC
  `setup_inicial_empresa`.
- **auto-imagenes.js**: se sumó `obtenerEmpresaYRolPorAuthId` a
  `repos/usuarios.js` (reusable por otros handlers que resuelven perfil
  desde el token) y un repo nuevo para el contador de uso de APIs externas
  (`contador_uso_apis` / RPC `fn_incrementar_contador_api`). Quedan sin
  tocar el Storage API (`.storage.from()`) y `Buffer.from` — mismo criterio
  ya aceptado para `portal_proveedor.js`.
- **busqueda.js**: repo con las 5 búsquedas en paralelo (clientes, pedidos,
  presupuestos, facturas, cheques) — la de productos ya vivía en
  `repos/productos.js` desde Fase 7 y no se duplicó.
- **fidelizacion.js**: repo con resolución de usuario/cliente por sesión,
  catálogo de recompensas, saldo de puntos y el RPC `canjear_recompensa`.
- **importar.js**: repo con el RPC de upsert masivo, `conciliar_recepcion`
  y el insert de recepción borrador. `Buffer.from` no es Supabase, queda
  igual.
- **auditoria.js**: repo con empresas activas, upsert/listado de anomalías
  revisadas y el RPC de detección. **Nota**: el handler que se venía
  editando había quedado con 4 usos de una variable `sb` que ya no existía
  en el archivo (bug real, no solo pendiente de migrar) — se reemplazaron
  los 4 por las funciones del repo.
- **piloto.js**: el más grande de los "medianos" — repo con empresas
  activas, los 2 RPCs de generación de sugerencias, pedidos sugeridos
  (listar/contar/confirmar/descartar), ciclos de compra y el log de
  WhatsApp saliente.
- **export-contable.js**: repo con config, historial, comprobantes
  contables (vista por tipo) y el caso especial de cobranzas. Además se
  encontró que `lib/export-contable/index.js` recibía el cliente Supabase
  crudo como parámetro (`params.supabase`) para leer `cobros` directo — se
  migró también a `listarCobrosParaExport()` del repo nuevo, así que ya no
  hace falta pasar el cliente por los formateadores de proveedor.
- **ciclos.js**: repo con ciclos activos por cliente, pedido sugerido
  reciente, última notificación, datos de cliente, los 2 RPCs de
  generación/registro de sugerencia manual, items de pedido y descarte.
- **asistente.js**: ya usaba el cliente compartido `db` (no uno propio),
  pero accedía a tablas directo desde el handler. Repo con límite de uso,
  conversaciones/mensajes (resolver, historial, guardar, tocar) y el RPC
  de búsqueda semántica `buscar_articulos_asistente`. `db` se mantiene
  importado solo para `verificarToken(req, db)`, mismo criterio que el
  resto de los handlers migrados.
- **saas.js**: el más grande de los 11 (16 usos). Repo con la config SaaS,
  los 10 RPCs de administración (KPIs, panel, config, confirmar pago,
  reactivar, suspender, cancelar, cambiar precio, reset/snapshot de demo,
  resumen de migraciones) y el listado paginado de `eventos_negocio`. Se
  sumó `obtenerPerfilConEmpresa` a `repos/usuarios.js` (necesita el join a
  `empresas(nombre)` para el gate de superadmin/dueño de la empresa raíz,
  distinto de `obtenerEmpresaYRolPorAuthId` que ya usan otros handlers).

## Validación

Los 22 archivos tocados (11 handlers + 11 repos nuevos, más
`repos/usuarios.js` y `export-contable/index.js`) pasan `node --check` sin
errores. Grep de verificación sobre los 11 handlers confirma cero
`.from()`/`.rpc()` directos remanentes (las únicas excepciones son
`Buffer.from` y `.storage.from()`, ya aceptadas como no-Supabase-tabla).

## Estado de la Fase 7

Con este paquete, los 33 handlers auditados (22 + 11) tienen su acceso a
datos migrado a `lib/repos/`. No quedan handlers pendientes de este
workstream.

---
MF Web Solutions | distrib-app
