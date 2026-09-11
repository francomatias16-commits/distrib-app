# Índice de Changelogs

Total de changelogs indexados: **466**


Estructura:

- `reconciliados/` — los 10+ changelogs grandes de auditoría, ya verificados contra código, base de datos en vivo y suite de tests (no solo contra lo que decían auditorías anteriores). **Fuente de verdad** para el estado real del sistema.

- `v000-199` a `v800-984` — rastro histórico completo, en orden cronológico por rango de versión.

- `sin-numero/` — changelogs sin prefijo de versión numérico (ediciones puntuales, prints previos al esquema `vNNN`).


> Nota: del barrido de estos changelogs sueltos, se identificaron 7 ítems con lenguaje explícito de "pendiente". La mayoría ya fueron cerrados en versiones posteriores; quedan como posible seguimiento: **v305** (retry automático de emails, punto 3) y **v710** (reactivar producto inactivo por voz — limitación de alcance documentada, con workaround). Ver detalle en `docs/reportes/`.


## Reconciliados (auditoría verificada) — fuente de verdad (38 archivos)

| Versión | Archivo | Título | Categoría |
|---|---|---|---|
| - | [00_RESUMEN_INTEGRACION.md](reconciliados/00_RESUMEN_INTEGRACION.md) | Integración v455 — versión completa y actualizada | feature/otros |
| 229 | [CHANGELOG_v229_fase1_breakpoints_y_consolidacion_filtros_bar.md](reconciliados/CHANGELOG_v229_fase1_breakpoints_y_consolidacion_filtros_bar.md) | v229 — Fase 1 auditoría responsive: escala de breakpoints + consolidación de `.filtros-bar` | auditoría |
| 230 | [CHANGELOG_v230_fase2_pass1_breakpoints_768_redundantes.md](reconciliados/CHANGELOG_v230_fase2_pass1_breakpoints_768_redundantes.md) | v230 — Fase 2 (pasada 1): breakpoint redundante de `.filtros-bar` en 7 páginas | auditoría |
| 232 | [CHANGELOG_v232_fase2_sync_y_verificacion_modal_breakpoints.md](reconciliados/CHANGELOG_v232_fase2_sync_y_verificacion_modal_breakpoints.md) | v232 — Fase 2: sincronización del ZIP a v231 + verificación de `.modal` y breakpoints sueltos | auditoría |
| 233 | [CHANGELOG_v233_fase2_cierre_modal_y_breakpoints.md](reconciliados/CHANGELOG_v233_fase2_cierre_modal_y_breakpoints.md) | v233 — Fase 2: cierre — consolidación de `.modal` (panel lateral) y decisión final sobre breakpoints sueltos | auditoría |
| 234 | [CHANGELOG_v234_fase3_auditoria_mobile_barrera_regresion.md](reconciliados/CHANGELOG_v234_fase3_auditoria_mobile_barrera_regresion.md) | v234 — Fase 3: QA visual real en mobile (bug de modal en compras) + barrera de regresión CSS | auditoría |
| 235 | [CHANGELOG_v235_fix_filtros_der_overflow_y_audit_breakpoints.md](reconciliados/CHANGELOG_v235_fix_filtros_der_overflow_y_audit_breakpoints.md) | v235 — Fix overflow-x en `#filtros-der` (pedidos/presupuestos) + `npm run audit:breakpoints` | fix |
| 454 | [CHANGELOG_v454_auditoria_registrar_cobro_completo.md](reconciliados/CHANGELOG_v454_auditoria_registrar_cobro_completo.md) | v454 — Auditoría real (usuario_id): cobro manual (Cobranzas / cta-cte) | auditoría |
| 455 | [CHANGELOG_v455_auditoria_cc_proveedores_y_pos_abms.md](reconciliados/CHANGELOG_v455_auditoria_cc_proveedores_y_pos_abms.md) | v455 — Auditoría real (usuario_id): pagos a proveedores + ABMs de configuración POS | auditoría |
| 720 | [CHANGELOG_v720_auditoria_pedidos.md](reconciliados/CHANGELOG_v720_auditoria_pedidos.md) | v720 — Auditoría real (usuario_id): pedidos | auditoría |
| 721 | [CHANGELOG_v721_auditoria_pos.md](reconciliados/CHANGELOG_v721_auditoria_pos.md) | v721 — Auditoría real (usuario_id): POS (ventas de mostrador) | auditoría |
| 722 | [CHANGELOG_v722_auditoria_pagos.md](reconciliados/CHANGELOG_v722_auditoria_pagos.md) | v722 — Auditoría real (usuario_id): pagos (Mercado Pago) | auditoría |
| 724 | [CHANGELOG_v724_auditoria_chofer_invitacion.md](reconciliados/CHANGELOG_v724_auditoria_chofer_invitacion.md) | v724 — Auditoría real (usuario_id): invitación de choferes | auditoría |
| 760 | [CHANGELOG_v760_qr_mercadopago_pos.md](reconciliados/CHANGELOG_v760_qr_mercadopago_pos.md) | v760 — Cobro con QR de Mercado Pago en el POS + fix stale-cache (v759) | fix |
| 772 | [CHANGELOG_v772_auditoria_etapa3_mercadopago_webhook.md](reconciliados/CHANGELOG_v772_auditoria_etapa3_mercadopago_webhook.md) | v772 — Auditoría funcional etapa 3: Mercado Pago (parte 1) | auditoría |
| 773 | [CHANGELOG_v773_auditoria_etapa4_portales_cliente_chofer_proveedor.md](reconciliados/CHANGELOG_v773_auditoria_etapa4_portales_cliente_chofer_proveedor.md) | v773 — Auditoría funcional etapa 4: portal cliente / chofer / proveedor | auditoría |
| 773 | [CHANGELOG_v773_fix_coordenadas_store_qr_mercadopago.md](reconciliados/CHANGELOG_v773_fix_coordenadas_store_qr_mercadopago.md) | v773 — Fix: creación de Store del QR (POS) rechazada por coordenadas (0,0) | fix |
| 774 | [CHANGELOG_v774_auditoria_etapa5_pase_manual.md](reconciliados/CHANGELOG_v774_auditoria_etapa5_pase_manual.md) | v774 — Auditoría funcional etapa 5: pase manual en navegador real | auditoría |
| 775 | [CHANGELOG_v775_auditoria_etapa6_admin_config_usuarios_reportes.md](reconciliados/CHANGELOG_v775_auditoria_etapa6_admin_config_usuarios_reportes.md) | v775 — Auditoría funcional etapa 6: resto de admin (config, usuarios/roles, automatización, reportes, superadmin) | auditoría |
| 777 | [CHANGELOG_v777_fix_pos_external_id_y_store_id_numerico.md](reconciliados/CHANGELOG_v777_fix_pos_external_id_y_store_id_numerico.md) | v777 — Fix: creación de la caja (POS) del QR rechazada por MP (bad_request) | fix |
| 779 | [CHANGELOG_v779_fix_provincia_normalizada_store_qr.md](reconciliados/CHANGELOG_v779_fix_provincia_normalizada_store_qr.md) | v779 — Fix: Store de MP rechazada por `state_name` mal casado + mejor mensaje de error | fix |
| 782 | [CHANGELOG_v782_migracion_orders_api_qr_pos.md](reconciliados/CHANGELOG_v782_migracion_orders_api_qr_pos.md) | v782 — Migración del cobro QR del POS a la Orders API de Mercado Pago | migración |
| 867 | [CHANGELOG_v867_fix_toast_validacion_rojo.md](reconciliados/CHANGELOG_v867_fix_toast_validacion_rojo.md) | v867 — Fix: avisos de validación (toast) en rojo y más grandes | fix |
| 896 | [CHANGELOG_v896_fix_kebab_no_abria.md](reconciliados/CHANGELOG_v896_fix_kebab_no_abria.md) | v896 — Fix: botón "⋮" (más acciones) no abría el menú en 5 pantallas | fix |
| 897 | [CHANGELOG_v897_fix_resultado_principal_truncado.md](reconciliados/CHANGELOG_v897_fix_resultado_principal_truncado.md) | v897 — Fix: tarjeta "Resultado principal" cortaba el número (ej. $1.092.3...) | fix |
| 908 | [CHANGELOG_v908_fix_kebab_abre_modal_fila.md](reconciliados/CHANGELOG_v908_fix_kebab_abre_modal_fila.md) | Fix: click en botón "⋮ Más acciones" abre el modal de la fila en vez del menú | fix |
| 915 | [CHANGELOG_v915_fix_toast_tapado_modal_score_riesgo_cheques.md](reconciliados/CHANGELOG_v915_fix_toast_tapado_modal_score_riesgo_cheques.md) | v915 — Fix: "Recalcular" en modal de confianza (riesgo-cheques) no mostraba nada | fix |
| 916 | [CHANGELOG_v916_fix_toast_tapado_modal_score_clientes.md](reconciliados/CHANGELOG_v916_fix_toast_tapado_modal_score_clientes.md) | v916 — Fix: toast tapado en modal de nivel de confianza (Clientes) | fix |
| 921 | [CHANGELOG_v921_fix_hallazgos_auditoria_landing.md](reconciliados/CHANGELOG_v921_fix_hallazgos_auditoria_landing.md) | v920 — Fix de los 4 hallazgos de la auditoría de la landing | auditoría |
| 922 | [CHANGELOG_v922_sync_funcional_cta_demo_en_vivo.md](reconciliados/CHANGELOG_v922_sync_funcional_cta_demo_en_vivo.md) | Sincronización funcional de los CTAs con la landing vieja (demo en vivo) | feature/otros |
| 931 | [CHANGELOG_v931_logo_real_y_dropdown_descargar_app.md](reconciliados/CHANGELOG_v931_logo_real_y_dropdown_descargar_app.md) | CHANGELOG v931 — Logo real de Fluxo + tab "Descargar app" en la landing | feature/otros |
| 933 | [CHANGELOG_v933_azul_a_verde.md](reconciliados/CHANGELOG_v933_azul_a_verde.md) | CHANGELOG v933 — Recolor de acento: azul → verde en toda la landing | feature/otros |
| 938 | [CHANGELOG_v938_migracion_zindex_tokens_auditoria_responsive_fase1.md](reconciliados/CHANGELOG_v938_migracion_zindex_tokens_auditoria_responsive_fase1.md) | CHANGELOG v938 — Migración de z-index hardcodeados a variables (P2, auditoría responsive Fase 1) | auditoría |
| 945 | [CHANGELOG_v945_p3_maxscale_codigo_muerto_pos_whatsapp_widget.md](reconciliados/CHANGELOG_v945_p3_maxscale_codigo_muerto_pos_whatsapp_widget.md) | CHANGELOG v945 — P3: zoom landing + código muerto (pos.css / whatsapp-widget.css) | feature/otros |
| 946 | [CHANGELOG_v946_p2_reduccion_important_hero_mobile_y_checklist_manual.md](reconciliados/CHANGELOG_v946_p2_reduccion_important_hero_mobile_y_checklist_manual.md) | CHANGELOG v946 — P2 resto: reducir `!important` de mobile-hero-v935.css + checklist de verificación manual | feature/otros |
| 948 | [CHANGELOG_v948_hero_titulo_unico_y_carrusel_sin_scroll_jacking.md](reconciliados/CHANGELOG_v948_hero_titulo_unico_y_carrusel_sin_scroll_jacking.md) | CHANGELOG v948 — Hero simplificado: título único + carrusel sin scroll-jacking | feature/otros |
| 970 | [CHANGELOG_v970_etapa8_verificacion_dinamica_y_hallazgo5.md](reconciliados/CHANGELOG_v970_etapa8_verificacion_dinamica_y_hallazgo5.md) | v970 — Verificación dinámica real de Etapa 8 + cierre hallazgo #5 (robots/sitemap) | auditoría |
| 1046 | [CHANGELOG_v1046_bateria_completa_verificacion_pre_deploy.md](reconciliados/CHANGELOG_v1046_bateria_completa_verificacion_pre_deploy.md) | v1046 — Batería completa de verificación en verde, checkpoint pre-deploy (v1042-v1045) | auditoría |

## v000 – v199 (7 archivos)

| Versión | Archivo | Título | Categoría |
|---|---|---|---|
| 1 | [CHANGELOG_v1.47.2_fixes_validacion.md](v000-199/CHANGELOG_v1.47.2_fixes_validacion.md) | CHANGELOG v1.47.1 — Fixes de validación (auditoría de CHECK constraints) | fix |
| 166 | [CHANGELOG_v166.md](v000-199/CHANGELOG_v166.md) | v166 — Fix crítico en wizard de migración | fix |
| 182 | [CHANGELOG_v182_housekeeping_migraciones.md](v000-199/CHANGELOG_v182_housekeeping_migraciones.md) | v182 — Housekeeping post "prueba de volumen": migraciones 160-165 | migración |
| 187 | [CHANGELOG_v187_self_serve_planes.md](v000-199/CHANGELOG_v187_self_serve_planes.md) | CHANGELOG v187 — Self-serve upgrade/downgrade de plan | feature/otros |
| 190 | [CHANGELOG_v190_migracion_categorias_depositos_listas_zonas.md](v000-199/CHANGELOG_v190_migracion_categorias_depositos_listas_zonas.md) | v190 — Punto 7 del plan de migraciones (P1) / Gap crítico 3 | migración |
| 194 | [CHANGELOG_v194_migracion_extras.md](v000-199/CHANGELOG_v194_migracion_extras.md) | CHANGELOG v194 — Migraciones: tres correctivos de visibilidad | migración |
| 199 | [CHANGELOG_v199_gap1_precios_especiales.md](v000-199/CHANGELOG_v199_gap1_precios_especiales.md) | CHANGELOG v199 — Gap 1/4: Precios especiales (vista global) | feature/otros |

## v200 – v399 (114 archivos)

