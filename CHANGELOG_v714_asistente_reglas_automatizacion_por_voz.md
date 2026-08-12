# v714 — Nuevas tools `listar_reglas_automatizacion_asistente`,
`crear_regla_automatizacion_asistente`, `editar_regla_automatizacion_asistente`
(Fase B — cierre de `reglas-automatizacion.html`)

## Reportado

Última pieza pendiente de Fase B junto con reglas de precio y campañas de
fidelización (ya cerradas en la misma tanda de trabajo): la fila
`reglas-automatizacion.html` del inventario de §2 del plan estaba en 🔴
("sin ninguna tool"). Los helpers de resolución/armado (`buscarReglaAutomatizacionPorTexto`,
`armarCamposReglaAutomatizacion`, `armarCambiosReglaAutomatizacion`,
`armarAccionRegla`, `armarCondicionRegla`, `describirAccionRegla`,
`describirCondicionRegla`) ya habían quedado escritos al final del
archivo en la sesión anterior, pero sin ninguna entrada en `TOOLS` que
los llamara — y referenciaban dos constantes (`EVENTOS_DISPONIBLES_ASISTENTE`,
`TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE`) que nunca se habían llegado a
definir, así que cualquier intento de usarlas explotaba con
`ReferenceError` en tiempo de ejecución.

## Qué se hizo

- **Definidas las constantes faltantes** (`EVENTOS_DISPONIBLES_ASISTENTE`,
  `EVENTOS_LABELS_ASISTENTE`, `TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE`),
  duplicando exacto los valores de `EVENTOS_DISPONIBLES`/
  `TEMPLATES_WHATSAPP_DISPONIBLES` de `lib/repos/reglas-automatizacion.js`
  (fuente de verdad) — mismo criterio que el resto de catálogos chicos de
  este archivo, que no importa listas del repo sino que las replica en JS
  plano para poder usarlas como `enum` del JSON Schema.
- **`listar_reglas_automatizacion_asistente`**: trae las reglas
  configuradas con evento, condición y acción descriptos en texto plano,
  y si están activas. Roles `dueno`/`admin` — replica exacto el gate
  `puede(perfil,'leer','reglas_automatizacion')` de
  `lib/permisos-service.js`, más restrictivo que reglas de precio (que
  además deja pasar `contador`/`vendedor` en lectura).
- **`crear_regla_automatizacion_asistente`**: arma una regla completa
  (evento disparador + condición simple opcional + una de las 3 acciones
  soportadas por el motor: notificar_push, enviar_whatsapp, crear_tarea)
  reusando `armarCamposReglaAutomatizacion` ya escrito. Roles
  `dueno`/`admin`, `requiereConfirmacion: true` + `resumen()` con el
  mismo patrón que el resto de tools de escritura del archivo.
- **`editar_regla_automatizacion_asistente`**: solo pisa los campos que
  el usuario pidió cambiar (trae la fila actual completa y mergea encima,
  igual que `editar_regla_precio_asistente`), reusando
  `armarCambiosReglaAutomatizacion`.
- **Fix de correctitud en `describirCondicionRegla`**: por voz solo se
  puede crear una condición simple (no se expone combinar con "y"/"o" —
  decisión de scope ya documentada en el código), pero `listar_*` muestra
  reglas reales que pueden haber sido armadas desde el panel con
  `condicion.y`/`condicion.o` (mismo shape que `leerCondicionRegla()` del
  frontend). La versión anterior de la función no contemplaba ese shape y
  hubiera mostrado "siempre (sin condición extra)" en una regla que en
  realidad sí tiene condición — ahora describe también los casos
  combinados, igual que `describirCondicion()` de
  `frontend/admin/js/automatizacion.js`.

No se tocó ningún handler, repo ni migración — las tres tools llaman
directo a `listarReglasAutomatizacion`/`crearReglaAutomatizacion`/
`actualizarReglaAutomatizacion` de `lib/repos/reglas-automatizacion.js`,
que ya estaban importadas en el archivo desde la sesión anterior y no
necesitaron ningún cambio.

## Actualizado en el plan

`PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md` §2: fila
`reglas-automatizacion.html` pasa de 🔴 a 🟢.

## Pendiente de Fase B

Sigue sin tool el último ítem de Fase B: `usuarios.html` (invitar/editar
rol/desactivar usuario del equipo — distinto de `invitar_chofer_nuevo/existente`,
que ya cubre choferes). No se tocó en esta tanda.
