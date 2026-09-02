# v698 — Estado vacío diferenciado en Conversaciones WhatsApp

## Contexto (continuación de la sesión anterior)

La sesión anterior había descartado bug de RLS/vista/permisos: `v_whatsapp_conversaciones_activas`
devuelve el dato correcto bajo simulación exacta de la sesión de Marina (empresa
"Distribuidora del Litoral S.A."). Quedó pendiente explicar por qué la página se
sentía como "no carga nada".

## Diagnóstico ampliado

Se cruzaron las 4 empresas activas contra `empresa_whatsapp`:

| Empresa | waba_id | Conversaciones |
|---|---|---|
| del sol srl | null (no conectado) | 0 |
| Distri romano | null (no conectado) | 0 |
| **Distribuidora del Litoral S.A.** | `CASO-WABA-000001` (dato de prueba, no viene de ningún seed/migración del repo) | 1 |
| Distribuidora Demo S.A. | null (no conectado) | 0 |

Marina (rol `admin`) tiene permiso de lectura sobre `empresa_whatsapp` vía
`v_empresa_whatsapp_estado` (policy solo permite `dueno`/`admin`).

3 de las 4 empresas nunca completaron el WhatsApp Embedded Signup — la tabla
vacía es el comportamiento correcto para ellas, pero el mensaje genérico
"Sin conversaciones para los filtros actuales" no lo comunica, y se puede leer
como si la página no hubiera cargado nada.

## Cambio

`frontend/admin/js/whatsapp-conversaciones.js`:
- Nueva función `cargarEstadoWhatsapp()`: consulta `v_empresa_whatsapp_estado`
  al iniciar (antes de `cargarConversaciones()`). Si el rol del usuario no
  tiene policy de lectura ahí (vendedor/chofer/etc.), `waEstado` queda
  `'desconocido'` y no se afirma nada — se mantiene el mensaje genérico.
- `renderTabla()`: cuando la tabla queda vacía **sin filtros activos** y
  `waEstado === 'no_conectado'`, muestra "WhatsApp no está conectado todavía
  para esta empresa." con link a `/admin/whatsapp-onboarding`. En cualquier
  otro caso (hay filtros, o sí está conectado, o es `'desconocido'`) se
  mantiene el mensaje "Sin conversaciones para los filtros actuales" de siempre.

## Pendiente / a decidir

- El dato `CASO-WABA-000001` / `CASO-PHONEID-000001` en "Distribuidora del
  Litoral S.A." no está en el repo — quedó insertado directo en Supabase en
  algún momento anterior (probablemente para simular a Marina en una sesión
  de testing). Cuando quieras, lo borro o lo dejo — avisame.