| Versión | Archivo | Título | Categoría |
|---|---|---|---|
| 200 | [CHANGELOG_v200_gaps_2_3_4.md](v200-399/CHANGELOG_v200_gaps_2_3_4.md) | CHANGELOG v200 — Gaps 2/3/4 de UI (ventas POS, comprobantes históricos, direcciones) | feature/otros |
| 200 | [CHANGELOG_v200b_smoke_test_fixes.md](v200-399/CHANGELOG_v200b_smoke_test_fixes.md) | CHANGELOG v200b — Smoke test contra Supabase real + 2 fixes | fix |
| 200 | [CHANGELOG_v200c_migracion_maestra.md](v200-399/CHANGELOG_v200c_migracion_maestra.md) | CHANGELOG v200c — Migración maestra (un solo archivo → detección automática) | migración |
| 211 | [CHANGELOG_v211_pedidos_paginacion.md](v200-399/CHANGELOG_v211_pedidos_paginacion.md) | CHANGELOG v211 — Paginación y refresco visual de Pedidos | feature/otros |
| 212 | [CHANGELOG_v212_rediseno_pedidos.md](v200-399/CHANGELOG_v212_rediseno_pedidos.md) | CHANGELOG v212 — Rediseño visual de Pedidos + fix vendedor UUID | fix |
| 214 | [CHANGELOG_v214_optimizacion_reportes_stock.md](v200-399/CHANGELOG_v214_optimizacion_reportes_stock.md) | v214 — Optimización de Reportes de Stock | feature/otros |
| 215 | [CHANGELOG_v215_fix_preloader_scroll_dashboard.md](v200-399/CHANGELOG_v215_fix_preloader_scroll_dashboard.md) | Fix: preloader sin overlay real + salto de scroll en Panel principal | fix |
| 216 | [CHANGELOG_v216_compactar_espacios_panel.md](v200-399/CHANGELOG_v216_compactar_espacios_panel.md) | Fix: espacios vacíos en las filas de dos columnas del Panel principal | fix |
| 217 | [CHANGELOG_v217_reestructurar_zona2_zona3_columna_ventas_pedidos_stock.md](v200-399/CHANGELOG_v217_reestructurar_zona2_zona3_columna_ventas_pedidos_stock.md) | CHANGELOG v217 — Reestructuración ZONA 2 + ZONA 3 del Panel principal | feature/otros |
| 218 | [CHANGELOG_v218_responsive_100_auditoria_completa.md](v200-399/CHANGELOG_v218_responsive_100_auditoria_completa.md) | CHANGELOG v218 — Responsive al 100%: auditoría y fix de punta a punta | auditoría |
| 219 | [CHANGELOG_v219_fixes_seguridad_y_demo.md](v200-399/CHANGELOG_v219_fixes_seguridad_y_demo.md) | v219 — Fix de seguridad/integridad en ajuste de stock | fix |
| 220 | [CHANGELOG_v220_fix_onclick_y_diagnostico_pedido.md](v200-399/CHANGELOG_v220_fix_onclick_y_diagnostico_pedido.md) | v220 — Fix botones sin evento + tool de diagnóstico de pedido en el asistente | fix |
| 222 | [CHANGELOG_v222_fix_desborde_topbar_mobile.md](v200-399/CHANGELOG_v222_fix_desborde_topbar_mobile.md) | v222 — Fix desborde horizontal en mobile (topbar-workspace) | fix |
| 225 | [CHANGELOG_v225_config_empresa_soporte_whatsapp.md](v200-399/CHANGELOG_v225_config_empresa_soporte_whatsapp.md) | CHANGELOG v225 — Datos de la empresa + Soporte (WhatsApp) | feature/otros |
| 226 | [CHANGELOG_v226_fix_siguiente_numero_comprobante.md](v200-399/CHANGELOG_v226_fix_siguiente_numero_comprobante.md) | CHANGELOG v226 — Fix ownership check en siguiente_numero_comprobante | fix |
| 227 | [CHANGELOG_v227_nueva_tabla_productos.md](v200-399/CHANGELOG_v227_nueva_tabla_productos.md) | CHANGELOG v227 — Nueva interfaz de tabla de Productos | feature/otros |
| 231 | [CHANGELOG_v231_fix_sincronizacion_productos.md](v200-399/CHANGELOG_v231_fix_sincronizacion_productos.md) | v231 — Fix: sincronización de la sección Productos | fix |
| 232 | [CHANGELOG_v232_fix_nav_duplicado_dashboard.md](v200-399/CHANGELOG_v232_fix_nav_duplicado_dashboard.md) | v232 — Fix: menú lateral duplicado y botón flotante redundante en el Panel principal | fix |
| 233 | [CHANGELOG_v233_fixes_etapa1_topbar_reloj_avatar.md](v200-399/CHANGELOG_v233_fixes_etapa1_topbar_reloj_avatar.md) | CHANGELOG v233 — Fixes Etapa 1 (Topbar / Reloj / Avatar) | fix |
| 234 | [CHANGELOG_v234_fixes_etapa2_topbar_reloj_avatar_supabase.md](v200-399/CHANGELOG_v234_fixes_etapa2_topbar_reloj_avatar_supabase.md) | CHANGELOG v234 — Fixes Etapa 2 (Topbar / Reloj / Avatar — integridad Supabase) | fix |
| 235 | [CHANGELOG_v235_fixes_etapa3_feedback_errores_toasts.md](v200-399/CHANGELOG_v235_fixes_etapa3_feedback_errores_toasts.md) | v235 — Fixes Etapa 3: Feedback, Estados de Carga y Manejo de Errores de Red | fix |
| 237 | [CHANGELOG_v237_panel_admin_dashboard.md](v200-399/CHANGELOG_v237_panel_admin_dashboard.md) | v237 — Panel de administración del POS rediseñado | feature/otros |
| 238 | [CHANGELOG_v238_quickbar_pos.md](v200-399/CHANGELOG_v238_quickbar_pos.md) | v238 — Barra de accesos visible en Punto de venta (quickbar) | feature/otros |
| 239 | [CHANGELOG_v239_quickbar_pulido_visual.md](v200-399/CHANGELOG_v239_quickbar_pulido_visual.md) | v239 — Pulido visual de la barra de accesos (quickbar) | feature/otros |
| 242 | [CHANGELOG_v242_etapa1_logistica.md](v200-399/CHANGELOG_v242_etapa1_logistica.md) | CHANGELOG v242 — Etapa 1 del plan por etapas: Logística | fase/etapa (plan) |
| 243 | [CHANGELOG_v243_etapa4_alerta_sin_proveedor.md](v200-399/CHANGELOG_v243_etapa4_alerta_sin_proveedor.md) | v243 — Etapa 4 (Compras inteligentes): alerta cuando falta proveedor por defecto | fase/etapa (plan) |
| 243 | [CHANGELOG_v243_etapa5_dashboard_ejecutivo.md](v200-399/CHANGELOG_v243_etapa5_dashboard_ejecutivo.md) | v243 — Etapa 5: Dashboard ejecutivo consolidado + comparativa mensual + export | fase/etapa (plan) |
| 245 | [CHANGELOG_v245_etapa6_export_contable_diseno.md](v200-399/CHANGELOG_v245_etapa6_export_contable_diseno.md) | v245 — Etapa 6: Export contable (diseño + base + esqueleto) | fase/etapa (plan) |
| 246 | [CHANGELOG_v246_etapa6_whatsapp_bidireccional.md](v200-399/CHANGELOG_v246_etapa6_whatsapp_bidireccional.md) | v246 — Etapa 6: WhatsApp Business API bidireccional | fase/etapa (plan) |
| 246 | [CHANGELOG_v246_integracion_ramas_etapa2_y_etapa6.md](v200-399/CHANGELOG_v246_integracion_ramas_etapa2_y_etapa6.md) | v246 — Integración de dos ramas divergentes (Etapa 2 UI + Etapa 6 export contable) | fase/etapa (plan) |
| 247 | [CHANGELOG_v247_integracion_whatsapp_bidireccional.md](v200-399/CHANGELOG_v247_integracion_whatsapp_bidireccional.md) | v247 — Integración de la rama WhatsApp bidireccional sobre v246_integrado | feature/otros |
| 249 | [CHANGELOG_v249_etapa0_auditoria_security_definer_funciones_fantasma.md](v200-399/CHANGELOG_v249_etapa0_auditoria_security_definer_funciones_fantasma.md) | v249 — Etapa 0 (Higiene de base): auditoría automática de SECURITY DEFINER + funciones fantasma | auditoría |
| 249 | [CHANGELOG_v249_fix_contraste_wcag.md](v200-399/CHANGELOG_v249_fix_contraste_wcag.md) | CHANGELOG v249 — Fix de contraste WCAG AA (legibilidad global) | fix |
| 250 | [CHANGELOG_v250_fix_layout_pos_overflow_y_limpieza_favoritos.md](v200-399/CHANGELOG_v250_fix_layout_pos_overflow_y_limpieza_favoritos.md) | CHANGELOG v250 — Fix layout POS (overflow horizontal) + limpieza de favoritos | fix |
| 261 | [CHANGELOG_v261_alerta_cheques_vencidos_sin_gestionar.md](v200-399/CHANGELOG_v261_alerta_cheques_vencidos_sin_gestionar.md) | v261 — Alerta de cheques vencidos sin gestionar | feature/otros |
| 262 | [CHANGELOG_v262_fix_columna_vencimiento_cheques.md](v200-399/CHANGELOG_v262_fix_columna_vencimiento_cheques.md) | v262 — Fix: alerta de cheques vencidos usaba la columna equivocada | fix |
| 263 | [CHANGELOG_v263_trigger_sync_cheques_vencimiento.md](v200-399/CHANGELOG_v263_trigger_sync_cheques_vencimiento.md) | v263 — Trigger de sincronización cheques.vencimiento ↔ fecha_vto | feature/otros |
| 269 | [CHANGELOG_v269_auditoria_ux_integracion.md](v200-399/CHANGELOG_v269_auditoria_ux_integracion.md) | v269 — Integración de la auditoría UX al proyecto completo | auditoría |
| 270 | [CHANGELOG_v270_cobro_en_reparto.md](v200-399/CHANGELOG_v270_cobro_en_reparto.md) | v270 — Cobro en el reparto (chofer) | feature/otros |
| 270 | [CHANGELOG_v270_promocion_torre_de_control.md](v200-399/CHANGELOG_v270_promocion_torre_de_control.md) | v271 — Promoción de la Torre de Control a panel principal | feature/otros |
| 272 | [CHANGELOG_v272_reglas_precio_ventas.md](v200-399/CHANGELOG_v272_reglas_precio_ventas.md) | v272 — Reglas de precio: acceso duplicado en Ventas + link desde alta de pedido | feature/otros |
| 273 | [CHANGELOG_v273_revert_torre_de_control.md](v200-399/CHANGELOG_v273_revert_torre_de_control.md) | v273 — Se revierte la promoción de Torre de Control, se borra dashboard-v2 | feature/otros |
| 274 | [CHANGELOG_v274_fix_pedidos_pendiente_sin_accion.md](v200-399/CHANGELOG_v274_fix_pedidos_pendiente_sin_accion.md) | v274 — Bug real: pedidos nuevos quedaban trabados en "Pendiente" | fix |
| 275 | [CHANGELOG_v275_auditoria_ux_pendientes.md](v200-399/CHANGELOG_v275_auditoria_ux_pendientes.md) | v275 — Cierre de los 3 pendientes reales de la auditoría UX | auditoría |
| 276 | [CHANGELOG_v276_barrido_emojis_fase1.md](v200-399/CHANGELOG_v276_barrido_emojis_fase1.md) | CHANGELOG v276 — Barrido global de emojis (Fase 1) | fase/etapa (plan) |
| 277 | [CHANGELOG_v277_barrido_emojis_fase2.md](v200-399/CHANGELOG_v277_barrido_emojis_fase2.md) | CHANGELOG v277 — Barrido global de emojis (Fase 2) | fase/etapa (plan) |
| 280 | [CHANGELOG_v280_filtrado_alertas_dashboard.md](v200-399/CHANGELOG_v280_filtrado_alertas_dashboard.md) | v280 — Filtrado real desde las alertas del dashboard | feature/otros |
| 281 | [CHANGELOG_v281_ctacte_server_side_y_fix_grants.md](v200-399/CHANGELOG_v281_ctacte_server_side_y_fix_grants.md) | v281 — Cuenta Corriente server-side + fix de grants (continuación AUDITORIA_FILTROS_v280) | auditoría |
| 282 | [CHANGELOG_v282_proveedores_bug_y_ctacte_proveedores_server_side.md](v200-399/CHANGELOG_v282_proveedores_bug_y_ctacte_proveedores_server_side.md) | v282 — Fix bug Portal de Proveedores + Cc-proveedores server-side (continuación AUDITORIA_FILTROS_v280) | auditoría |
| 283 | [CHANGELOG_v283_etapa6_hardening_webhook_whatsapp.md](v200-399/CHANGELOG_v283_etapa6_hardening_webhook_whatsapp.md) | Changelog v283 — Etapa 3 del plan WhatsApp bidireccional: hardening del webhook | fase/etapa (plan) |
| 284 | [CHANGELOG_v284_fix_whatsapp_bidireccional_numero_ar_9_allowed_list.md](v200-399/CHANGELOG_v284_fix_whatsapp_bidireccional_numero_ar_9_allowed_list.md) | v284 — Fix: respuesta de WhatsApp fallaba con (#131030) en números argentinos | fix |
| 287 | [CHANGELOG_v287_fix_layout_whatsapp_onboarding.md](v200-399/CHANGELOG_v287_fix_layout_whatsapp_onboarding.md) | v287 — Fix layout roto en "Conectar WhatsApp" (Etapa 7) | fix |
| 288 | [CHANGELOG_v288_fix_config_id_whatsapp.md](v200-399/CHANGELOG_v288_fix_config_id_whatsapp.md) | v288 — Fix config_id incorrecto en WhatsApp Embedded Signup | fix |
| 289 | [CHANGELOG_v289_fix_finish_only_waba.md](v200-399/CHANGELOG_v289_fix_finish_only_waba.md) | v289 — Fix "No se pudo obtener el número conectado" | fix |
| 291 | [CHANGELOG_v291_bloqueo_whatsapp_saliente.md](v200-399/CHANGELOG_v291_bloqueo_whatsapp_saliente.md) | v291 — Bloqueo temporal de WhatsApp saliente (control de costos) | feature/otros |
| 292 | [CHANGELOG_v292_fix_token_larga_duracion_embedded_signup.md](v200-399/CHANGELOG_v292_fix_token_larga_duracion_embedded_signup.md) | v292 — Token de larga duración en WhatsApp Embedded Signup (Etapa 7) | fix |
| 293 | [CHANGELOG_v293_whatsapp_access_token_cifrado.md](v200-399/CHANGELOG_v293_whatsapp_access_token_cifrado.md) | v293 — Cifrado del access_token en empresa_whatsapp | feature/otros |
| 294 | [CHANGELOG_v294_whatsapp_envios_por_empresa.md](v200-399/CHANGELOG_v294_whatsapp_envios_por_empresa.md) | v294 — Flag de envíos salientes por empresa (reemplaza el interruptor global de v291) | feature/otros |
| 295 | [CHANGELOG_v295_whatsapp_deteccion_token_vencido.md](v200-399/CHANGELOG_v295_whatsapp_deteccion_token_vencido.md) | v295 — Detección de token vencido por empresa (necesita_reconexion) | feature/otros |
| 296 | [CHANGELOG_v296_fix_sec008_catalogo_publico_gateado.md](v200-399/CHANGELOG_v296_fix_sec008_catalogo_publico_gateado.md) | v296 — SEC-008: catálogo cliente sin login gateado por flag explícito | fix |
| 297 | [CHANGELOG_v297_rl01_rate_limit_contador_supabase.md](v200-399/CHANGELOG_v297_rl01_rate_limit_contador_supabase.md) | v297 — RL-01: rate limiting compartido entre instancias (contador en Supabase) | feature/otros |
| 298 | [CHANGELOG_v298_fix_typo_rol_deposito_push_stock_critico.md](v200-399/CHANGELOG_v298_fix_typo_rol_deposito_push_stock_critico.md) | v298 — Fix typo de rol en push de stock crítico (OBS-03, seguimiento) | fix |
| 299 | [CHANGELOG_v299_fix_logging_silencioso_notif_criticas.md](v200-399/CHANGELOG_v299_fix_logging_silencioso_notif_criticas.md) | v299 — Fix logging silencioso en alertas críticas (auditoría 2026-07-12) | fix |
| 300 | [CHANGELOG_v300_fix_urgente_rate_limiter_cuelga_admin.md](v200-399/CHANGELOG_v300_fix_urgente_rate_limiter_cuelga_admin.md) | v300 — Fix urgente: rate limiter cuelga /api/admin/* (60s timeout) | fix |
| 301 | [CHANGELOG_v301_fix_real_timeout_auth_getUser.md](v200-399/CHANGELOG_v301_fix_real_timeout_auth_getUser.md) | v301 — Causa raíz real del cuelgue: `supabase.auth.getUser()` sin timeout | fix |
| 302 | [CHANGELOG_v302_reducir_concurrencia_dashboard.md](v200-399/CHANGELOG_v302_reducir_concurrencia_dashboard.md) | v302 — Reducir la ráfaga de requests concurrentes del dashboard | feature/otros |
| 303 | [CHANGELOG_v303_revertir_rate_limiter_memoria.md](v200-399/CHANGELOG_v303_revertir_rate_limiter_memoria.md) | v303 — Causa raíz confirmada: revertir rate limiter a memoria | feature/otros |
| 304 | [CHANGELOG_v304_auditoria2026_etapas13_18.md](v200-399/CHANGELOG_v304_auditoria2026_etapas13_18.md) | CHANGELOG v304 — Auditoría 2026, etapas 13 a 18 (21 hallazgos) | auditoría |
| 305 | [CHANGELOG_v305_etapa1_hallazgo2_notif_log.md](v200-399/CHANGELOG_v305_etapa1_hallazgo2_notif_log.md) | CHANGELOG v305 — Etapa 1 (Pedidos), Hallazgo 2: notificaciones de confirmación fallan en silencio | auditoría |
| 306 | [CHANGELOG_v306_etapa1_hallazgos3y4.md](v200-399/CHANGELOG_v306_etapa1_hallazgos3y4.md) | CHANGELOG v306 — Etapa 1 (Pedidos), Hallazgos 3 y 4 | auditoría |
| 307 | [CHANGELOG_v307_cierre_4_pendientes_auditoria_ux.md](v200-399/CHANGELOG_v307_cierre_4_pendientes_auditoria_ux.md) | v307 — Cierre de los 4 hallazgos pendientes reales (auditoría UX, etapas 13-18) | auditoría |
| 310 | [CHANGELOG_v310_auditoria_modulos_etapas2y3.md](v200-399/CHANGELOG_v310_auditoria_modulos_etapas2y3.md) | CHANGELOG v310 — Auditoría de módulos, etapas 2 y 3 (Stock, Cta. cte.) | auditoría |
| 313 | [CHANGELOG_v313_etapa6_no_entrega_y_rutas_duplicadas.md](v200-399/CHANGELOG_v313_etapa6_no_entrega_y_rutas_duplicadas.md) | v313 — Auditoría 2026, Etapa 6: flujo de "no entrega" + rutas duplicadas | fase/etapa (plan) |
| 314 | [CHANGELOG_v314_etapa7_performance.md](v200-399/CHANGELOG_v314_etapa7_performance.md) | v314 — Auditoría 2026, Etapa 7: Performance y escalabilidad | fase/etapa (plan) |
| 315 | [CHANGELOG_v315_etapa10_fidelizacion.md](v200-399/CHANGELOG_v315_etapa10_fidelizacion.md) | CHANGELOG v315 — Auditoría de módulos, etapa 10 (Fidelización) | fase/etapa (plan) |
| 315 | [CHANGELOG_v315_etapa9_notas_credito_devoluciones.md](v200-399/CHANGELOG_v315_etapa9_notas_credito_devoluciones.md) | v315 — Auditoría por módulos, Etapa 9: Notas de crédito y débito / devoluciones | fase/etapa (plan) |
| 316 | [CHANGELOG_v316_hallazgo2_reintento_manual_emails.md](v200-399/CHANGELOG_v316_hallazgo2_reintento_manual_emails.md) | CHANGELOG v316 — Hallazgo 2 (auditoría de notificaciones): reenvío manual de emails | auditoría |
| 320 | [CHANGELOG_v320_fix_alertas_score_y_push_panel.md](v200-399/CHANGELOG_v320_fix_alertas_score_y_push_panel.md) | CHANGELOG v320 — Fix alertas Motor 5 (Score) + push del panel de automatización | fix |
| 321 | [CHANGELOG_v321_fix_estados_criticos_dashboard.md](v200-399/CHANGELOG_v321_fix_estados_criticos_dashboard.md) | CHANGELOG v321 — Estados críticos visibles en el dashboard (+ bug de fondo en score) | fix |
| 323 | [CHANGELOG_v323_borrado_mi_suscripcion_huerfana_y_cambio_plan_self_service.md](v200-399/CHANGELOG_v323_borrado_mi_suscripcion_huerfana_y_cambio_plan_self_service.md) | CHANGELOG v323 — Borrado de `mi-suscripcion.html` (huérfana) + cambio de plan self-service en `saas-billing.html` | feature/otros |
| 335 | [CHANGELOG_v335_paginacion_rentabilidad_producto_vendedor.md](v200-399/CHANGELOG_v335_paginacion_rentabilidad_producto_vendedor.md) | v335 — Paginación en "Qué producto y vendedor rinden más" | feature/otros |
| 336 | [CHANGELOG_v336_fix_crash_lambda_completa_env_faltante.md](v200-399/CHANGELOG_v336_fix_crash_lambda_completa_env_faltante.md) | v336 — Fix: env var faltante tumba TODA la lambda de /api/* (no solo el módulo afectado) | fix |
| 338 | [CHANGELOG_v338_healthcheck_diagnostico_env.md](v200-399/CHANGELOG_v338_healthcheck_diagnostico_env.md) | v338 — Nuevo: /api/health, diagnóstico de env vars y conexión Supabase | feature/otros |
| 339 | [CHANGELOG_v339_fix_websocket_nativo_faltante_supabase.md](v200-399/CHANGELOG_v339_fix_websocket_nativo_faltante_supabase.md) | v339 — Fix: "Node.js detected but native WebSocket not found" (Supabase no conecta) | fix |
| 340 | [CHANGELOG_v340_panel_productos_modificados_stock.md](v200-399/CHANGELOG_v340_panel_productos_modificados_stock.md) | v340 — Panel "Productos modificados" en Stock (hoy / 7 días / 30 días) | feature/otros |
| 341 | [CHANGELOG_v341_fix_recepcion_oc_y_roadmap_motivos_stock.md](v200-399/CHANGELOG_v341_fix_recepcion_oc_y_roadmap_motivos_stock.md) | v341 — Fix crítico: recepción de OC no impactaba en stock real + roadmap de motivos de ajuste | fix |
| 345 | [CHANGELOG_v345_roadmap_v341_items_2_3_4.md](v200-399/CHANGELOG_v345_roadmap_v341_items_2_3_4.md) | v345 — Roadmap v341: transferencia atómica, redirección de motivos, BOM y conteos históricos | feature/otros |
| 350 | [CHANGELOG_v350_fix_kpis_stock_y_filtro_mes_productos.md](v200-399/CHANGELOG_v350_fix_kpis_stock_y_filtro_mes_productos.md) | v348–v350 — Fix: KPIs de Stock inflados/desactualizados y filtro de mes en Productos | fix |
| 351 | [CHANGELOG_v351_elegir_depositos_al_crear_producto.md](v200-399/CHANGELOG_v351_elegir_depositos_al_crear_producto.md) | v351 — Elegir depósito(s) al crear un producto | feature/otros |
| 352 | [CHANGELOG_v352_dar_de_baja_lote_impacta_stock.md](v200-399/CHANGELOG_v352_dar_de_baja_lote_impacta_stock.md) | v352 — "Dar de baja" un lote ahora descuenta el stock real | feature/otros |
| 353 | [CHANGELOG_v353_foto_producto_upload.md](v200-399/CHANGELOG_v353_foto_producto_upload.md) | v353 — Subida de foto de producto desde el modal | feature/otros |
| 355 | [CHANGELOG_v355_invitacion_choferes.md](v200-399/CHANGELOG_v355_invitacion_choferes.md) | v355 — Invitar chofer desde Repartos (link de auto-activación) | feature/otros |
| 360 | [CHANGELOG_v360_fix_modales_direcciones_precios_reglas.md](v200-399/CHANGELOG_v360_fix_modales_direcciones_precios_reglas.md) | CHANGELOG v360 — Fix modales sin evento (Direcciones, Precios especiales, Reglas de precio) | fix |
| 361 | [CHANGELOG_v361_gentelella_form_reglas_precio.md](v200-399/CHANGELOG_v361_gentelella_form_reglas_precio.md) | CHANGELOG v361 — Reskin Gentelella del formulario de Reglas de precio | feature/otros |
| 366 | [CHANGELOG_v366_fix_toast_generico_cambiarEstado.md](v200-399/CHANGELOG_v366_fix_toast_generico_cambiarEstado.md) | v366 — Fix: toast genérico "Ocurrió un error" en cambiarEstado() | fix |
| 367 | [CHANGELOG_v367_fix_definitivo_rpc_catch_thenable.md](v200-399/CHANGELOG_v367_fix_definitivo_rpc_catch_thenable.md) | v367 — Fix DEFINITIVO: "Ocurrió un error" en cambiarEstado() (y afines) | fix |
| 368 | [CHANGELOG_v368_fix_push_admin_404.md](v200-399/CHANGELOG_v368_fix_push_admin_404.md) | v368 — Fix: push-admin.js 404 (notificaciones push admin rotas) | fix |
| 369 | [CHANGELOG_v369_auditoria_gentelella_forms_gaps.md](v200-399/CHANGELOG_v369_auditoria_gentelella_forms_gaps.md) | v369 — Auditoría Gentelella: formularios/páginas sin cobertura de estilos | auditoría |
| 370 | [CHANGELOG_v370_migracion_echarts_reportes.md](v200-399/CHANGELOG_v370_migracion_echarts_reportes.md) | v370 — Migración completa de Chart.js a ECharts | migración |
| 381 | [CHANGELOG_v381_auto_carga_imagenes_productos.md](v200-399/CHANGELOG_v381_auto_carga_imagenes_productos.md) | v381 — Auto-carga de imágenes de productos | feature/otros |
| 382 | [CHANGELOG_v382_modal_deshacer_auto_imagenes.md](v200-399/CHANGELOG_v382_modal_deshacer_auto_imagenes.md) | v382 — Auto-imágenes: modal propio, botón detener, deshacer | feature/otros |
| 383 | [CHANGELOG_v383_diagnostico_rate_limit_boton_importar.md](v200-399/CHANGELOG_v383_diagnostico_rate_limit_boton_importar.md) | v383 — Diagnóstico "Demasiadas solicitudes" + botón Importar en Productos | feature/otros |
| 384 | [CHANGELOG_v384_deteccion_encabezado_maestro_y_autogenerar_codigo.md](v200-399/CHANGELOG_v384_deteccion_encabezado_maestro_y_autogenerar_codigo.md) | v384 — Detección de fila de encabezados + auto-generar código en Productos | feature/otros |
| 388 | [CHANGELOG_v388_open_products_facts_capa_1b.md](v200-399/CHANGELOG_v388_open_products_facts_capa_1b.md) | v388 — Capa 1b: Open Products Facts para no-alimentos | feature/otros |
| 389 | [CHANGELOG_v389_traduccion_pexels_multi_rubro.md](v200-399/CHANGELOG_v389_traduccion_pexels_multi_rubro.md) | v389 — Traducción ES→EN para Capa 2 (Pexels), multi-rubro | feature/otros |
| 390 | [CHANGELOG_v390_google_images_capa2_real.md](v200-399/CHANGELOG_v390_google_images_capa2_real.md) | v390 — Capa 2 real: Google Custom Search Images (fotos reales por nombre) | feature/otros |
| 391 | [CHANGELOG_v391_persistir_foto_fuente.md](v200-399/CHANGELOG_v391_persistir_foto_fuente.md) | v391 — Persistir foto_fuente para poder auditar el origen de cada imagen | feature/otros |
| 392 | [CHANGELOG_v392_visualizar_fuente_foto_admin.md](v200-399/CHANGELOG_v392_visualizar_fuente_foto_admin.md) | v392 — Visualizar y filtrar por origen de la foto en el admin | feature/otros |
| 393 | [CHANGELOG_v393_fix_capas_separadas_auto_imagenes.md](v200-399/CHANGELOG_v393_fix_capas_separadas_auto_imagenes.md) | v393 — Fix: Capa 2 (Google Images) y Capa 3 (Pexels) quedan opt-in por separado | fix |
| 394 | [CHANGELOG_v394_saca_pexels_reemplaza_google_cse_por_serper.md](v200-399/CHANGELOG_v394_saca_pexels_reemplaza_google_cse_por_serper.md) | v394 — Se saca Pexels del pipeline; Google CSE se reemplaza por Serper.dev | feature/otros |
| 395 | [CHANGELOG_v395_contador_uso_serper.md](v200-399/CHANGELOG_v395_contador_uso_serper.md) | v395 — Contador de consultas a Serper visible en el admin | feature/otros |
| 396 | [CHANGELOG_v396_serper_mercadolibre_dos_etapas.md](v200-399/CHANGELOG_v396_serper_mercadolibre_dos_etapas.md) | v396 — Capa 2 en dos etapas: MercadoLibre primero, búsqueda general como fallback | fase/etapa (plan) |
| 397 | [CHANGELOG_v397_fix_loop_infinito_auto_imagenes.md](v200-399/CHANGELOG_v397_fix_loop_infinito_auto_imagenes.md) | v397 — Fix: loop infinito en /api/auto-imagenes cuando un producto no matchea | fix |
| 398 | [CHANGELOG_v398_fallback_campos_imagen_off.md](v200-399/CHANGELOG_v398_fallback_campos_imagen_off.md) | v398 — Fallback a otros campos de imagen en Open Food Facts / Open Products Facts | feature/otros |

## v400 – v599 (90 archivos)

| Versión | Archivo | Título | Categoría |
|---|---|---|---|
| 400 | [CHANGELOG_v400_fix_signo_panel_productos_modificados.md](v400-599/CHANGELOG_v400_fix_signo_panel_productos_modificados.md) | v400 — Fix definitivo: panel "Productos modificados" sumaba sin signo | fix |
| 402 | [CHANGELOG_v402_stock_agrupado_por_producto.md](v400-599/CHANGELOG_v402_stock_agrupado_por_producto.md) | v402 — Stock: tabla agrupada por producto (no repite fila por depósito) | feature/otros |
| 408 | [CHANGELOG_v408_excedente_recepcion_oc.md](v400-599/CHANGELOG_v408_excedente_recepcion_oc.md) | v408 — Excedente de proveedor en recepción de OC | feature/otros |
| 436 | [CHANGELOG_v436_alerta_cobro_parcial_panel.md](v400-599/CHANGELOG_v436_alerta_cobro_parcial_panel.md) | v434 — Fix: sincronización rutas.estado + columna TOTAL / alerta de cobro parcial | fix |
| 437 | [CHANGELOG_v437_avisos_operativos_en_alertas_automaticas.md](v400-599/CHANGELOG_v437_avisos_operativos_en_alertas_automaticas.md) | v437 — Avisos operativos en "Alertas automáticas" | feature/otros |
| 443 | [CHANGELOG_v443_fase3.2_tests_unitarios.md](v400-599/CHANGELOG_v443_fase3.2_tests_unitarios.md) | v443 — Fase 3.2 del plan de acción: esqueleto de tests unitarios (Vitest) | fase/etapa (plan) |
| 444 | [CHANGELOG_v444_fase3.3_load_test.md](v400-599/CHANGELOG_v444_fase3.3_load_test.md) | v444 — Fase 3.3 del plan de acción: test de carga básico (autocannon) | fase/etapa (plan) |
| 445 | [CHANGELOG_v445_fase4.1_sentry_backend.md](v400-599/CHANGELOG_v445_fase4.1_sentry_backend.md) | v445 — Fase 4.1 del plan de acción: Sentry en el backend (error tracking) | fase/etapa (plan) |
| 446 | [CHANGELOG_v446_fase4.1_sentry_frontend.md](v400-599/CHANGELOG_v446_fase4.1_sentry_frontend.md) | v446 — Fase 4.1 del plan de acción (parte 2): Sentry en el frontend | fase/etapa (plan) |
| 447 | [CHANGELOG_v447_fase6_bump_firebase_admin_v14.md](v400-599/CHANGELOG_v447_fase6_bump_firebase_admin_v14.md) | v447 — Fase 6 (plan de acción): bump `firebase-admin` 12 → 14 | fase/etapa (plan) |
| 448 | [CHANGELOG_v448_fix_deploy_lockfile_node_engine.md](v400-599/CHANGELOG_v448_fix_deploy_lockfile_node_engine.md) | v448 — Fix real de deploy: lockfile desincronizado + Node engine insuficiente | fix |
| 467 | [CHANGELOG_v467_fix_colores_estados_pedidos.md](v400-599/CHANGELOG_v467_fix_colores_estados_pedidos.md) | v467 — Fix: colores de estado de pedidos inconsistentes entre pantallas | fix |
| 468 | [CHANGELOG_v468_cierre_admin002_admin003.md](v400-599/CHANGELOG_v468_cierre_admin002_admin003.md) | v468 — Cierre real de ADMIN-002 y ADMIN-003 (border-radius + colores hardcodeados restantes) | feature/otros |
| 469 | [CHANGELOG_v469_cierre_9_puntos.md](v400-599/CHANGELOG_v469_cierre_9_puntos.md) | v469 — Cierre de los 9 puntos ambiguos (radio + grises) | feature/otros |
| 474 | [CHANGELOG_v474_fix_boton_exportar_clientes_y_superposicion_stock.md](v400-599/CHANGELOG_v474_fix_boton_exportar_clientes_y_superposicion_stock.md) | CHANGELOG v474 — Fix botón "Más acciones" en clientes + superposición visual en stock | fix |
| 475 | [CHANGELOG_v475_cierre_tipografia_auditoria.md](v400-599/CHANGELOG_v475_cierre_tipografia_auditoria.md) | CHANGELOG v475 — Cierre definitivo del punto "tipografía" en AUDITORIA_UX_COMPLETA.md | auditoría |
| 476 | [CHANGELOG_v476_impersonar_choferes_accesos_rapidos.md](v400-599/CHANGELOG_v476_impersonar_choferes_accesos_rapidos.md) | CHANGELOG v476 — Acceso rápido del dueño a Catálogo, Proveedores y Choferes | feature/otros |
| 477 | [CHANGELOG_v477_fix_boton_ver_catalogo_no_cargaba.md](v400-599/CHANGELOG_v477_fix_boton_ver_catalogo_no_cargaba.md) | v477 — Fix: botón "Ver catálogo" (panel admin) abría el catálogo vacío | fix |
| 478 | [CHANGELOG_v478_toggle_catalogo_publico_panel_admin.md](v400-599/CHANGELOG_v478_toggle_catalogo_publico_panel_admin.md) | v478 — Toggle de catálogo público en Configuración (pendiente de v296/v477) | feature/otros |
| 479 | [CHANGELOG_v479_fix_404_redirect_impersonar_chofer.md](v400-599/CHANGELOG_v479_fix_404_redirect_impersonar_chofer.md) | v479 — Fix: "Ingresar como chofer" tiraba 404 tras el magic link | fix |
| 480 | [CHANGELOG_v480_botones_visibles_ingresar_invitar_chofer.md](v400-599/CHANGELOG_v480_botones_visibles_ingresar_invitar_chofer.md) | v480 — Botones "Ingresar al panel" / "Invitar chofer" visibles en Rutas | feature/otros |
| 481 | [CHANGELOG_v481_menu_mas_funciones_productos.md](v400-599/CHANGELOG_v481_menu_mas_funciones_productos.md) | v481 — Menú "Más funciones" agrupa Importar/Exportar/Buscar imágenes (Productos) | feature/otros |
| 491 | [CHANGELOG_v491_migracion_js_lote2_mecanico.md](v400-599/CHANGELOG_v491_migracion_js_lote2_mecanico.md) | v491 — Migración de colores en JS: lote 2 (fallbacks stale + hardcodeos mecánicos) | migración |
| 492 | [CHANGELOG_v492_migracion_js_lote3_categoricos.md](v400-599/CHANGELOG_v492_migracion_js_lote3_categoricos.md) | v492 — Migración de colores en JS: lote 3 (tokens categóricos + resto del frente) | migración |
| 497 | [CHANGELOG_v497_dashboard_v3_integracion_real_sec011.md](v400-599/CHANGELOG_v497_dashboard_v3_integracion_real_sec011.md) | v497 — Dashboard v3: integración con datos reales + SEC-011 | feature/otros |
| 498 | [CHANGELOG_v498_dashboard_v3_fase0_1_2_3.md](v400-599/CHANGELOG_v498_dashboard_v3_fase0_1_2_3.md) | CHANGELOG v498 — dashboard-v3.html: ejecución del plan de mejoras (Fases 0, 1, 2 y 3) | fase/etapa (plan) |
| 499 | [CHANGELOG_v499_asistente_acciones_escritura_confirmacion.md](v400-599/CHANGELOG_v499_asistente_acciones_escritura_confirmacion.md) | v499 — Asistente: acciones de escritura con confirmación explícita | asistente por voz/IA |
| 500 | [CHANGELOG_v500_asistente_crear_pedido.md](v400-599/CHANGELOG_v500_asistente_crear_pedido.md) | v500 — Asistente: "cargar un pedido" por chat (tool `crear_pedido`) | asistente por voz/IA |
| 501 | [CHANGELOG_v501_asistente_busqueda_aproximada_pg_trgm.md](v400-599/CHANGELOG_v501_asistente_busqueda_aproximada_pg_trgm.md) | v501 — Asistente: búsqueda aproximada (pg_trgm) para clientes/productos | asistente por voz/IA |
| 502 | [CHANGELOG_v502_asistente_presupuestos_y_lectura_imagenes.md](v400-599/CHANGELOG_v502_asistente_presupuestos_y_lectura_imagenes.md) | v502 — Asistente: `crear_presupuesto` + interpretar texto largo/imágenes (pedidos y presupuestos) | asistente por voz/IA |
| 510 | [CHANGELOG_v510_motor_automatizacion_tool_asistente.md](v400-599/CHANGELOG_v510_motor_automatizacion_tool_asistente.md) | v510 — Tool de chat `ejecutar_motor_automatizacion` | asistente por voz/IA |
| 511 | [CHANGELOG_v511_asistente_listar_pedidos_pendientes.md](v400-599/CHANGELOG_v511_asistente_listar_pedidos_pendientes.md) | v511 — Asistente: dejó de inventar pedidos pendientes | asistente por voz/IA |
| 512 | [CHANGELOG_v512_asistente_flexibilidad_general.md](v400-599/CHANGELOG_v512_asistente_flexibilidad_general.md) | v512 — Flexibilidad general del asistente (no solo pedidos) | asistente por voz/IA |
| 517 | [CHANGELOG_v517_filtrar_tools_por_rol_payload_groq.md](v400-599/CHANGELOG_v517_filtrar_tools_por_rol_payload_groq.md) | v517 — Filtrar el catálogo de tools por rol antes de armar el esquema | feature/otros |
| 518 | [CHANGELOG_v518_seleccion_dinamica_tools_por_pregunta.md](v400-599/CHANGELOG_v518_seleccion_dinamica_tools_por_pregunta.md) | v518 — Selección dinámica de tools por pregunta (Groq/OpenRouter) | feature/otros |
| 519 | [CHANGELOG_v519_groq_vision_fallback_mensaje_honesto_imagen.md](v400-599/CHANGELOG_v519_groq_vision_fallback_mensaje_honesto_imagen.md) | v519 — Groq como segunda opción de visión + mensaje honesto para fallos de imagen | feature/otros |
| 520 | [CHANGELOG_v520_groq_migracion_modelos_deprecados.md](v400-599/CHANGELOG_v520_groq_migracion_modelos_deprecados.md) | v520 — Migración de los 2 modelos Groq deprecados (visión + texto) | migración |
| 521 | [CHANGELOG_v521_groq_vision_sin_tools_413.md](v400-599/CHANGELOG_v521_groq_vision_sin_tools_413.md) | v521 — Sacar el catálogo de tools cuando hay imagen adjunta (413 en Groq visión) | feature/otros |
| 522 | [CHANGELOG_v522_groq_reasoning_format_hidden.md](v400-599/CHANGELOG_v522_groq_reasoning_format_hidden.md) | v522 — Groq filtraba su razonamiento interno (`<think>`) al chat | feature/otros |
| 523 | [CHANGELOG_v523_crear_cliente_tool.md](v400-599/CHANGELOG_v523_crear_cliente_tool.md) | v523 — Nueva tool `crear_cliente` (faltaba conectarla) | feature/otros |
| 526 | [CHANGELOG_v526_asistente_movimientos_stock_tool.md](v400-599/CHANGELOG_v526_asistente_movimientos_stock_tool.md) | v526 — Nueva tool `listar_movimientos_stock` (kardex sin conectar al asistente) | asistente por voz/IA |
| 527 | [CHANGELOG_v527_asistente_ordenes_compra_tool.md](v400-599/CHANGELOG_v527_asistente_ordenes_compra_tool.md) | v527 — Nueva tool `listar_ordenes_compra` (sin conectar al asistente) | asistente por voz/IA |
| 528 | [CHANGELOG_v528_asistente_movimientos_caja_tool.md](v400-599/CHANGELOG_v528_asistente_movimientos_caja_tool.md) | v528 — Nueva tool `listar_movimientos_caja` (sin conectar al asistente) | asistente por voz/IA |
| 529 | [CHANGELOG_v529_asistente_conteos_stock_tool.md](v400-599/CHANGELOG_v529_asistente_conteos_stock_tool.md) | v529 — Nueva tool `listar_conteos_stock` (sin conectar al asistente) | asistente por voz/IA |
| 530 | [CHANGELOG_v530_asistente_cobros_tool.md](v400-599/CHANGELOG_v530_asistente_cobros_tool.md) | v530 — Nueva tool `listar_cobros` (sin conectar al asistente) | asistente por voz/IA |
| 531 | [CHANGELOG_v531_asistente_notas_credito_tool.md](v400-599/CHANGELOG_v531_asistente_notas_credito_tool.md) | v531 — Nueva tool `listar_notas_credito` (sin conectar al asistente) | asistente por voz/IA |
| 532 | [CHANGELOG_v532_auditoria_cobranzas_pos.md](v400-599/CHANGELOG_v532_auditoria_cobranzas_pos.md) | v532 — Auditoría Cobranzas ↔ Caja/POS | auditoría |
| 533 | [CHANGELOG_v533_rediseno_zoom_dashboard.md](v400-599/CHANGELOG_v533_rediseno_zoom_dashboard.md) | v533 — Rediseño del "zoom" de los recuadros del dashboard | feature/otros |
| 538 | [CHANGELOG_v538_login_panel_marca_card_flotante.md](v400-599/CHANGELOG_v538_login_panel_marca_card_flotante.md) | v538 — Panel de marca del login: card flotante + texto legible + ícono Fluxo | feature/otros |
| 539 | [CHANGELOG_v539_login_panel_marca_fluxo.md](v400-599/CHANGELOG_v539_login_panel_marca_fluxo.md) | v539 — Panel de marca del login: bug de "Cargando..." fijo + rediseño Fluxo | feature/otros |
| 540 | [CHANGELOG_v540_login_sin_autologin.md](v400-599/CHANGELOG_v540_login_sin_autologin.md) | v540 — Login admin: nunca más auto-inicio de sesión | feature/otros |
| 542 | [CHANGELOG_v542_stock_minimo_entero.md](v400-599/CHANGELOG_v542_stock_minimo_entero.md) | v542 — `stock_minimo` pasa a entero | feature/otros |
| 543 | [CHANGELOG_v543_fix_boton_menu_todas_pantallas.md](v400-599/CHANGELOG_v543_fix_boton_menu_todas_pantallas.md) | v542 — Fix: botón de menú principal ausente en saas-billing.html | fix |
| 543 | [CHANGELOG_v543_generador_etiquetas_etapa1.md](v400-599/CHANGELOG_v543_generador_etiquetas_etapa1.md) | CHANGELOG v543 — Generador de etiquetas de precio/código de barras, Etapa 1 (motor de impresión) | fase/etapa (plan) |
| 544 | [CHANGELOG_v544_fix_productos_filtro_mes_vacio.md](v400-599/CHANGELOG_v544_fix_productos_filtro_mes_vacio.md) | v544 — Fix: catálogo de Productos aparecía vacío ("0 productos") | fix |
| 545 | [CHANGELOG_v545_kpi-line_rediseno_tarjetas.md](v400-599/CHANGELOG_v545_kpi-line_rediseno_tarjetas.md) | v545 — Rediseño de indicadores KPI: de tira de manifiesto a tarjetas | feature/otros |
| 548 | [CHANGELOG_v548_fase3_despachador_eventos.md](v400-599/CHANGELOG_v548_fase3_despachador_eventos.md) | v548 — Fase 3 del plan de sincronización ERP: despachador de eventos | fase/etapa (plan) |
| 549 | [CHANGELOG_v549_fase4_notificaciones_unificadas.md](v400-599/CHANGELOG_v549_fase4_notificaciones_unificadas.md) | v549 — Fase 4 del plan de sincronización ERP: notificaciones unificadas | fase/etapa (plan) |
| 550 | [CHANGELOG_v550_fase4_rls_notif_log_y_centro_notificaciones.md](v400-599/CHANGELOG_v550_fase4_rls_notif_log_y_centro_notificaciones.md) | v550 — Fix RLS de `notif_log` + generalización del centro de notificaciones | fix |
| 554 | [CHANGELOG_v554_fase5_auditoria_negocio_centralizada.md](v400-599/CHANGELOG_v554_fase5_auditoria_negocio_centralizada.md) | v554 — Auditoría de negocio centralizada (Fase 5, plan ERP) | auditoría |
| 555 | [CHANGELOG_v555_etapa6_fix_push_derivar_humano.md](v400-599/CHANGELOG_v555_etapa6_fix_push_derivar_humano.md) | v555 — Etapa 6 (WhatsApp bidireccional): fix push en derivación manual + cobertura de tests | fix |
| 556 | [CHANGELOG_v556_etapa6_tests_motor_conversacion.md](v400-599/CHANGELOG_v556_etapa6_tests_motor_conversacion.md) | v556 — Etapa 6 (WhatsApp bidireccional): cobertura de tests del motor de conversación | fase/etapa (plan) |
| 557 | [CHANGELOG_v557_etapa7_tests_embedded_signup.md](v400-599/CHANGELOG_v557_etapa7_tests_embedded_signup.md) | v557 — Etapa 7 (Embedded Signup): tests del handler + checklist actualizado | fase/etapa (plan) |
| 559 | [CHANGELOG_v559_fase6_reglas_automatizacion.md](v400-599/CHANGELOG_v559_fase6_reglas_automatizacion.md) | v559 — Fase 6: motor de automatización sobre el bus de eventos ("Reglas personalizadas") | fase/etapa (plan) |
| 560 | [CHANGELOG_v560_fase6b_whatsapp_y_tareas_automatizacion.md](v400-599/CHANGELOG_v560_fase6b_whatsapp_y_tareas_automatizacion.md) | v560 — Fase 6b: acciones "enviar_whatsapp" y "crear_tarea" para reglas de automatización | fase/etapa (plan) |
| 571 | [CHANGELOG_v571_fase7_productos_lote1.md](v400-599/CHANGELOG_v571_fase7_productos_lote1.md) | v571 — Fase 7, paso 3: `lib/repos/productos.js` (lote 1, 6 handlers) | fase/etapa (plan) |
| 572 | [CHANGELOG_v572_fase7_productos_lote2.md](v400-599/CHANGELOG_v572_fase7_productos_lote2.md) | v572 — Fase 7: `lib/repos/productos.js` lote 2 — `productos` queda cerrado salvo pedidos/pos | fase/etapa (plan) |
| 573 | [CHANGELOG_v573_fase7_cta_cte.md](v400-599/CHANGELOG_v573_fase7_cta_cte.md) | v573 — Fase 7, paso 4: `lib/repos/cta-cte.js` — cerrado en un solo paso | fase/etapa (plan) |
| 574 | [CHANGELOG_v574_fase7_permisos_importar_bcra.md](v400-599/CHANGELOG_v574_fase7_permisos_importar_bcra.md) | v574 — Fase 7, sección 2: `importar.js` y `bcra.js` migrados a PermisosService | fase/etapa (plan) |
| 575 | [CHANGELOG_v575_fase7_permisos_busqueda_ciclos.md](v400-599/CHANGELOG_v575_fase7_permisos_busqueda_ciclos.md) | v575 — Fase 7, sección 2: `busqueda.js` y `ciclos.js` migrados a PermisosService | fase/etapa (plan) |
| 576 | [CHANGELOG_v576_fase7_permisos_admin_autoimg_clientes_empresa.md](v400-599/CHANGELOG_v576_fase7_permisos_admin_autoimg_clientes_empresa.md) | v576 — Fase 7, sección 2: `admin.js`, `auto-imagenes.js`, `clientes.js` y `empresa.js` migrados a PermisosService | fase/etapa (plan) |
| 579 | [CHANGELOG_v579_fase7_permisos_pedidos.md](v400-599/CHANGELOG_v579_fase7_permisos_pedidos.md) | v579 — Fase 7, sección 2: `pedidos.js` migrado a PermisosService (helper `rolesDe` + 4 gates) | fase/etapa (plan) |
| 580 | [CHANGELOG_v580_fase7_permisos_pos.md](v400-599/CHANGELOG_v580_fase7_permisos_pos.md) | v580 — Fase 7, sección 2: `pos.js` migrado a PermisosService — sección 2 CERRADA | fase/etapa (plan) |
| 581 | [CHANGELOG_v581_fase7_stock.md](v400-599/CHANGELOG_v581_fase7_stock.md) | v581 — Fase 7, paso 5: `lib/repos/stock.js` — cerrado | fase/etapa (plan) |
| 582 | [CHANGELOG_v582_fase7_notif_lote1_alertas_cron.md](v400-599/CHANGELOG_v582_fase7_notif_lote1_alertas_cron.md) | v582 — Fase 7, paso 7, lote 1: `notif.js` — alertas operativas por cron | fase/etapa (plan) |
| 582 | [CHANGELOG_v582_fase7_notif_lote4_whatsapp_bot.md](v400-599/CHANGELOG_v582_fase7_notif_lote4_whatsapp_bot.md) | v582 — Fase 7, paso 7, lote 4 (cierre): bot conversacional de WhatsApp | fase/etapa (plan) |
| 583 | [CHANGELOG_v583_fase7_pedidos_lote1_presupuestos.md](v400-599/CHANGELOG_v583_fase7_pedidos_lote1_presupuestos.md) | v583 — Fase 7, paso 8, lote 1: repo de datos de `presupuestos` | fase/etapa (plan) |
| 586 | [CHANGELOG_v586_fase7_pedidos_lote4_sub1_notif_puntos.md](v400-599/CHANGELOG_v586_fase7_pedidos_lote4_sub1_notif_puntos.md) | v586 — Fase 7, paso 8, lote 4 (sub-lote 1: notificaciones y puntos) | fase/etapa (plan) |
| 587 | [CHANGELOG_v587_fase7_pedidos_lote4_sub2_router_principal.md](v400-599/CHANGELOG_v587_fase7_pedidos_lote4_sub2_router_principal.md) | v587 — Fase 7, paso 8, lote 4 (sub-lote 2: router principal) | fase/etapa (plan) |
| 588 | [CHANGELOG_v588_fase7_pos_lote4_nucleo_venta.md](v400-599/CHANGELOG_v588_fase7_pos_lote4_nucleo_venta.md) | v588 — Fase 7, paso 9, sub-lote 4: núcleo transaccional de `pos.js` — paso 9 CERRADO | fase/etapa (plan) |
| 589 | [CHANGELOG_v589_fix_cron_hobby_eventos_reprocesar.md](v400-599/CHANGELOG_v589_fix_cron_hobby_eventos_reprocesar.md) | v589 — Fix: cron de reprocesamiento de eventos excedía el límite del plan Hobby | fix |
| 590 | [CHANGELOG_v590_centro_notificaciones_chofer.md](v400-599/CHANGELOG_v590_centro_notificaciones_chofer.md) | v590 — Centro de notificaciones: último portal que faltaba (chofer) | feature/otros |
| 591 | [CHANGELOG_v591_fase7_migracion.md](v400-599/CHANGELOG_v591_fase7_migracion.md) | v591 — Fase 7, paso siguiente a `pos.js`: `migracion.js` — CERRADO | fase/etapa (plan) |
| 592 | [CHANGELOG_v592_fase7_migracion_portal_proveedor.md](v400-599/CHANGELOG_v592_fase7_migracion_portal_proveedor.md) | v592 — Fase 7, orden de migración pedido por el usuario: `portal_proveedor` — CERRADO | fase/etapa (plan) |
| 593 | [CHANGELOG_v593_fase7_migracion_cc_proveedores.md](v400-599/CHANGELOG_v593_fase7_migracion_cc_proveedores.md) | v593 — Fase 7, orden de migración pedido por el usuario: `cc_proveedores` — CERRADO | fase/etapa (plan) |
| 594 | [CHANGELOG_v594_fase7_migracion_automatizacion.md](v400-599/CHANGELOG_v594_fase7_migracion_automatizacion.md) | v594 — Fase 7, orden de migración pedido por el usuario: `automatizacion` — CERRADO | fase/etapa (plan) |
| 595 | [CHANGELOG_v595_fase7_migracion_stock_auto.md](v400-599/CHANGELOG_v595_fase7_migracion_stock_auto.md) | v595 — Fase 7, orden de migración pedido por el usuario: `stock-auto` — CERRADO | fase/etapa (plan) |
| 596 | [CHANGELOG_v596_fase7_migracion_notif_auto_y_push.md](v400-599/CHANGELOG_v596_fase7_migracion_notif_auto_y_push.md) | v596 — Fase 7, migración de `notifAuto` (_auto-push.js) y `enviarPush` (_push.js) — CERRADO | fase/etapa (plan) |
| 597 | [CHANGELOG_v597_fase7_repo_auditoria.md](v400-599/CHANGELOG_v597_fase7_repo_auditoria.md) | v597 — Fase 7, `lib/repos/audit.js` (nuevo) — CERRADO | auditoría |
| 599 | [CHANGELOG_v599_fase8_observabilidad_continua.md](v400-599/CHANGELOG_v599_fase8_observabilidad_continua.md) | v599 — Fase 8, observabilidad continua (PLAN_ERP_SINCRONIZACION_2026.md) | fase/etapa (plan) |

## v600 – v799 (105 archivos)

| Versión | Archivo | Título | Categoría |
|---|---|---|---|
| 601 | [CHANGELOG_v601_fase7_cierre_11_handlers_chicos.md](v600-799/CHANGELOG_v601_fase7_cierre_11_handlers_chicos.md) | CHANGELOG v601 — Fase 7: cierre de los 11 handlers "chicos" (repos dedicados) | fase/etapa (plan) |
| 602 | [CHANGELOG_v602_bump_meta_api_version_v19_a_v22.md](v600-799/CHANGELOG_v602_bump_meta_api_version_v19_a_v22.md) | v602 — Bump META_API_VERSION de v19.0 a v22.0 | feature/otros |
| 603 | [CHANGELOG_v603_fix_wiring_tools_whatsapp_y_totales.md](v600-799/CHANGELOG_v603_fix_wiring_tools_whatsapp_y_totales.md) | v603 — Fix crítico: el bot de pedidos por WhatsApp nunca tenía tools ni catálogo real + devolución de precios/total | fix |
| 606 | [CHANGELOG_v606_whatsapp_aviso_conversaciones_estancadas.md](v600-799/CHANGELOG_v606_whatsapp_aviso_conversaciones_estancadas.md) | v606 — Aviso automático de pedidos de WhatsApp que quedan sin cerrar | feature/otros |
| 607 | [CHANGELOG_v607_fix_scroll_modal_y_refresco_chat_whatsapp_conversaciones.md](v600-799/CHANGELOG_v607_fix_scroll_modal_y_refresco_chat_whatsapp_conversaciones.md) | v607 — Fix: modal de conversación de WhatsApp sin scroll + mensajes nuevos invisibles | fix |
| 608 | [CHANGELOG_v608_onboarding_wa_elimina_crear_nuevo_solo_coexistencia.md](v600-799/CHANGELOG_v608_onboarding_wa_elimina_crear_nuevo_solo_coexistencia.md) | v608 — Onboarding WhatsApp: se elimina por completo "Crear WhatsApp Business nuevo" | feature/otros |
| 609 | [CHANGELOG_v609_paginas_legales_whatsapp_y_eliminacion_datos.md](v600-799/CHANGELOG_v609_paginas_legales_whatsapp_y_eliminacion_datos.md) | v609 — Páginas legales: se agrega mención a WhatsApp Business y página de eliminación de datos | feature/otros |
| 610 | [CHANGELOG_v610_redistribucion_fechas_datos_demo.md](v600-799/CHANGELOG_v610_redistribucion_fechas_datos_demo.md) | v610 — Redistribución de fechas en los datos de la empresa demo | feature/otros |
| 614 | [CHANGELOG_v614_vinculo_celular_persistente.md](v600-799/CHANGELOG_v614_vinculo_celular_persistente.md) | v614 — Vínculo celular persistente (sliding expiration + reconexión) | feature/otros |
| 615 | [CHANGELOG_v615_boton_estado_y_filtro_link.md](v600-799/CHANGELOG_v615_boton_estado_y_filtro_link.md) | v615 — Botón "Vincular celular" con estado persistente + filtro del propio link | feature/otros |
| 616 | [CHANGELOG_v616_fix_no_vincula_evento_listo.md](v600-799/CHANGELOG_v616_fix_no_vincula_evento_listo.md) | v616 — Fix: el vínculo se quedaba en "Vinculando…" para siempre | fix |
| 617 | [CHANGELOG_v617_integracion_escaner_remoto.md](v600-799/CHANGELOG_v617_integracion_escaner_remoto.md) | CHANGELOG v617 — Integración escáner remoto en distribución completa | feature/otros |
| 618 | [CHANGELOG_v618_escaner_autocompleta_nombre_foto.md](v600-799/CHANGELOG_v618_escaner_autocompleta_nombre_foto.md) | CHANGELOG v618 — Escáner de producto autocompleta nombre y foto | feature/otros |
| 619 | [CHANGELOG_v619_fix_escaner_producto_se_desvinculaba.md](v600-799/CHANGELOG_v619_fix_escaner_producto_se_desvinculaba.md) | CHANGELOG v619 — Fix: escáner de producto se desvinculaba tras el primer código | fix |
| 620 | [CHANGELOG_v620_stock_vinculo_persistente_consistente_con_pos.md](v600-799/CHANGELOG_v620_stock_vinculo_persistente_consistente_con_pos.md) | CHANGELOG v620 — Stock: mismo patrón de vínculo persistente que POS | feature/otros |
| 620 | [CHANGELOG_v620_vinculo_celular_pos_sobrevive_recarga.md](v600-799/CHANGELOG_v620_vinculo_celular_pos_sobrevive_recarga.md) | v620 — Vínculo de celular del POS sobrevive recarga/navegación | feature/otros |
| 622 | [CHANGELOG_v622_fix_cors_busqueda_externa_banco_codigos.md](v600-799/CHANGELOG_v622_fix_cors_busqueda_externa_banco_codigos.md) | v622 — Fix: escanear un código nuevo no traía nombre ni foto (CORS) | fix |
| 623 | [CHANGELOG_v623_fix_limpieza_busqueda_paralela.md](v600-799/CHANGELOG_v623_fix_limpieza_busqueda_paralela.md) | CHANGELOG v623 — Fix: productos de limpieza sin nombre ni foto al escanear | fix |
| 624 | [CHANGELOG_v624_fix_openbeautyfacts_higiene_personal.md](v600-799/CHANGELOG_v624_fix_openbeautyfacts_higiene_personal.md) | CHANGELOG v624 — Fix: higiene personal sin nombre ni foto (Open Beauty Facts) | fix |
| 625 | [CHANGELOG_v625_serper_banco_codigos_y_fix_revinculo.md](v600-799/CHANGELOG_v625_serper_banco_codigos_y_fix_revinculo.md) | CHANGELOG v625 — Imagen precisa (sin ML) + refrescar cache + fix reconexión celular | fix |
| 626 | [CHANGELOG_v626_fix_definitivo_boton_imagen_incorrecta.md](v600-799/CHANGELOG_v626_fix_definitivo_boton_imagen_incorrecta.md) | v626 — Fix definitivo: botón "Imagen incorrecta" + refresco de imagen | fix |
| 627 | [CHANGELOG_v627_multi_candidata_imagen_infalible.md](v600-799/CHANGELOG_v627_multi_candidata_imagen_infalible.md) | CHANGELOG v627 — Multi-candidata infalible para imágenes por scanner | feature/otros |
| 628 | [CHANGELOG_v628_shopping_gtin_para_imagen_precisa.md](v600-799/CHANGELOG_v628_shopping_gtin_para_imagen_precisa.md) | CHANGELOG v628 — Google Shopping (por GTIN) como fuente adicional para imagen | feature/otros |
| 631 | [CHANGELOG_v631_fix_modal_scale_pegado.md](v600-799/CHANGELOG_v631_fix_modal_scale_pegado.md) | v631 — Fix: modal de producto no abría del todo (transform pegado) | fix |
| 632 | [CHANGELOG_v632_fix_grid_blowout_modal_producto.md](v600-799/CHANGELOG_v632_fix_grid_blowout_modal_producto.md) | v632 — Fix: formulario de producto se veía cortado / se escapaba del borde de la pantalla | fix |
| 633 | [CHANGELOG_v633_fix_zindex_confirm_toast_productos.md](v600-799/CHANGELOG_v633_fix_zindex_confirm_toast_productos.md) | v633 — Fix z-index: confirm y toast por encima del panel de producto | fix |
| 634 | [CHANGELOG_v634_font_size_menu_principal.md](v600-799/CHANGELOG_v634_font_size_menu_principal.md) | v634 — Tamaño de fuente del Menú principal aumentado 1px | feature/otros |
| 635 | [CHANGELOG_v635_boton_nuevo_producto_texto.md](v600-799/CHANGELOG_v635_boton_nuevo_producto_texto.md) | v635 — Botón "+" reemplazado por "Nuevo producto" con texto visible | feature/otros |
| 636 | [CHANGELOG_v636_responsive_mobile_global.md](v600-799/CHANGELOG_v636_responsive_mobile_global.md) | v636 — Responsive mobile: auditoría exhaustiva y corrección global | feature/otros |
| 637 | [CHANGELOG_v637_mobile_dashboard_completo.md](v600-799/CHANGELOG_v637_mobile_dashboard_completo.md) | v637 — Dashboard mobile: rediseño completo y funcional | feature/otros |
| 643 | [CHANGELOG_v643_offline_etapa2_cliente_proveedor.md](v600-799/CHANGELOG_v643_offline_etapa2_cliente_proveedor.md) | v643 — Plan offline, Etapa 2: Service Worker + manifest para cliente y proveedor | fase/etapa (plan) |
| 644 | [CHANGELOG_v644_offline_etapa3_idempotencia_chofer.md](v600-799/CHANGELOG_v644_offline_etapa3_idempotencia_chofer.md) | v644 — Plan offline, Etapa 3: idempotencia de confirmaciones del chofer + outbox | fase/etapa (plan) |
| 645 | [CHANGELOG_v645_offline_etapa3_idempotencia_cliente_admin.md](v600-799/CHANGELOG_v645_offline_etapa3_idempotencia_cliente_admin.md) | v645 — Plan offline, Etapa 3, ítem 1: crear pedido offline (cliente/admin) | fase/etapa (plan) |
| 646 | [CHANGELOG_v646_offline_etapa3_aplicacion_real_supabase.md](v600-799/CHANGELOG_v646_offline_etapa3_aplicacion_real_supabase.md) | v646 — Plan offline, Etapa 3: aplicación REAL contra Supabase (441-445) | fase/etapa (plan) |
| 650 | [CHANGELOG_v650_offline_etapa1_offline_core_dexie.md](v600-799/CHANGELOG_v650_offline_etapa1_offline_core_dexie.md) | CHANGELOG v650 — Plan offline, Etapa 1: OfflineCore genérico (Dexie) | fase/etapa (plan) |
| 651 | [CHANGELOG_v651_offline_etapa4_ui_conflicto.md](v600-799/CHANGELOG_v651_offline_etapa4_ui_conflicto.md) | CHANGELOG v651 — Plan offline, Etapa 4: UI de conflicto en los 5 módulos | fase/etapa (plan) |
| 652 | [CHANGELOG_v652_offline_etapa4_tests_integrados.md](v600-799/CHANGELOG_v652_offline_etapa4_tests_integrados.md) | v652 — Etapa 4 offline: tests reconstruidos e integrados | fase/etapa (plan) |
| 657 | [CHANGELOG_v657_fix_guard_mp_publico_y_outbox_whatsapp.md](v600-799/CHANGELOG_v657_fix_guard_mp_publico_y_outbox_whatsapp.md) | v657 — Fix del guard de MP público (Etapa 5) + outbox de salientes de WhatsApp (Etapa 5, punto 3, cierre) | fix |
| 658 | [CHANGELOG_v658_offline_etapa3_proveedor.md](v600-799/CHANGELOG_v658_offline_etapa3_proveedor.md) | v658 — Portal proveedor: escritura offline (Plan offline, Etapa 3, cierre) | fase/etapa (plan) |
| 659 | [CHANGELOG_v659_e2e_offline_etapa6_playwright.md](v600-799/CHANGELOG_v659_e2e_offline_etapa6_playwright.md) | v659 — Etapa 6 (sección 1.2): suite E2E Playwright para offline, + corrida real de vitest sobre v658 | fase/etapa (plan) |
| 660 | [CHANGELOG_v660_fix_static_server_sw_scope_y_404_redirects.md](v600-799/CHANGELOG_v660_fix_static_server_sw_scope_y_404_redirects.md) | v660 — Fix de los 2 problemas pendientes de v659 (83/90 → verificado sin esos 7 fallos) | fix |
| 661 | [CHANGELOG_v661_fix_e2e_sw_bypassa_mocks_api.md](v600-799/CHANGELOG_v661_fix_e2e_sw_bypassa_mocks_api.md) | v661 — Fix de los 3 fallos que dejó v660 (87/90 → 90/90) | fix |
| 684 | [CHANGELOG_v684_fase7_tests_creacion_confirmacion_pedido.md](v600-799/CHANGELOG_v684_fase7_tests_creacion_confirmacion_pedido.md) | CHANGELOG v684 — Fase 7: tests dedicados al circuito de creación/confirmación de pedido | fase/etapa (plan) |
| 685 | [CHANGELOG_v685_fase8_distincion_pendientes_sin_listener.md](v600-799/CHANGELOG_v685_fase8_distincion_pendientes_sin_listener.md) | v685 — Fase 8: distinguir "pendiente sin listener" de cola atascada | fase/etapa (plan) |
| 690 | [CHANGELOG_v690_cantidades_solo_enteros.md](v600-799/CHANGELOG_v690_cantidades_solo_enteros.md) | v690 — Cantidades solo enteras en todo el sistema | feature/otros |
| 692 | [CHANGELOG_v692_botones_zocalo_a_page_actions.md](v600-799/CHANGELOG_v692_botones_zocalo_a_page_actions.md) | v692 — Sacar botones de acción del zócalo (`.topbar`) a `.page-actions` | feature/otros |
| 693 | [CHANGELOG_v693_encabezados_agrupados_admin.md](v600-799/CHANGELOG_v693_encabezados_agrupados_admin.md) | v693 — Encabezados de tabla agrupados en pantallas del admin | feature/otros |
| 698 | [CHANGELOG_v698.md](v600-799/CHANGELOG_v698.md) | v698 — Estado vacío diferenciado en Conversaciones WhatsApp | feature/otros |
| 699 | [CHANGELOG_v699_responsive_mobile_runtime_js.md](v600-799/CHANGELOG_v699_responsive_mobile_runtime_js.md) | v699 — Responsive mobile: script runtime de refuerzo + cierre de auditoría | feature/otros |
| 700 | [CHANGELOG_v700_dashboard_paneles_ventas_whatsapp_rediseno.md](v600-799/CHANGELOG_v700_dashboard_paneles_ventas_whatsapp_rediseno.md) | v700 — Rediseño paneles A (Ventas) y B (WhatsApp) del dashboard admin | feature/otros |
| 705 | [CHANGELOG_v705_integracion_fuente_zonas_dropdown_clientes.md](v600-799/CHANGELOG_v705_integracion_fuente_zonas_dropdown_clientes.md) | v705 — Integración: tamaño de fuente en zonas + fix dropdown clientes | fix |
| 706 | [CHANGELOG_v706_fix_filtros_pedidos_mobile_colapsables.md](v600-799/CHANGELOG_v706_fix_filtros_pedidos_mobile_colapsables.md) | v706 — Fix: sección de filtros de Pedidos gigante en mobile | fix |
| 707 | [CHANGELOG_v707_revision_filtros_der_resto_paginas.md](v600-799/CHANGELOG_v707_revision_filtros_der_resto_paginas.md) | v707 — Revisión de `.filtros-der` en las páginas admin restantes | feature/otros |
| 708 | [CHANGELOG_v708_fix_sw_cachea_precio_catalogo_cliente.md](v600-799/CHANGELOG_v708_fix_sw_cachea_precio_catalogo_cliente.md) | v708 — Fix: Service Worker cacheaba el precio del catálogo cliente (SWR) | fix |
| 709 | [CHANGELOG_v709_asistente_registrar_cobro_cliente_por_voz.md](v600-799/CHANGELOG_v709_asistente_registrar_cobro_cliente_por_voz.md) | v709 — Nueva tool `registrar_cobro_cliente` (Fase A, ítem 1 del plan de operación por voz) | fase/etapa (plan) |
| 710 | [CHANGELOG_v710_asistente_crud_productos_por_voz.md](v600-799/CHANGELOG_v710_asistente_crud_productos_por_voz.md) | v710 — Nuevas tools `crear_producto` y `editar_producto` (Fase A, ítem 2) | fase/etapa (plan) |
| 711 | [CHANGELOG_v711_asistente_anular_factura_por_voz.md](v600-799/CHANGELOG_v711_asistente_anular_factura_por_voz.md) | v711 — Nueva tool `anular_factura` (Fase A, ítem 3 — primera mitad) | fase/etapa (plan) |
| 712 | [CHANGELOG_v712_asistente_emitir_factura_por_voz.md](v600-799/CHANGELOG_v712_asistente_emitir_factura_por_voz.md) | v712 — Nueva tool `emitir_factura` (Fase A, ítem 3 — cierre) | fase/etapa (plan) |
| 713 | [CHANGELOG_v713_asistente_stock_y_ordenes_compra_por_voz.md](v600-799/CHANGELOG_v713_asistente_stock_y_ordenes_compra_por_voz.md) | v713 — Nuevas tools `ajustar_stock_asistente`, `registrar_conteo_stock_asistente`, | asistente por voz/IA |
| 714 | [CHANGELOG_v714_asistente_reglas_automatizacion_por_voz.md](v600-799/CHANGELOG_v714_asistente_reglas_automatizacion_por_voz.md) | v714 — Nuevas tools `listar_reglas_automatizacion_asistente`, | asistente por voz/IA |
| 715 | [CHANGELOG_v715_plan_reconciliado_exclusion_usuarios.md](v600-799/CHANGELOG_v715_plan_reconciliado_exclusion_usuarios.md) | v715 — Reconciliación de `PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md` con | asistente por voz/IA |
| 716 | [CHANGELOG_v716_asistente_liquidacion_por_voz.md](v600-799/CHANGELOG_v716_asistente_liquidacion_por_voz.md) | v716 — Asistente: liquidación por voz (Fase D, cierre del plan) | fase/etapa (plan) |
| 717 | [CHANGELOG_v717_fix_helpers_faltantes_regla_precio_asistente.md](v600-799/CHANGELOG_v717_fix_helpers_faltantes_regla_precio_asistente.md) | v717 — Fix: helpers faltantes de `crear_regla_precio_asistente`/`editar_regla_precio_asistente` | fix |
| 718 | [CHANGELOG_v718_auditoria_real_facturas.md](v600-799/CHANGELOG_v718_auditoria_real_facturas.md) | v718 — Auditoría real de facturas: quién emitió/anuló cada comprobante | auditoría |
| 719 | [CHANGELOG_v719_reset_password_whatsapp_cliente.md](v600-799/CHANGELOG_v719_reset_password_whatsapp_cliente.md) | v719 — Reset de contraseña por WhatsApp (portal cliente) | feature/otros |
| 725 | [CHANGELOG_v725_compactacion_devoluciones.md](v600-799/CHANGELOG_v725_compactacion_devoluciones.md) | CHANGELOG v725 — Compactación pantalla Devoluciones | feature/otros |
| 729 | [CHANGELOG_v729_migracion_colores_js_fallbacks.md](v600-799/CHANGELOG_v729_migracion_colores_js_fallbacks.md) | v729 — Cierre del residuo de paleta vieja en JS + fix de fallbacks desincronizados | fix |
| 730 | [CHANGELOG_v730_productos_js.md](v600-799/CHANGELOG_v730_productos_js.md) | v730 — `productos.js`: primer archivo del frente de hex crudo real | feature/otros |
| 731 | [CHANGELOG_v731_remito_vincular_celular.md](v600-799/CHANGELOG_v731_remito_vincular_celular.md) | v731 — `remito.js` (excepción) + `vincular-celular.js` (migrado completo) | feature/otros |
| 735 | [CHANGELOG_v735_alerta_score_banner_clickeable.md](v600-799/CHANGELOG_v735_alerta_score_banner_clickeable.md) | v735 — Banner "caída reciente de score" ahora clickeable → filtra la tabla | feature/otros |
| 736 | [CHANGELOG_v736_conciliacion_autoseleccion_extracto.md](v600-799/CHANGELOG_v736_conciliacion_autoseleccion_extracto.md) | v736 — Conciliación bancaria: auto-selecciona el extracto más reciente al abrir | feature/otros |
| 737 | [CHANGELOG_v737_observabilidad_pills_filtrotabs.md](v600-799/CHANGELOG_v737_observabilidad_pills_filtrotabs.md) | v737 — Observabilidad: tarjetas genéricas → pills FiltroTabs (mismo estilo que Cheques/Cobranzas) | feature/otros |
| 738 | [CHANGELOG_v738_gestion_etiquetas_panel_filtros_productos.md](v600-799/CHANGELOG_v738_gestion_etiquetas_panel_filtros_productos.md) | CHANGELOG v738 — Gestión de etiquetas integrada al panel de filtros de Productos | feature/otros |
| 739 | [CHANGELOG_v739_soporte_tarjetas_bento_rediseno.md](v600-799/CHANGELOG_v739_soporte_tarjetas_bento_rediseno.md) | CHANGELOG v739 — Rediseño visual de /admin/soporte.html (tarjetas genéricas → color pleno por categoría) | feature/otros |
| 740 | [CHANGELOG_v740_bento_stats_notif_log.md](v600-799/CHANGELOG_v740_bento_stats_notif_log.md) | CHANGELOG v740 — Bento grid para las stats de /admin/notif-log.html | feature/otros |
| 741 | [CHANGELOG_v741_fix_logo_no_se_visualiza_bucket_privado.md](v600-799/CHANGELOG_v741_fix_logo_no_se_visualiza_bucket_privado.md) | CHANGELOG v741 — Fix: el logo se sube pero no se visualiza (bucket privado + getPublicUrl) | fix |
| 742 | [CHANGELOG_v742_fix_toast_modal_categorias_y_crear_etiqueta.md](v600-799/CHANGELOG_v742_fix_toast_modal_categorias_y_crear_etiqueta.md) | CHANGELOG v742 — Fix: toast pide un "Estado inactivo" que no existe + modal "Administrar categorías" se abre tapado | fix |
| 743 | [CHANGELOG_v743_fix_cache_busting_y_rename_inactivo.md](v600-799/CHANGELOG_v743_fix_cache_busting_y_rename_inactivo.md) | CHANGELOG v743 — El modal de categorías seguía tapado y "Inactivo" seguía sin verse | fix |
| 744 | [CHANGELOG_v744_logo_topbar_admin_y_catalogo_publico.md](v600-799/CHANGELOG_v744_logo_topbar_admin_y_catalogo_publico.md) | v744 — Logo de la empresa en la barra superior del admin y en el catálogo público | feature/otros |
| 746 | [CHANGELOG_v746_pos_terminal_profesional.md](v600-799/CHANGELOG_v746_pos_terminal_profesional.md) | v746 — Reestructuración total del Punto de Venta (terminal profesional) | feature/otros |
| 747 | [CHANGELOG_v747_reportes_incluyen_ventas_pos.md](v600-799/CHANGELOG_v747_reportes_incluyen_ventas_pos.md) | v747 — Reportes financieros y de ventas ahora incluyen ventas de mostrador (POS) | feature/otros |
| 750 | [CHANGELOG_v750_gastos_generales_abm_y_wiring_completo.md](v600-799/CHANGELOG_v750_gastos_generales_abm_y_wiring_completo.md) | CHANGELOG v750 — Gastos Generales: ABM completo + wiring de Ganancia Neta | feature/otros |
| 751 | [CHANGELOG_v751_atajos_teclado_pos_ampliados.md](v600-799/CHANGELOG_v751_atajos_teclado_pos_ampliados.md) | v751 — Atajos de teclado del POS ampliados | feature/otros |
| 752 | [CHANGELOG_v752_atajos_teclado_pos_respaldo_digito.md](v600-799/CHANGELOG_v752_atajos_teclado_pos_respaldo_digito.md) | v752 — Atajos de teclado del POS: respaldo con dígito (1-0) cuando la fila F no llega al navegador | feature/otros |
| 753 | [CHANGELOG_v753_pos_enter_cobra_y_blur_buscador.md](v600-799/CHANGELOG_v753_pos_enter_cobra_y_blur_buscador.md) | v753 — POS: Enter cobra en reposo, el buscador libera el foco solo, hints con dígito | feature/otros |
| 754 | [CHANGELOG_v754_pos_enter_modal_cobro_tolerancia.md](v600-799/CHANGELOG_v754_pos_enter_modal_cobro_tolerancia.md) | v754 — POS: Enter en el modal de cobro no confirmaba con centavos de diferencia | feature/otros |
| 755 | [CHANGELOG_v755_pos_sin_decimales.md](v600-799/CHANGELOG_v755_pos_sin_decimales.md) | v755 — POS: eliminación de decimales/centavos en caja | feature/otros |
| 756 | [CHANGELOG_v756_pos_enter_modales_factura_ticket.md](v600-799/CHANGELOG_v756_pos_enter_modales_factura_ticket.md) | v756 — POS: Enter también en los modales "¿Emitir factura?" y "Venta registrada" | feature/otros |
| 757 | [CHANGELOG_v757_pos_foco_nueva_venta.md](v600-799/CHANGELOG_v757_pos_foco_nueva_venta.md) | v757 — POS: foco automático en "Nueva venta" tras cerrar/facturar | feature/otros |
| 758 | [CHANGELOG_v758_pos_ticket_impresion_termica.md](v600-799/CHANGELOG_v758_pos_ticket_impresion_termica.md) | v758 — POS: impresión de ticket con formato de comprobante térmico real | feature/otros |
| 762 | [CHANGELOG_v762_pos_terminal_prisma.md](v600-799/CHANGELOG_v762_pos_terminal_prisma.md) | v762 — Terminal de pago Prisma reemplaza al driver "Lapos" (falso) del POS | feature/otros |
| 763 | [CHANGELOG_v763_prisma_api_real.md](v600-799/CHANGELOG_v763_prisma_api_real.md) | v763 — Terminal Prisma: corregido contra la documentación real de la API | feature/otros |
| 768 | [CHANGELOG_v768_etapa7_responsive_paginas_publicas.md](v600-799/CHANGELOG_v768_etapa7_responsive_paginas_publicas.md) | v768 — Etapa 7: páginas públicas (cierre del plan de auditoría responsive) | fase/etapa (plan) |
| 769 | [CHANGELOG_v769_auditoria_pos_etapa1_kardex_anulacion.md](v600-799/CHANGELOG_v769_auditoria_pos_etapa1_kardex_anulacion.md) | CHANGELOG v769 — Auditoría funcional Etapa 1 (POS): kardex en anulación de venta | auditoría |
| 771 | [CHANGELOG_v771_auditoria_etapa2_pedidos_facturacion_arca_ctacte.md](v600-799/CHANGELOG_v771_auditoria_etapa2_pedidos_facturacion_arca_ctacte.md) | CHANGELOG v770-771 — Auditoría funcional Etapa 2 (Pedidos + Facturación AFIP/ARCA + Cobros/cta-cte): 5 hallazgos | auditoría |
| 776 | [CHANGELOG_v776_etapa6_cierre_reportes_stock.md](v600-799/CHANGELOG_v776_etapa6_cierre_reportes_stock.md) | v776 — Etapa 6: cierre de `reportes-stock.js` y verificación de rentabilidad (producto/vendedor/zona) | fase/etapa (plan) |
| 780 | [CHANGELOG_v780_fix_store_pos_huerfanas_mp.md](v600-799/CHANGELOG_v780_fix_store_pos_huerfanas_mp.md) | v780 — Fix: recuperación de Store/Caja "huérfana" en el setup de QR de MP | fix |
| 781 | [CHANGELOG_v781_fix_external_id_pos_muy_largo.md](v600-799/CHANGELOG_v781_fix_external_id_pos_muy_largo.md) | v781 — Fix: external_id de la Caja excedía el límite de largo de MP | fix |
| 784 | [CHANGELOG_v784_mp_oauth_conectar_con_un_click.md](v600-799/CHANGELOG_v784_mp_oauth_conectar_con_un_click.md) | v784 — Conectar Mercado Pago con un click (OAuth) | feature/otros |
| 788 | [CHANGELOG_v788_fix_diagnostico_qr_cobrar.md](v600-799/CHANGELOG_v788_fix_diagnostico_qr_cobrar.md) | CHANGELOG v788 — Diagnóstico del error genérico en cobro QR (POS) | fix |
| 789 | [CHANGELOG_v789_fix_monto_minimo_qr_mercadopago.md](v600-799/CHANGELOG_v789_fix_monto_minimo_qr_mercadopago.md) | CHANGELOG v789 — Fix real: QR de Mercado Pago rechaza montos < $15 | fix |
| 796 | [CHANGELOG_v796_stock_inactivos_visibles_y_guard.md](v600-799/CHANGELOG_v796_stock_inactivos_visibles_y_guard.md) | v796 — Stock: no ocultar más productos inactivos con stock real | feature/otros |
| 797 | [CHANGELOG_v797_modal_devolucion_rediseno.md](v600-799/CHANGELOG_v797_modal_devolucion_rediseno.md) | v797 — Modal "Registrar devolución": deja de requerir scroll infinito | feature/otros |
| 798 | [CHANGELOG_v798_fix_buscador_pedidos_y_auditoria_bridges.md](v600-799/CHANGELOG_v798_fix_buscador_pedidos_y_auditoria_bridges.md) | v798 — Fix: buscador de pedidos no funcionaba (bridge faltante) + auditoría de bridges en el resto del admin | auditoría |
| 799 | [CHANGELOG_v799_fix_modal_devolucion_no_cierra.md](v600-799/CHANGELOG_v799_fix_modal_devolucion_no_cierra.md) | v799 — Fix: modal "Registrar devolución" aparecía abierto solo y no cerraba | fix |

## v800 – v984 (94 archivos)

| Versión | Archivo | Título | Categoría |
|---|---|---|---|
| 800 | [CHANGELOG_v800_fix_devolucion_producto_no_comprado.md](v800-984/CHANGELOG_v800_fix_devolucion_producto_no_comprado.md) | v800 — Fix: se podía registrar una devolución de un producto que el cliente nunca compró | fix |
| 801 | [CHANGELOG_v801_fix_mensaje_generico_revisar_devolucion.md](v800-984/CHANGELOG_v801_fix_mensaje_generico_revisar_devolucion.md) | v801 — Fix: "No se pudo registrar la revisión. Probá de nuevo." tapaba el error real | fix |
| 802 | [CHANGELOG_v802_fix_picker_devoluciones_productos_dados_de_baja.md](v800-984/CHANGELOG_v802_fix_picker_devoluciones_productos_dados_de_baja.md) | v802 — Fix: el picker de Devoluciones no mostraba ningún producto para clientes cuyo historial es solo de productos dados de baja | fix |
| 803 | [CHANGELOG_v803_fix_500_revisar_devolucion_catch_thenable.md](v800-984/CHANGELOG_v803_fix_500_revisar_devolucion_catch_thenable.md) | v803 — Fix 500 al aprobar/rechazar devoluciones (`.catch()` sobre thenable de Supabase) | fix |
| 804 | [CHANGELOG_v804_fix_idempotencia_revisar_devolucion.md](v800-984/CHANGELOG_v804_fix_idempotencia_revisar_devolucion.md) | v804 — Fix idempotencia en revisar devolución (evita duplicar stock y NC) | fix |
| 805 | [CHANGELOG_v805_auditoria_devoluciones_validacion_cantidad_precio.md](v800-984/CHANGELOG_v805_auditoria_devoluciones_validacion_cantidad_precio.md) | v805 — Auditoría completa del módulo de devoluciones (post-incidente) | auditoría |
| 806 | [CHANGELOG_v806_fix_toast_tapado_modal_devoluciones.md](v800-984/CHANGELOG_v806_fix_toast_tapado_modal_devoluciones.md) | v806 — Fix: toast de error invisible detrás del modal de alta manual (devoluciones) | fix |
| 807 | [CHANGELOG_v807_fix_formato_pedido_id_picker_devoluciones.md](v800-984/CHANGELOG_v807_fix_formato_pedido_id_picker_devoluciones.md) | v807 — Fix: número de pedido en el picker de "Registrar devolución" no coincidía con la lista de /admin/pedidos | fix |
| 808 | [CHANGELOG_v808_indicador_devolucion_en_pedidos.md](v800-984/CHANGELOG_v808_indicador_devolucion_en_pedidos.md) | v808 — Indicador de devolución en /admin/pedidos | feature/otros |
| 809 | [CHANGELOG_v809_fix_btnAsyncClick_mensaje_generico.md](v800-984/CHANGELOG_v809_fix_btnAsyncClick_mensaje_generico.md) | v809 — Fix: btnAsyncClick pisaba el mensaje real de error en 106 botones del admin | fix |
| 810 | [CHANGELOG_v810_fix_pedidoActivo_is_not_defined.md](v800-984/CHANGELOG_v810_fix_pedidoActivo_is_not_defined.md) | v810 — Fix: "pedidoActivo is not defined" al generar comprobante o imprimir remito | fix |
| 811 | [CHANGELOG_v811_fix_error_cargar_pedido_remito.md](v800-984/CHANGELOG_v811_fix_error_cargar_pedido_remito.md) | v811 — Fix: "Error al cargar el pedido" al imprimir remito | fix |
| 812 | [CHANGELOG_v812_fix_remito_no_abre_ventana.md](v800-984/CHANGELOG_v812_fix_remito_no_abre_ventana.md) | v812 — Fix: "Imprimir remito" no descarga ni muestra nada | fix |
| 813 | [CHANGELOG_v813_fix_modal_pedido_error_factura_y_chat_widget.md](v800-984/CHANGELOG_v813_fix_modal_pedido_error_factura_y_chat_widget.md) | v813 — Fix: modal de detalle de pedido roto al mostrar error de facturación | fix |
| 814 | [CHANGELOG_v814_p2_lote3_webhook_ratelimit_push_xss.md](v800-984/CHANGELOG_v814_p2_lote3_webhook_ratelimit_push_xss.md) | CHANGELOG v814 — P2 Lote 3: rate limit distribuido, webhook MP, push fail-closed, XSS saas-billing | feature/otros |
| 815 | [CHANGELOG_v815_auditoria_integral_2026_sec01_sec02_criticos.md](v800-984/CHANGELOG_v815_auditoria_integral_2026_sec01_sec02_criticos.md) | CHANGELOG v815 — Auditoría Integral 2026: SEC-01 y SEC-02 (los 2 hallazgos CRÍTICOS) | auditoría |
| 816 | [CHANGELOG_v816_sec04_sec09_sync06_sync07_sync08.md](v800-984/CHANGELOG_v816_sec04_sec09_sync06_sync07_sync08.md) | CHANGELOG v816 — Auditoría Integral 2026: SEC-04, SEC-09, SYNC-06, SYNC-07, SYNC-08 | feature/otros |
| 820 | [CHANGELOG_v820_sec11_sec12_sec13_bug04.md](v800-984/CHANGELOG_v820_sec11_sec12_sec13_bug04.md) | CHANGELOG v820 — Auditoría Integral 2026 (lote de los 15 hallazgos post-v816): SEC-11, SEC-12, SEC-13, BUG-04 | auditoría |
| 821 | [CHANGELOG_v821_auditoria_integral_2026_cierre_11_restantes.md](v800-984/CHANGELOG_v821_auditoria_integral_2026_cierre_11_restantes.md) | CHANGELOG v821 — Auditoría Integral 2026: cierre de los 11 hallazgos restantes (BUG-05 a BUG-11, BUG-03, SYNC-02, SYNC-04, SYNC-09) | auditoría |
| 822 | [CHANGELOG_v822_ui_revision_cuarentena_sync04.md](v800-984/CHANGELOG_v822_ui_revision_cuarentena_sync04.md) | v822 — UI de revisión de cuarentena legacy (seguimiento de SYNC-04) | feature/otros |
| 823 | [CHANGELOG_v823_rutas_js_tokens.md](v800-984/CHANGELOG_v823_rutas_js_tokens.md) | v823 — rutas.js migrado al sistema de tokens (Hoja de Ruta) | feature/otros |
| 824 | [CHANGELOG_v824_busqueda_global_tokens.md](v800-984/CHANGELOG_v824_busqueda_global_tokens.md) | v824 — busqueda-global.js migrado al sistema de tokens (Hoja de Ruta) | feature/otros |
| 825 | [CHANGELOG_v825_confirmacion_casos_sueltos_y_offline_core.md](v800-984/CHANGELOG_v825_confirmacion_casos_sueltos_y_offline_core.md) | v825 — confirmación de 5 casos sueltos + offline-core.js migrado | offline |
| 826 | [CHANGELOG_v826_pedidos_js_tokens.md](v800-984/CHANGELOG_v826_pedidos_js_tokens.md) | v826 — pedidos.js migrado al sistema de tokens (Hoja de Ruta) | feature/otros |
| 827 | [CHANGELOG_v827_cc_proveedores_js_tokens.md](v800-984/CHANGELOG_v827_cc_proveedores_js_tokens.md) | v827 — cc-proveedores.js migrado al sistema de tokens (Hoja de Ruta) | feature/otros |
| 828 | [CHANGELOG_v828_etiquetas_js_tokens.md](v800-984/CHANGELOG_v828_etiquetas_js_tokens.md) | v828 — etiquetas.js migrado al sistema de tokens (Hoja de Ruta) | feature/otros |
| 860 | [CHANGELOG_v860_cierre_migracion_js_tokens.md](v800-984/CHANGELOG_v860_cierre_migracion_js_tokens.md) | v860 — Cierre completo de la migración de tokens JS | migración |
| 861 | [CHANGELOG_v861_fix_504_kpis_dedup_get_en_vuelo.md](v800-984/CHANGELOG_v861_fix_504_kpis_dedup_get_en_vuelo.md) | v861 — Fix 504 en /api/admin/kpis: deduplicación de GETs en vuelo | fix |
| 862 | [CHANGELOG_v862_fix_motivo_not_defined_anular_factura.md](v800-984/CHANGELOG_v862_fix_motivo_not_defined_anular_factura.md) | v862 — Fix: `ReferenceError: motivo is not defined` al anular factura | fix |
| 863 | [CHANGELOG_v863_INTEGRACION_completa.md](v800-984/CHANGELOG_v863_INTEGRACION_completa.md) | Distribución integrada — v862 + v863 | feature/otros |
| 863 | [CHANGELOG_v863_fix_mapa_seguimiento_en_vivo_tab_directo.md](v800-984/CHANGELOG_v863_fix_mapa_seguimiento_en_vivo_tab_directo.md) | v863 — Fix: mapa en blanco al entrar directo a "Seguimiento en vivo" | fix |
| 864 | [CHANGELOG_v864_dashboard_compacto_asistente.md](v800-984/CHANGELOG_v864_dashboard_compacto_asistente.md) | v864 — Dashboard compacto con asistente IA | asistente por voz/IA |
| 864 | [CHANGELOG_v864_geocodificacion_automatica_y_entregas_sin_ubicar.md](v800-984/CHANGELOG_v864_geocodificacion_automatica_y_entregas_sin_ubicar.md) | v864 — Geocodificación automática de entregas urgentes + aviso de entregas sin ubicar en el mapa | feature/otros |
| 866 | [CHANGELOG_v866_resumen_operativo_tarjetas.md](v800-984/CHANGELOG_v866_resumen_operativo_tarjetas.md) | v866 — Información operativa en tarjetas del resumen de repartos | feature/otros |
| 867 | [CHANGELOG_v867_cola_pedidos_despacho.md](v800-984/CHANGELOG_v867_cola_pedidos_despacho.md) | v867 — Rediseño de la cola de pedidos para despachar | feature/otros |
| 868 | [CHANGELOG_v868_rutas_sincronizadas.md](v800-984/CHANGELOG_v868_rutas_sincronizadas.md) | v868 — Rutas sincronizadas y borradores funcionales | feature/otros |
| 869 | [CHANGELOG_v869_armar_ruta_horizontal.md](v800-984/CHANGELOG_v869_armar_ruta_horizontal.md) | v869 — Armar ruta más compacto y Rutas del día horizontal | feature/otros |
| 869 | [CHANGELOG_v869_dashboard_ui_reestructurado.md](v800-984/CHANGELOG_v869_dashboard_ui_reestructurado.md) | v869 · Reestructuración visual del dashboard | feature/otros |
| 870 | [CHANGELOG_v870_punto6_tenant_antes_fastpath_cobro.md](v800-984/CHANGELOG_v870_punto6_tenant_antes_fastpath_cobro.md) | CHANGELOG v870 — Auditoría 2026, Fase A, Punto 6 (cierre) | fase/etapa (plan) |
| 871 | [CHANGELOG_v871_punto7_idempotencia_pago_proveedor.md](v800-984/CHANGELOG_v871_punto7_idempotencia_pago_proveedor.md) | CHANGELOG v871 — Auditoría 2026, Fase A, Punto 7 (cierre) | fase/etapa (plan) |
| 892 | [CHANGELOG_v892_punto8_auditoria_financiera_durable.md](v800-984/CHANGELOG_v892_punto8_auditoria_financiera_durable.md) | v892 — Punto 8 (Fase A, auditoría financiera 2026): auditoría durable | auditoría |
| 893 | [CHANGELOG_v893_fix_componentesadmin_not_defined_rutas.md](v800-984/CHANGELOG_v893_fix_componentesadmin_not_defined_rutas.md) | v893 — Fix "ComponentesAdmin is not defined" al entrar a Rutas | fix |
| 894 | [CHANGELOG_v894_fix_pedidos_para_despachar_vacio.md](v800-984/CHANGELOG_v894_fix_pedidos_para_despachar_vacio.md) | v894 — Fix "Pedidos para despachar" vacío con pedidos reales pendientes | fix |
| 903 | [CHANGELOG_v903_fix_sidebar_empresa_logo_no_visible.md](v800-984/CHANGELOG_v903_fix_sidebar_empresa_logo_no_visible.md) | v903 — Fix: nombre de empresa y logo no se visualizaban en el pie del menú | fix |
| 904 | [CHANGELOG_v904_fix_devoluciones_picker_y_filtro_pedido.md](v800-984/CHANGELOG_v904_fix_devoluciones_picker_y_filtro_pedido.md) | v904 — Devoluciones: alta manual no permitía agregar productos + filtro por pedido de origen | fix |
| 905 | [CHANGELOG_v905_devoluciones_picker_modo_lista.md](v800-984/CHANGELOG_v905_devoluciones_picker_modo_lista.md) | v905 — Devoluciones: buscador de productos en lista compacta (no cards) | feature/otros |
| 906 | [CHANGELOG_v906_topbar_avatar_logo_empresa.md](v800-984/CHANGELOG_v906_topbar_avatar_logo_empresa.md) | v906 — Avatar de iniciales en topbar reemplazado por logo de empresa | feature/otros |
| 907 | [CHANGELOG_v907_remover_logo_redundante_topbar_menu.md](v800-984/CHANGELOG_v907_remover_logo_redundante_topbar_menu.md) | v907 — Se saca el logo redundante de la barra superior (junto a "Menú principal") | feature/otros |
| 908 | [CHANGELOG_v908_cheques_alerta_proximos_clickeable.md](v800-984/CHANGELOG_v908_cheques_alerta_proximos_clickeable.md) | v908 — La alerta y el sello "Vencen en 3 días" ahora filtran la tabla de Cheques | feature/otros |
| 909 | [CHANGELOG_v909_fix_banner_demo_tapa_pantalla_saas_billing.md](v800-984/CHANGELOG_v909_fix_banner_demo_tapa_pantalla_saas_billing.md) | v909 — Fix: banner de demostración tapaba toda la pantalla en Suscripciones SaaS | fix |
| 910 | [CHANGELOG_v910_pills_nivel_confianza_clientes_riesgo_cheques.md](v800-984/CHANGELOG_v910_pills_nivel_confianza_clientes_riesgo_cheques.md) | v910 — Nivel de confianza más visible: pills de categoría en Clientes y Riesgo de cheques | feature/otros |
| 911 | [CHANGELOG_v911_fix_click_celda_confianza_abria_editar.md](v800-984/CHANGELOG_v911_fix_click_celda_confianza_abria_editar.md) | v911 — Fix: click en la celda "Confianza" de Clientes abría el modal de Editar | fix |
| 912 | [CHANGELOG_v912_fix_componentes_deuda_pagos_score_cliente.md](v800-984/CHANGELOG_v912_fix_componentes_deuda_pagos_score_cliente.md) | v912 — Fix de los componentes Deuda y Pagos de `calcular_score_cliente()` | fix |
| 913 | [CHANGELOG_v913_backfill_cobro_facturas_aplicadas_demo.md](v800-984/CHANGELOG_v913_backfill_cobro_facturas_aplicadas_demo.md) | v913 — Backfill de `cobro_facturas_aplicadas` para los 140 cobros históricos de la empresa demo | feature/otros |
| 914 | [CHANGELOG_v914_modal_confianza_riesgo_cheques.md](v800-984/CHANGELOG_v914_modal_confianza_riesgo_cheques.md) | v914 — Modal de nivel de confianza también en "Cheques por vigilar" | feature/otros |
| 917 | [CHANGELOG_v917_integracion_landing_fluxo_simple.md](v800-984/CHANGELOG_v917_integracion_landing_fluxo_simple.md) | v917 — Reemplazo de la landing pública por fluxo-landing-simple-v931 | feature/otros |
| 917 | [CHANGELOG_v917b_paquete_completo_consolidado.md](v800-984/CHANGELOG_v917b_paquete_completo_consolidado.md) | v917b — Paquete completo consolidado (base v914 + patch v916 + landing v917) | feature/otros |
| 918 | [CHANGELOG_v918_fix_vacio_hero_landing.md](v800-984/CHANGELOG_v918_fix_vacio_hero_landing.md) | v918 — Fix: vacío enorme debajo del hero de la landing | fix |
| 919 | [CHANGELOG_v919_boton_espanol_a_registrate.md](v800-984/CHANGELOG_v919_boton_espanol_a_registrate.md) | v919 — Header landing: botón "Español" reemplazado por "Regístrate" | feature/otros |
| 923 | [CHANGELOG_v923_fix_csp_imagen_chat_asistente.md](v800-984/CHANGELOG_v923_fix_csp_imagen_chat_asistente.md) | CHANGELOG v923 — Fix: ícono roto en la miniatura de imagen del chat de IA | fix |
| 924 | [CHANGELOG_v924_zoom_segundo_click_redirige.md](v800-984/CHANGELOG_v924_zoom_segundo_click_redirige.md) | CHANGELOG v924 — Dashboard: 2do click en un card ya zoomeado redirige a la sección | feature/otros |
| 925 | [CHANGELOG_v925_fix_zoom_card_distinto_no_respondia.md](v800-984/CHANGELOG_v925_fix_zoom_card_distinto_no_respondia.md) | CHANGELOG v925 — Fix: click en un card distinto al zoomeado no hacía nada | fix |
| 926 | [CHANGELOG_v926_fix_backdrop_zoom_bloquea_clicks.md](v800-984/CHANGELOG_v926_fix_backdrop_zoom_bloquea_clicks.md) | v926 — Fix real: backdrop del zoom bloqueaba clicks a los demás cards | fix |
| 927 | [CHANGELOG_v927_fix2_navegacion_zoom_item_nav.md](v800-984/CHANGELOG_v927_fix2_navegacion_zoom_item_nav.md) | v927 — fix2: navegación de cards en zoom saltea el item-nav (dashboard) | fix |
| 930 | [CHANGELOG_v930_fix_hero_recentrado_diapositivas.md](v800-984/CHANGELOG_v930_fix_hero_recentrado_diapositivas.md) | v930 — Fix: el hero "se corre" (se recentra) a partir de la 3ra diapositiva | fix |
| 942 | [CHANGELOG_v942_hero_fade_asentado_desktop_mobile.md](v800-984/CHANGELOG_v942_hero_fade_asentado_desktop_mobile.md) | v942 — Fade del hero: asentamiento de ráfagas (mobile) + más pausado y sincronizado (desktop) | feature/otros |
| 943 | [CHANGELOG_v943_usuarios_avatar_y_pastilla_rol.md](v800-984/CHANGELOG_v943_usuarios_avatar_y_pastilla_rol.md) | v943 — Usuarios: avatar de iniciales + pastilla de Rol (sincronizado con Clientes) | feature/otros |
| 944 | [CHANGELOG_v944_revert_tarjeta_asistente_menu.md](v800-984/CHANGELOG_v944_revert_tarjeta_asistente_menu.md) | v944 — Revertir tarjeta destacada de "Asistente" en el mega-menú | asistente por voz/IA |
| 947 | [CHANGELOG_v947_fix_back_link_modulos_mobile.md](v800-984/CHANGELOG_v947_fix_back_link_modulos_mobile.md) | v947 — Fix: botón "Volver al inicio" invisible en módulos (mobile) | fix |
| 948 | [CHANGELOG_v948_fix_boton_ingresar_roto.md](v800-984/CHANGELOG_v948_fix_boton_ingresar_roto.md) | v948 — Fix: botón "Ingresar" roto en la landing (desktop y mobile) | fix |
| 949 | [CHANGELOG_v949_metadata_og_twitter.md](v800-984/CHANGELOG_v949_metadata_og_twitter.md) | v949 — Metadata para compartir (og:image, twitter:card) | feature/otros |
| 955 | [CHANGELOG_v955_fix_devolucion_asistente_v805_y_timezone_chofer.md](v800-984/CHANGELOG_v955_fix_devolucion_asistente_v805_y_timezone_chofer.md) | v955 — Fix hallazgos Crítico #0 y Alto #7 de AUDITORIA_BUGS_v954.md | auditoría |
| 956 | [CHANGELOG_v956_fix_notif_whatsapp_despacho_y_race_confirmar_sugerido.md](v800-984/CHANGELOG_v956_fix_notif_whatsapp_despacho_y_race_confirmar_sugerido.md) | v956 — Fix hallazgos Medio #8 y #9 de AUDITORIA_BUGS_v954.md | auditoría |
| 957 | [CHANGELOG_v957_fix_revocar_sesiones_password_y_logging_recordatorio_vencimiento.md](v800-984/CHANGELOG_v957_fix_revocar_sesiones_password_y_logging_recordatorio_vencimiento.md) | v957 — Fix hallazgos Alto #10 y Medio #11 (Etapa 2b, resto de handlers) | auditoría |
| 962 | [CHANGELOG_v962_fix_mensaje_error_stock_guardarAjuste.md](v800-984/CHANGELOG_v962_fix_mensaje_error_stock_guardarAjuste.md) | v962 — Fix mensaje de error engañoso en `guardarAjuste()` (auditoría de bugs, Etapa 4 — Stock) | fix |
| 962 | [CHANGELOG_v962_fix_xss_atributo_sanitize.md](v800-984/CHANGELOG_v962_fix_xss_atributo_sanitize.md) | v962 — Fix XSS de atributo en `window.sanitize()` (auditoría de bugs, Etapa 4) | fix |
| 962 | [CHANGELOG_v962_fix_xss_cobranzas_ctacte.md](v800-984/CHANGELOG_v962_fix_xss_cobranzas_ctacte.md) | v962 — Fix XSS almacenado en Cobranzas y Cta-Cte (auditoría de bugs, Etapa 4) | fix |
| 962 | [CHANGELOG_v962_fix_xss_facturacion_comprobantes_historicos.md](v800-984/CHANGELOG_v962_fix_xss_facturacion_comprobantes_historicos.md) | v962 — Fix XSS en "Comprobantes históricos" (auditoría de bugs, Etapa 4 — Facturación) | fix |
| 962 | [CHANGELOG_v962_fix_xss_portal_cliente_cierre_etapa4.md](v800-984/CHANGELOG_v962_fix_xss_portal_cliente_cierre_etapa4.md) | v962 — Fix XSS en portal cliente + cierre de la Etapa 4 (auditoría de bugs) | fix |
| 962 | [CHANGELOG_v962_fix_xss_rutas.md](v800-984/CHANGELOG_v962_fix_xss_rutas.md) | v962 — Fix XSS almacenado en Rutas (auditoría de bugs, Etapa 4) | fix |
| 966 | [CHANGELOG_v966_etapa8_tests_bugs_historicos.md](v800-984/CHANGELOG_v966_etapa8_tests_bugs_historicos.md) | v966 — Etapa 8 (cobertura de tests vs. bugs históricos), en curso | fase/etapa (plan) |
| 967 | [CHANGELOG_v967_etapa8_fix_tests_preexistentes.md](v800-984/CHANGELOG_v967_etapa8_fix_tests_preexistentes.md) | v967 — Etapa 8 (cobertura de tests vs. bugs históricos), continuación | fix |
| 968 | [CHANGELOG_v968_etapa8_cierre_tests_frontend_regresion.md](v800-984/CHANGELOG_v968_etapa8_cierre_tests_frontend_regresion.md) | v968 — Cierre etapa 8: tests de regresión XSS frontend | fase/etapa (plan) |
| 969 | [CHANGELOG_v969_etapa8_cierre_real.md](v800-984/CHANGELOG_v969_etapa8_cierre_real.md) | v969 — Cierre real de la etapa 8: #8, #9 y #16 rezagados | fase/etapa (plan) |
| 971 | [CHANGELOG_v971_boton_accesos_portal_clientes.md](v800-984/CHANGELOG_v971_boton_accesos_portal_clientes.md) | v971 — Botón "Accesos al portal" en la página de Clientes | feature/otros |
| 972 | [CHANGELOG_v972_sin_boton_flotante_cliente_chofer.md](v800-984/CHANGELOG_v972_sin_boton_flotante_cliente_chofer.md) | v972 — Sacar el botón flotante "Trabajar con IA" de los portales cliente y chofer | feature/otros |
| 976 | [CHANGELOG_v976_generador_etiquetas_etapa3.md](v800-984/CHANGELOG_v976_generador_etiquetas_etapa3.md) | CHANGELOG v976 — Generador de etiquetas de precio/código de barras, Etapa 3 (precarga desde Recepción) | fase/etapa (plan) |
| 977 | [CHANGELOG_v977_generador_etiquetas_etapa4_promociones.md](v800-984/CHANGELOG_v977_generador_etiquetas_etapa4_promociones.md) | CHANGELOG v977 — Generador de etiquetas de precio/código de barras, Etapa 4 (precio promocional tachado) | fase/etapa (plan) |
| 979 | [CHANGELOG_v979_layout_compacto_y_fix_botones_etiquetas.md](v800-984/CHANGELOG_v979_layout_compacto_y_fix_botones_etiquetas.md) | Etiquetas de precio: layout compacto + fix de botones sin efecto (v979) | fix |
| 979 | [CHANGELOG_v979_seleccion_masiva_etiquetas.md](v800-984/CHANGELOG_v979_seleccion_masiva_etiquetas.md) | Selección masiva para "Generar etiquetas" (v979) | feature/otros |
| 980 | [CHANGELOG_v980_fix_500_config_etiquetas_y_barcodes_prueba.md](v800-984/CHANGELOG_v980_fix_500_config_etiquetas_y_barcodes_prueba.md) | Etiquetas de precio: fix 500 en config + códigos de barras de prueba inválidos (v980) | fix |
| 981 | [CHANGELOG_v981_fix_grilla_etiquetas_rompe_interfaz.md](v800-984/CHANGELOG_v981_fix_grilla_etiquetas_rompe_interfaz.md) | Fix: la grilla de impresión de etiquetas quedaba visible en pantalla y rompía la interfaz (v981) | fix |
| 983 | [CHANGELOG_v983_dep03_remover_sharp_sin_uso.md](v800-984/CHANGELOG_v983_dep03_remover_sharp_sin_uso.md) | v983 — DEP-03: remover `sharp` (devDependency sin uso) | feature/otros |
| 984 | [CHANGELOG_v984_fix_migraciones_orden_secnew_y_test_fragil.md](v800-984/CHANGELOG_v984_fix_migraciones_orden_secnew_y_test_fragil.md) | v984 — Fix hallazgo #3 (3ra recurrencia) + test estructuralmente frágil | auditoría |

## Sin número de versión (11 archivos)

| Versión | Archivo | Título | Categoría |
|---|---|---|---|
| - | [CHANGELOG_AUDITORIA_FASE3_pedido_factura_ctacte_cobro.md](sin-numero/CHANGELOG_AUDITORIA_FASE3_pedido_factura_ctacte_cobro.md) | Auditoría de integridad — Fase 3: pedido → factura → cta_cte → cobro | auditoría |
| - | [CHANGELOG_cheques_verificar_bcra_texto.md](sin-numero/CHANGELOG_cheques_verificar_bcra_texto.md) | Acción de verificación BCRA más explícita | feature/otros |
| - | [CHANGELOG_dashboard_espaciado_minimo.md](sin-numero/CHANGELOG_dashboard_espaciado_minimo.md) | Ajuste de espaciado del panel principal | feature/otros |
| - | [CHANGELOG_dashboard_v2_torre_de_control.md](sin-numero/CHANGELOG_dashboard_v2_torre_de_control.md) | Nuevo Panel Principal — "Torre de Control" (v2, propuesta) | feature/otros |
| - | [CHANGELOG_descartar_apk_reusar_pwa_install.md](sin-numero/CHANGELOG_descartar_apk_reusar_pwa_install.md) | Descartar descarga de .apk — reusar el instalador PWA ya existente | feature/otros |
| - | [CHANGELOG_eliminar_descripciones_paginas.md](sin-numero/CHANGELOG_eliminar_descripciones_paginas.md) | Limpieza de descripciones introductorias | feature/otros |
| - | [CHANGELOG_etapa0.2_auditoria_bridges_window.md](sin-numero/CHANGELOG_etapa0.2_auditoria_bridges_window.md) | Etapa 0.2 — Auditoría automatizada de bridges `window.*` faltantes | auditoría |
| - | [CHANGELOG_fix_devoluciones_revisar_accion_query.md](sin-numero/CHANGELOG_fix_devoluciones_revisar_accion_query.md) | Fix — "No se pudo registrar la revisión" al aprobar/rechazar una devolución | fix |
| - | [CHANGELOG_lotes_robustecimiento_etapas2_3_4.md](sin-numero/CHANGELOG_lotes_robustecimiento_etapas2_3_4.md) | Robustecimiento de trazabilidad de lotes — Etapas 2, 3 y 4 | fase/etapa (plan) |
| - | [CHANGELOG_onboarding_checklist_frontend.md](sin-numero/CHANGELOG_onboarding_checklist_frontend.md) | CHANGELOG — Checklist de activación (onboarding cliente) | feature/otros |
| - | [CHANGELOG_quitar_cobros_por_medio_pago.md](sin-numero/CHANGELOG_quitar_cobros_por_medio_pago.md) | Eliminación de la sección de cobros por medio de pago | feature/otros |

## v985+ (recientes, 3 archivos)

| Versión | Archivo | Título | Categoría |
|---|---|---|---|
| 985 | [CHANGELOG_v985_split_pedidos_handler.md](v800-984/CHANGELOG_v985_split_pedidos_handler.md) | v985 — Split de `lib/handlers/pedidos.js` | refactor |
| 986 | [CHANGELOG_v986_split_productos_frontend.md](v800-984/CHANGELOG_v986_split_productos_frontend.md) | v986 — Split de `frontend/admin/js/productos.js` | refactor |
| 986 | [CHANGELOG_v986_whatsapp_business_id_prefill_reconexion.md](v800-984/CHANGELOG_v986_whatsapp_business_id_prefill_reconexion.md) | v986 — WhatsApp: prefill de `business_id` para saltear la pantalla de negocio en reconexiones | fix |
| 1004 | [CHANGELOG_v1004_etapa1_ci_cd_gate_automatico.md](v800-984/CHANGELOG_v1004_etapa1_ci_cd_gate_automatico.md) | v1004 — Etapa 1 del plan de robustez: CI/CD real (gate automático) | fase/etapa (plan) |
| 1005 | [CHANGELOG_v1005_etapa2_retencion_ampliada.md](v800-984/CHANGELOG_v1005_etapa2_retencion_ampliada.md) | v1005 — Etapa 2 del plan de robustez (ampliación): retención en security_audit_historial, whatsapp y asistente | fase/etapa (plan) |
| 1006 | [CHANGELOG_v1006_etapa1_branch_protection_activa.md](v800-984/CHANGELOG_v1006_etapa1_branch_protection_activa.md) | v1006 — Etapa 1 del plan de robustez: branch protection activa (cierre) | fase/etapa (plan) |
| 1007 | [CHANGELOG_v1007_etapa8_capacidad_runbook.md](v800-984/CHANGELOG_v1007_etapa8_capacidad_runbook.md) | v1007 — Etapa 8 del plan de robustez: documento de capacidad + runbook | fase/etapa (plan) |
| 1008 | [CHANGELOG_v1008_etapa3_cache_catalogo_cliente.md](v800-984/CHANGELOG_v1008_etapa3_cache_catalogo_cliente.md) | v1008 — Etapa 3 del plan de robustez (generalización): caché en el catálogo de cliente | fase/etapa (plan) |
| 1009 | [CHANGELOG_v1009_perf_dashboard_admin_load_test.md](v800-984/CHANGELOG_v1009_perf_dashboard_admin_load_test.md) | v1009 — Fixes de performance en dashboard admin, a partir de load test contra prod | perf |
| 1010 | [CHANGELOG_v1010_whatsapp_tools_paralelas_batch_atajo_humano.md](v800-984/CHANGELOG_v1010_whatsapp_tools_paralelas_batch_atajo_humano.md) | v1010 — Asistente de pedidos por WhatsApp: function calling paralelo en Gemini, batch en `agregar_item`, atajo determinístico para pedir un humano | fix |
| 1011 | [CHANGELOG_v1011_whatsapp_boton_desconectar.md](v800-984/CHANGELOG_v1011_whatsapp_boton_desconectar.md) | v1011 — WhatsApp: fix del cartel que no pasaba a "conectado" + botón "Desconectar" | fix+feature |
| 1012 | [CHANGELOG_v1012_whatsapp_historial_conversaciones.md](v800-984/CHANGELOG_v1012_whatsapp_historial_conversaciones.md) | v1012 — WhatsApp: tab "Historial" para conversaciones cerradas | feature |
| 1042 | [CHANGELOG_v1042_backfill_migracion_568_faltante_en_repo.md](v800-984/CHANGELOG_v1042_backfill_migracion_568_faltante_en_repo.md) | v1042 — Backfill de la migración 568, aplicada en DB pero ausente del repo | fix |
| 1043 | [CHANGELOG_v1043_track_funciones_fantasma.md](v800-984/CHANGELOG_v1043_track_funciones_fantasma.md) | v1043 — Trackeo de las 7 funciones fantasma reportadas por audit:funciones-fantasma | fix |
| 1044 | [CHANGELOG_v1044_fix_falso_ok_loadtest_servidor_caido.md](v800-984/CHANGELOG_v1044_fix_falso_ok_loadtest_servidor_caido.md) | v1044 — Fix de falso "OK" en load-test.js cuando el servidor está caído | fix |
| 1045 | [CHANGELOG_v1045_ttl_cache_dashboards_pesados_30s_a_60s.md](v800-984/CHANGELOG_v1045_ttl_cache_dashboards_pesados_30s_a_60s.md) | v1045 — TTL del caché de dashboards pesados: 30s → 60s | perf |
