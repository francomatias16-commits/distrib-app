# v715 — Reconciliación de `PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md` con
el estado real del código (sin cambios en `lib/asistente-tools.js`)

## Reportado

`CHANGELOG_v714` había dejado un solo pendiente explícito de Fase B:
`usuarios.html` (invitar/editar rol/desactivar usuario del equipo). Al
retomarlo, la revisión de `lib/handlers/usuarios.js` mostró que **no es
una tarea sin hacer**: es una decisión de diseño ya tomada, con un
comentario extenso en `lib/asistente-tools.js` (sección de
`consultar_usuarios_equipo`) que preexiste a todo este plan — confirmado
comparando contra la copia del repo anterior a esta tanda de trabajo
(`extracted_v713/lib/asistente-tools.js`, mismo comentario, mismo lugar).

El plan nunca reflejó esa decisión: seguía listando `usuarios.html` como
brecha pendiente de Fase B, contradiciendo el propio código.

Al auditar esa única fila se encontraron además **cinco filas más de la
tabla de §2 desactualizadas** respecto al archivo real
(`asistente-tools__4_.js`, 5587 líneas — la copia de trabajo con todo lo
cerrado en sesiones anteriores, no la del zip `distrib_v713` que es
anterior):

- `clientes.html` — ya tenía `editar_cliente_asistente` y
  `dar_de_baja_cliente_asistente`, seguía marcada 🟡.
- `reglas-precio.html` — ya tenía `crear_regla_precio_asistente` y
  `editar_regla_precio_asistente`, seguía marcada 🟡.
- `fidelizacion.html` — ya tenía `crear_recompensa_asistente` y
  `editar_recompensa_asistente`, seguía marcada 🟡 ("falta crear/editar
  campaña" — nombre de entidad desactualizado, el repo real trabaja con
  recompensas, no campañas).
- `cta-cte.html` / `compras.html` — Fase A, ítems 1 y 4, ya estaban ✅ en
  el propio §5 pero la tabla de §2 los seguía marcando 🟠.
- `facturacion.html` — la más importante de encontrar: `emitir_factura`
  y `anular_factura` **ya existían antes de escribir este plan**
  (confirmado también contra `extracted_v713`). El ítem 3 de Fase A
  nunca fue una brecha real, fue un error de diagnóstico del inventario
  original.
- `automatizacion.html` / `reglas-automatizacion.html` — estaban
  separadas en dos filas de la tabla como si fueran dos páginas
  distintas; son la misma página física (`frontend/admin/automatizacion.html`),
  con la sección "reglas personalizadas" llamando a
  `/api/reglas-automatizacion`. Se fusionaron en una sola fila.

## Qué se hizo

Solo se tocó `plan.md` — ningún cambio en `lib/asistente-tools.js` ni en
ningún handler/repo:

- Agregado el símbolo ⚪ ("excluido a propósito") a la convención de la
  tabla de §2, para distinguir "brecha sin resolver" de "decisión ya
  tomada de no exponerlo" — antes ambos casos se mezclaban bajo 🟡/🔴.
- `usuarios.html` pasa de 🟡 a ⚪, con la razón documentada en una nueva
  entrada de §4 (Exclusiones explícitas), citando el mismo razonamiento
  que ya está en el comentario de `asistente-tools.js`: no hay ninguna
  acción "inocente" que separar del resto de la superficie de escritura
  de esa pantalla (alta con contraseña, escalación de rol, corte de
  acceso).
- Las seis filas desactualizadas de §2 corregidas a su estado real
  (🟢 en todos los casos, con nota de qué tool cubre cada una).
- Fase A y Fase B marcadas explícitamente `✅ cerrada` en §5, con el
  ítem 3 de Fase A (emitir/anular factura) corregido para explicar que
  el diagnóstico original estaba mal, no que se haya cerrado en esta
  tanda.
- Checklist de §6, ítem 1: dividido en dos — la parte de "sin filas 🟠"
  ya se puede marcar `[x]`; la parte de "🔴 solo en exclusiones" queda
  `[ ]` porque `liquidacion.html` sigue en 🔴 sin decisión, y no
  pertenecía al backlog de Fase A/B de este plan (no se inventó una
  decisión para esa fila).

## Pendiente

- `liquidacion.html`: única fila de la tabla de §2 sin resolver ni
  excluir — decidir en la próxima sesión si se suma como Fase D o se
  agrega a §4.
- Los ítems de Fase A siguen sin la prueba funcional contra datos reales
  (sin credenciales de Supabase en este entorno) — no cambia con esta
  reconciliación, sigue anotado en §6.
