# FIX — ventana rodante para los lotes "trigger" de liquidación en la demo

Retomando `PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md`: siguiendo la
auditoría de `ofertas_liquidacion` en cero (ver CHANGELOG anterior de esta
sesión), se armó el mecanismo de ventana rodante pedido para que la tabla
no vuelva a vaciarse con el paso de los días.

## Causa raíz

`fn_redistribuir_fechas_demo` (corre cada 6h vía pg_cron, job
`demo_reset_periodico`) rota las fechas de pedidos, facturas, cobros,
ventas_pos, rutas, etc. relativas a `CURRENT_DATE` — pero **no toca la
tabla `lotes`**. Los 2 lotes "trigger" de la demo (`L-PORVENCER-01`,
`L-VENCIDO-01`) tenían `fecha_vencimiento` fija en calendario absoluto.
Una vez que esa fecha quedaba en el pasado, `actualizar_estado_lotes`
(lógica real de negocio, vía cron diario `/api/stock-auto?accion=
analizar`) los pasaba a `estado='vencido'` para siempre — y el cron real
de liquidación (`/api/liquidacion?accion=generar`, 6:30, que solo mira
lotes `activo` con vencimiento en los próximos `dias_alerta` días) dejaba
de tener candidatos.

## Cambios (aplicados directo en Supabase — `jgiquzjwoedmzwqgzubr`)

- **Nueva función** `fn_rodar_lotes_trigger_demo(p_empresa_id)`:
  - `L-PORVENCER-*` → `fecha_vencimiento = CURRENT_DATE + offset`, donde
    `offset = extract(doy from CURRENT_DATE) % 7` (0 a 6, sin guardar
    estado entre corridas). Esto además hace que el lote recorra los 3
    niveles de descuento de `generar_ofertas_liquidacion` a lo largo de
    la semana (offset 0 → 25%, 1 → 15%, 2-6 → 10%), en vez de quedar
    siempre en el mismo nivel. `estado` vuelve a `'activo'` y
    `cantidad`/`cantidad_disponible` se reponen a un piso de 15.
  - `L-VENCIDO-*` → se re-ancla a "hace 5 días" (`estado='vencido'`),
    para que un reporte de mermas/vencidos no muestre una fecha cada vez
    más vieja.
  - Mismo guard de seguridad que `fn_redistribuir_fechas_demo` (aborta si
    la empresa no tiene `es_demo=true`).
- `fn_reset_demo_cron()`: se agrega el llamado a
  `fn_rodar_lotes_trigger_demo` después de `fn_generar_alertas_stock_autonomo`
  — mismo cron existente (`demo_reset_periodico`, cada 6h), no se creó
  ningún cron nuevo.
- Migración local agregada: `supabase/migrations/
  20260909195000_605_fn_rodar_lotes_trigger_demo_ventana_rodante_liquidacion.sql`

## Diseño

A propósito, esta función **no llama** a `generar_ofertas_liquidacion`
directamente — solo prepara el insumo (lotes con vencimiento fresco). El
cron real de liquidación (Vercel, 6:30 diario) sigue siendo el único que
genera/actualiza `ofertas_liquidacion`, exactamente como en producción.
Esto mantiene la separación que ya tenía el resto del sistema: los crons
reales son lógica de negocio, la demo solo mantiene fresco el dato de
entrada.

## Verificado en vivo

```sql
select fn_rodar_lotes_trigger_demo('4462586e-e11a-4d34-a405-17103bb9cf9f');
-- L-PORVENCER-01 → activo, vence hoy (offset 0 → nivel 25%)
-- L-VENCIDO-01   → vencido, vence hace 5 días

select generar_ofertas_liquidacion('4462586e-e11a-4d34-a405-17103bb9cf9f', false);
-- 1 oferta activa creada, 25% desc. — ofertas_liquidacion ya no está en cero
```

## Pendiente / a tener en cuenta

- La base viva en Supabase ya tiene migraciones hasta la `604`
  (`604_whatsapp_uso_conversacion_y_tools`), varias más que las que
  incluye este zip del repo (que llegaba hasta la `596`/etapa8). Antes
  de commitear esta migración conviene correr `supabase db pull` (o el
  proceso de sync que usen) para no perder ese rango en el repo local.
- Si en algún momento se agregan más lotes "trigger" con otro prefijo
  para otras demos de features, hay que sumarlos a
  `fn_rodar_lotes_trigger_demo` explícitamente — el `LIKE` solo cubre
  `L-PORVENCER%` y `L-VENCIDO%`.
