# Política de nivel de servicio (SLA) — distrib

*Versión simple, pensada para publicarse en la landing y entregarse a clientes nuevos.*

## Disponibilidad

distrib corre sobre Vercel (hosting/edge) y Supabase (base de datos), ambos con SLA de disponibilidad propio publicado por sus proveedores. El objetivo de disponibilidad del servicio es **99% mensual**, excluyendo ventanas de mantenimiento programado que se avisan con al menos 24hs de anticipación por el canal de soporte.

## Tiempo de respuesta a soporte

| Severidad | Tiempo de primera respuesta |
|---|---|
| Crítico (sistema caído, no se puede facturar) | Mismo día hábil |
| Alto (función puntual fallando) | 24hs hábiles |
| Normal (consultas, mejoras) | 48hs hábiles |

El horario hábil es lunes a viernes de 9 a 18hs (hora Argentina).

## Backups

Supabase realiza backup automático diario de la base de datos. Los datos de cada empresa están aislados por fila (multi-tenant con RLS), lo que significa que un incidente en una empresa cliente no afecta los datos de otras.

## Qué no cubre esta política

- Pérdida de conectividad a internet del lado del cliente.
- Errores de carga de datos (stock, precios, clientes) ingresados por el propio usuario.
- Personalizaciones a medida fuera del alcance del plan contratado.

## Contacto

Ver `SOPORTE.md` para los canales y horarios de atención vigentes.

---

*Este documento se revisa cada vez que cambian los tiempos de respuesta reales u observados. Si en la práctica no se está cumpliendo, hay que ajustar la promesa antes de que un cliente lo note primero.*
