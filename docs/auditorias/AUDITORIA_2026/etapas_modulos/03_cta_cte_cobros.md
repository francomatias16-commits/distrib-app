# Etapa 3 — Cta. cte. y cobros

**Flujo auditado:** `frontend/admin/cta-cte.html` + `frontend/admin/js/cta-cte.js`
(listado/KPIs vía `fn_cta_cte_kpis`/`fn_cta_cte_lista`, cobro vía
`registrar_cobro_completo`, estado de cuenta por email vía
`lib/handlers/notif.js:handleEstadoCuenta`).

**Lo que ya estaba bien** (se verificó, no se tocó): `registrar_cobro_completo`
ya fuerza `p_usuario_id`/valida `p_empresa_id` contra `get_empresa_id()`
para callers no-`service_role` (fix SEC-009); `fn_cta_cte_kpis`/`fn_cta_cte_lista`
filtran correctamente por `get_empresa_id()` y usan parámetros bindeados
(sin riesgo de inyección pese al `ILIKE ... || p_busqueda ||`); RLS de
`cta_cte` sin agujeros (ya verificado en sesión 3 de la auditoría de
seguridad).

---

## 🟡 Hallazgo 1 — El envío de estado de cuenta por email no tiene rate limit

**Lo que encontré:** `handleEstadoCuenta` (mismo archivo que maneja
WhatsApp y push) envía un email real por Resend — con costo por envío,
igual que WhatsApp — pero, a diferencia de `limiterWhatsApp` (10/min) y
`limiterPush` (30/min) que sí protegen esos otros canales en el mismo
archivo, este endpoint no tenía ningún límite. Un usuario con rol
`vendedor`/`contador` (roles permitidos) podía reenviar estados de cuenta
sin freno.

**Severidad:** media — no es una brecha de datos, es costo/abuso.

**Fix aplicado (código, pendiente de deploy):** `limiterEstadoCuenta`
(10/min, mismo criterio que WhatsApp) agregado a `lib/handlers/notif.js`.

---

## 🟡 Hallazgo 2 — El fallback de cta_cte trunca en 1000 facturas sin avisar

**Lo que encontré:** `cargarCtaCteFallback()` (solo se activa si
`fn_cta_cte_kpis`/`fn_cta_cte_lista` no están disponibles) trae como
máximo 1000 facturas impagas via REST directo. Para una empresa con más
deuda acumulada que eso, los KPIs y el listado quedarían silenciosamente
incompletos, sin ningún aviso.

**Severidad:** media-baja — camino de fallback, poco frecuente.

**Fix aplicado (código, pendiente de deploy):** aviso en consola cuando
se llega al techo de 1000, para que quede detectable en vez de silencioso.
No se subió el límite ni se paginó el fallback en esta pasada — si se
usa seguido conviene resolverlo de fondo en vez de solo loguearlo.

---

## Revisión adicional de interfaz (frontend/admin/js/cta-cte.js)

### 🔴 Hallazgo 3 — El campo de "email manual" en el modal de estado de cuenta no hacía nada

**Lo que encontré:** cuando un cliente no tiene email cargado, el modal de
"Enviar estado de cuenta" muestra un aviso — *"Este cliente no tiene email
registrado. Podés ingresar uno abajo para este envío puntual."* — y deja
escribir un email ahí mismo, con validación de formato incluida. El propio
código lo arma y lo manda al backend como `email_override`. Pero
`handleEstadoCuenta` (`lib/handlers/notif.js`) nunca leía ese campo del
body: usaba siempre `cliente.email` de la base. Resultado real: para un
cliente sin email cargado, el envío fallaba con "El cliente no tiene email
registrado" **sin importar lo que el usuario escribiera** en el campo que
la propia pantalla le ofrece llenar para resolver justo ese caso. Es una
función que se ve, se puede usar, parece funcionar (no tira error de
"campo no soportado") y no hace absolutamente nada.

**Severidad:** alta — no es solo un mensaje confuso, es una función
completa que nunca funcionó, en un flujo de cobranza real.

**Fix aplicado (código, pendiente de deploy):** `handleEstadoCuenta` ahora
lee `email_override`, lo valida server-side, y lo usa como destinatario
real cuando viene informado — incluso si el cliente no tiene email en su
ficha. Se registra en `email_log` el email efectivamente usado.

---

## Resumen de la etapa

| Hallazgo | Severidad | Estado |
|---|---|---|
| 1 — Sin rate limit en envío de estado de cuenta por email | 🟡 Media | ✅ Corregido (código, pendiente de deploy) |
| 2 — Fallback de cta_cte trunca en 1000 sin avisar | 🟡 Media-baja | ✅ Corregido (código, pendiente de deploy) |
| 3 — Campo de email manual en modal de estado de cuenta no tenía efecto real | 🔴 Alta | ✅ Corregido (código, pendiente de deploy) |

Sin migraciones SQL — los tres fixes son de código, nada que aplicar
directo en Supabase.
