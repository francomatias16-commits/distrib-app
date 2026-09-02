# Machete — Pendientes por medio de pago en el POS

Referencia rápida de qué le falta a cada integración de cobro del POS
(Admin → Hardware → Terminal de pago) para quedar al mismo nivel que
las demás. Ordenado de más maduro a menos maduro.

---

## 1. Mercado Pago QR (`mp_qr`) — el más completo

**Estado:** funcional de punta a punta. Token cifrado en backend
(`crypto-secrets.js`), nunca viaja al frontend. El POS solo pide
`_svc=pos-qr-cobrar` / `pos-qr-verificar`, pollea y listo.

**Pendiente:**
- Ninguno funcional. Es el patrón de referencia que se copió para Prisma.

---

## 2. Prisma / Paystore terminals (`prisma`)

**Estado:** integración real contra la API documentada (v763), mismo
patrón que MP QR — token cifrado, backend-mediado, nunca expuesto al
frontend.

**Pendiente:**
- **Enum completo de estados finales sin confirmar.** Se asume
  `APPROVED / PAYMENT_APPROVED / CONFIRMED` como aprobado y
  `REJECTED / PAYMENT_REJECTED / DECLINED / CANCELLED / EXPIRED` como
  rechazado — son los nombres más probables, no confirmados contra la
  doc real. Hay que correr un cobro real en sandbox y loguear la
  respuesta cruda para cerrar la lista.
- **Body de `PUT .../cancellations` sin confirmar** — se manda sin
  body, solo con los query params ya usados en el resto del flujo.
- **Sin endpoint de refresh de token.** El token de Prisma expira
  (~1h en sandbox); por ahora se repega a mano desde Admin → Hardware
  cada vez que vence. No hay renovación automática (OAuth2
  client_credentials u otro).
- **Host de producción sin confirmar** — debería ser el mismo sin
  `-sandbox`, pero falta validarlo contra el catálogo antes de ir a
  producción real.
- **`PRISMA_SUBNET_ACQUIRER_ID` de producción sin confirmar** (se sabe
  que sandbox=1, homologación=9, producción=2, pero falta el caso real).

---

## 3. Mercado Pago Point (`mp_point`)

**Estado:** funciona (API de Intents oficial de MP), pero con un patrón
de seguridad **distinto e inferior** al de QR/Prisma — vale la pena
unificarlo.

**Pendiente:**
- **El access_token viaja al frontend y se guarda en texto plano.**
  A diferencia de MP QR y Prisma (token cifrado en el backend, jamás
  visible desde el navegador), acá `mp_access_token` se guarda tal
  cual dentro de `empresas.config.pos_hardware.terminal` — sin pasar
  por `crypto-secrets.js` — y se lo devuelve en texto plano a
  **cualquier rol de venta** que abra Admin → Hardware (`GET
  /api/pos/config-hardware` no filtra ese campo). Cualquier cajero con
  acceso a esa pantalla puede leer el token completo de la cuenta MP.
- El frontend llama directo a `api.mercadopago.com` desde el navegador
  del cajero (no hay backend intermediario) — funcional, pero significa
  que el token de producción de MP queda expuesto en el tráfico de red
  de cada caja, no solo en el storage.
- **Recomendación:** migrar este driver al mismo patrón que `mp_qr` /
  `prisma` — guardar el token cifrado en `integraciones_pago` (ya existe
  la tabla, ya soporta múltiples `proveedor`) y mediar el cobro por el
  backend en vez de pegarle a la API de MP directo desde el navegador.

---

## 4. Getnet (Santander) (`getnet`)

**Estado:** **integración no implementada.** Solo existe el
`intentUri` (`getnet://payment?...`) que abre una app companion en
Android, y aun así el resultado del cobro se termina confirmando **a
mano** con el mismo diálogo manual que el driver "Manual" — no hay
ninguna llamada de verificación real. Sin `getnet_pos_id` configurado,
directamente cae al diálogo manual.

**Pendiente (todo):**
- No hay backend (`lib/handlers/pagos.js` no tiene ningún `_svc=getnet-*`).
- No hay confirmación automática del resultado — el cajero tipea
  "Aprobado"/"Rechazado" igual que si no hubiera integración.
- Habría que definir con qué API de Getnet integrar (REST del lado
  backend, o SDK nativo si el POS corre en tablet Android) y replicar
  el patrón cobrar→pollear→verificar que ya tienen QR y Prisma.
- Hoy el campo "POS ID de Getnet" en Admin → Hardware genera una falsa
  sensación de que está configurado cuando en la práctica no cambia el
  comportamiento (sigue siendo manual).

---

## 5. Naranja X (`naranja`)

**Estado:** **integración no implementada — driver que solo hace de
alias del manual.** El código lo dice explícitamente: *"Por ahora
fallback manual — la integración completa de Naranja requiere servidor
intermediario para no exponer el token en el frontend"*.

**Pendiente (todo):**
- No hay backend (`lib/handlers/pagos.js` no tiene ningún `_svc=naranja-*`).
- No hay generación de QR dinámico ni polling — pese a que el selector
  de Admin → Hardware lo describe como "Integración via QR dinámico"
  y pide un token, ese token no se usa para nada todavía.
- Falta decidir la arquitectura (server intermediario, igual criterio
  que MP QR/Prisma) antes de escribir el handler.
- Mismo problema de expectativa falsa que Getnet: el campo "Token de
  integración Naranja X" en el formulario sugiere que está activo
  cuando en la práctica el cobro sigue siendo 100% manual.

---

## 6. Manual (`manual`)

**Estado:** completo por definición — es el fallback universal
(diálogo donde el cajero confirma a mano). No requiere nada.

---

## Resumen — qué hace falta para "100% sincronizado"

| Driver    | Backend real | Token cifrado | Verificación automática | Pendiente principal |
|-----------|:---:|:---:|:---:|---|
| MP QR     | ✅ | ✅ | ✅ | — |
| Prisma    | ✅ | ✅ | ✅ | confirmar enum de estados + refresh de token |
| MP Point  | ⚠️ (llama a MP directo desde el navegador) | ❌ | ✅ | cifrar/migrar token al backend |
| Getnet    | ❌ | ❌ | ❌ | no existe integración real, todo por hacer |
| Naranja X | ❌ | ❌ | ❌ | no existe integración real, todo por hacer |
| Manual    | — | — | — | completo (es el fallback) |

**Prioridad sugerida:**
1. **MP Point → cifrar el token** (gap de seguridad real, activo hoy en
   producción si algún cliente lo usa).
2. **Prisma → primer cobro real en sandbox** para cerrar el enum de
   estados (lo único que falta para darlo por terminado).
3. **Getnet / Naranja X** → definir si vale la pena construirlos de
   cero (¿algún cliente los pidió?) o sacar esas dos opciones del
   selector hasta tenerlas, para no mostrar como "disponible" algo que
   en la práctica cobra igual que "Manual".
