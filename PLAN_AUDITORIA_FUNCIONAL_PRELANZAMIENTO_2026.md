# Plan de auditoría funcional pre-lanzamiento (v768)

## Antes de arrancar algo nuevo: ya existen 3 auditorías en este proyecto

No parto de cero. En `AUDITORIA_2026/` hay tres auditorías previas, cada una
con alcance distinto, y las tres están cerradas o casi cerradas:

| Auditoría | Qué cubre | Estado |
|---|---|---|
| `AUDITORIA_2026/etapas/` (11-12 etapas) | Seguridad e infraestructura: RLS, funciones `SECURITY DEFINER`, backend/API, integraciones (AFIP/WhatsApp/email/MP), XSS, performance, backups, dependencias, rate limiting | 🟢 Cerrada — **1 pendiente crítico sin resolver, ver abajo** |
| `AUDITORIA_2026/etapas_modulos/` (18 módulos) | Lógica de negocio: pedidos, stock, cta-cte, facturación AFIP, medios de pago, rutas, POS, proveedores, notas de crédito, fidelización, usuarios/roles, notificaciones | 🟢 Cerrada (hasta ~v316) |
| `AUDITORIA_2026/etapas_paginas/` (5 fases) | Funcionalidad de UI y sincronización de datos entre pantallas/roles | 🟢 Cerrada en análisis estático — **falta el pase manual en navegador real** (nunca se hizo) |

**Verifiqué en vivo contra Supabase (no contra un doc viejo): el proyecto
sigue en plan Free.** Cero backups automáticos, sin PITR, sin SLA. Es el
hallazgo más grave de toda la auditoría de seguridad y **sigue sin
resolverse** — antes de meter un solo cliente real con plata/stock/facturas
adentro, esto pesa más que cualquier bug de UI. Si querés, lo resuelvo ahora
mismo (backup automatizado por GitHub Actions, ya había quedado armado y en
pausa por un problema de auth con el pooler — lo retomo).

## El gap real: 231 changelogs desde que se cerraron esas auditorías

Las auditorías de módulos y de páginas se cerraron alrededor de la v304-v437.
Hoy estás en v768. Eso son **231 entregas** (~165 migraciones nuevas) que
**nunca pasaron por una auditoría funcional** — incluye trabajo grande y
reciente: el POS se reconstruyó dos veces (v746 "terminal profesional" y
v762-763 "terminal Prisma", con API real nueva), gastos generales completo
(v750), atajos de teclado y flujo de cobro del POS (v751-758), asistente de
IA por voz para 6 módulos (v709-716), reset de password por WhatsApp (v719),
y varias auditorías puntuales de trazabilidad (`usuario_id`, v719-724) que
tocaron pedidos/POS/pagos/cta-cte pero sin volver a probar el flujo completo
end-to-end.

Es decir: **el POS con el que vas a cobrar todos los días es, en gran parte,
código que nunca tuvo un pase funcional dedicado.** Ahí es donde propongo
arrancar.

## Plan propuesto — 6 etapas, de mayor a menor riesgo de plata/datos

| # | Etapa | Por qué en ese orden |
|---|---|---|
| 1 | **POS (venta de mostrador, caja, devoluciones, ticket térmico, API Prisma nueva)** | Reconstruido 2 veces desde la última auditoría; toca dinero en efectivo todos los días; API nueva (v762-763) sin auditar |
| 2 | **Pedidos + Facturación AFIP/ARCA + Cobros/cta-cte** | Ya auditados una vez (v304), pero con cambios posteriores (asistente por voz, reset password, auditoría usuario_id) que no se re-probaron end-to-end |
| 3 | **Pagos online (Mercado Pago) + Conciliación bancaria + Gastos generales** | Gastos generales es 100% nuevo (v750), sin auditoría previa de ningún tipo |
| 4 | **Portal cliente + Portal chofer + Portal proveedor** | Roles externos a tu equipo — un bug acá lo ve el cliente/chofer directo, no vos |
| 5 | **El pase manual en navegador real que quedó pendiente de las 3 auditorías previas** | Todo lo anterior fue análisis estático de código; nunca se ejecutó de verdad en un browser |
| 6 | **Resto de admin (config, usuarios/roles, automatización, reportes, superadmin)** | Menor riesgo directo de plata, pero necesario para el cierre |

Cada etapa: reviso código + Supabase (RLS, funciones, triggers) buscando
lógica rota, casos borde sin manejar, mensajes de error silenciosos, y
botones/flujos que dependen de algo que ya no existe (patrón real
encontrado antes: `l.estado === 'por_vencer'` comparando contra un valor que
el constraint ya no permite). Corrijo lo que se pueda corregir por código o
migración directa en Supabase, documento lo que necesite tu decisión o
acceso manual, y entrego zip versionado por etapa — mismo mecanismo que
usamos en la auditoría responsive.

## Cómo seguimos
Decime **"dale, arrancá con la etapa 1 (POS)"** (o el orden que prefieras) y
empiezo. Si preferís que primero resuelva el backup de Supabase (el
pendiente crítico de arriba) antes de tocar funcionalidad, también lo hago
primero — es standalone y no depende de esto.
