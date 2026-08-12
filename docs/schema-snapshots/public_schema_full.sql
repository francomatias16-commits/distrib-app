CREATE TABLE public.alertas_score (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    empresa_id uuid NOT NULL,
    score_anterior numeric(5,2),
    score_nuevo numeric(5,2),
    mensaje text,
    resuelta boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.alertas_stock (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid NOT NULL,
    producto_id uuid NOT NULL,
    tipo text NOT NULL,
    dias_restantes numeric(6,1),
    orden_compra_id uuid,
    resuelta boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    tabla text NOT NULL,
    registro_id uuid,
    accion text NOT NULL,
    datos_antes jsonb,
    datos_despues jsonb,
    usuario_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT audit_log_accion_check CHECK ((accion = ANY (ARRAY['INSERT'::text, 'UPDATE'::text, 'DELETE'::text])))
);
CREATE TABLE public.bloqueos_cliente (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid NOT NULL,
    cliente_id uuid NOT NULL,
    motivo text,
    activo boolean DEFAULT true,
    usuario_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.canjes_recompensas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    recompensa_id uuid NOT NULL,
    empresa_id uuid NOT NULL,
    puntos_gastados integer NOT NULL,
    estado character varying(20) DEFAULT 'pendiente'::character varying,
    aplicado_en_pedido_id uuid,
    created_at timestamp without time zone DEFAULT now(),
    aplicado_at timestamp without time zone
);
CREATE TABLE public.categorias (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    nombre text NOT NULL,
    orden integer DEFAULT 0,
    activa boolean DEFAULT true NOT NULL
);
CREATE TABLE public.cheques (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    cliente_id uuid,
    banco text,
    numero text,
    monto numeric(12,2) NOT NULL,
    fecha_vto date NOT NULL,
    estado text DEFAULT 'en_cartera'::text,
    cobro_id uuid,
    notas text,
    created_at timestamp with time zone DEFAULT now(),
    vencimiento date
);
CREATE TABLE public.ciclos_compra (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid NOT NULL,
    cliente_id uuid NOT NULL,
    producto_id uuid NOT NULL,
    cantidad_promedio numeric(12,3) DEFAULT 0 NOT NULL,
    intervalo_dias integer DEFAULT 0 NOT NULL,
    ultima_compra date,
    proximo_pedido date,
    confianza numeric(4,2) DEFAULT 0,
    activo boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.clientes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    razon_social text NOT NULL,
    nombre_fantasia text,
    cuit text,
    condicion_iva text DEFAULT 'consumidor_final'::text,
    domicilio text,
    localidad text,
    zona_id uuid,
    telefono text,
    email text,
    lista_precio_id uuid,
    limite_credito numeric(12,2) DEFAULT 0,
    dias_credito integer DEFAULT 0,
    activo boolean DEFAULT true,
    notas text,
    created_at timestamp with time zone DEFAULT now(),
    score_actual integer,
    score_categoria text,
    lat numeric(10,7),
    lng numeric(10,7),
    score_actualizado timestamp with time zone,
    direccion text GENERATED ALWAYS AS (domicilio) STORED,
    saldo_deuda numeric(12,2) DEFAULT 0,
    usuario_id uuid,
    bloqueado boolean DEFAULT false,
    bloqueado_motivo text,
    saldo_cuenta_corriente numeric(12,2) DEFAULT 0
);
CREATE TABLE public.cobros (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    cliente_id uuid,
    monto numeric(12,2) NOT NULL,
    medio text,
    referencia text,
    notas text,
    usuario_id uuid,
    fecha timestamp with time zone DEFAULT now()
);
CREATE TABLE public.contadores_empresa (
    empresa_id uuid NOT NULL,
    tipo text NOT NULL,
    ultimo integer DEFAULT 0
);
CREATE TABLE public.cta_cte (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid,
    tipo text NOT NULL,
    monto numeric(12,2) NOT NULL,
    factura_id uuid,
    cobro_id uuid,
    saldo numeric(12,2),
    fecha timestamp with time zone DEFAULT now()
);
CREATE TABLE public.depositos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    nombre text NOT NULL,
    es_principal boolean DEFAULT false
);
CREATE TABLE public.dispositivos_push (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    usuario_id uuid NOT NULL,
    empresa_id uuid NOT NULL,
    token_push character varying(500) NOT NULL,
    tipo_dispositivo character varying(20),
    activo boolean DEFAULT true,
    ultimo_acceso timestamp without time zone DEFAULT now(),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE public.empresas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nombre text NOT NULL,
    cuit text NOT NULL,
    domicilio text,
    telefono text,
    email text,
    logo_url text,
    config jsonb DEFAULT '{}'::jsonb,
    activa boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.entregas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ruta_id uuid,
    pedido_id uuid,
    orden integer,
    estado text DEFAULT 'pendiente'::text,
    firma_url text,
    foto_url text,
    receptor text,
    notas_entrega text,
    fecha_confirmacion timestamp with time zone
);
CREATE TABLE public.facturas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    pedido_id uuid,
    cliente_id uuid,
    tipo text DEFAULT 'B'::text,
    numero text,
    cae text,
    cae_vto date,
    neto numeric(12,2),
    iva numeric(12,2),
    total numeric(12,2),
    estado public.estado_factura DEFAULT 'pendiente'::public.estado_factura,
    pdf_url text,
    fecha_emision timestamp with time zone DEFAULT now(),
    vencimiento date,
    total_cobrado numeric(12,2) DEFAULT 0
);
CREATE TABLE public.integraciones_pago (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid NOT NULL,
    proveedor character varying(50) DEFAULT 'mercado_pago'::character varying NOT NULL,
    access_token text NOT NULL,
    public_key text,
    webhook_secret text,
    activa boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE public.listas_precios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    nombre text NOT NULL,
    es_default boolean DEFAULT false,
    activa boolean DEFAULT true
);
CREATE TABLE public.lotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    producto_id uuid,
    deposito_id uuid,
    numero_lote text,
    cantidad numeric(12,3) DEFAULT 0 NOT NULL,
    costo_unitario numeric(12,2) DEFAULT 0,
    fecha_fabricacion date,
    fecha_vencimiento date,
    estado text DEFAULT 'activo'::text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT lotes_estado_check CHECK ((estado = ANY (ARRAY['activo'::text, 'agotado'::text, 'vencido'::text])))
);
CREATE TABLE public.movimientos_cta_cte (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    fecha date DEFAULT CURRENT_DATE NOT NULL,
    tipo text,
    descripcion text,
    debe numeric(12,2),
    haber numeric(12,2),
    saldo numeric(12,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.movimientos_puntos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    empresa_id uuid NOT NULL,
    tipo character varying(20) NOT NULL,
    cantidad numeric(10,2) NOT NULL,
    motivo text,
    referencia_id uuid,
    created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE public.movimientos_stock (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    producto_id uuid,
    deposito_id uuid,
    tipo public.tipo_movimiento NOT NULL,
    cantidad numeric(12,3) NOT NULL,
    referencia_id uuid,
    referencia text,
    usuario_id uuid,
    notas text,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.notas_internas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    usuario_id uuid,
    tabla text NOT NULL,
    entidad_id uuid NOT NULL,
    contenido text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.notif_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    cliente_id uuid,
    pedido_id uuid,
    tipo text NOT NULL,
    canal text DEFAULT 'whatsapp'::text NOT NULL,
    telefono text,
    email text,
    message_id text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.notificaciones_push (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid NOT NULL,
    usuario_id uuid,
    cliente_id uuid,
    titulo character varying(150) NOT NULL,
    cuerpo text NOT NULL,
    tipo character varying(50),
    datos_json jsonb,
    enviada boolean DEFAULT false,
    leida boolean DEFAULT false,
    enviada_at timestamp without time zone,
    leida_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE public.ordenes_compra (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    proveedor_id uuid,
    numero text,
    estado text DEFAULT 'borrador'::text,
    total numeric(12,2) DEFAULT 0,
    notas text,
    fecha_pedido timestamp with time zone DEFAULT now(),
    fecha_recepcion timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    auto_generada boolean DEFAULT false,
    velocidad_venta_snapshot jsonb,
    CONSTRAINT ordenes_compra_estado_check CHECK ((estado = ANY (ARRAY['borrador'::text, 'enviada'::text, 'recibida'::text, 'cancelada'::text])))
);
CREATE TABLE public.ordenes_compra_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    orden_id uuid,
    producto_id uuid,
    descripcion text,
    cantidad numeric(12,3) NOT NULL,
    precio_unitario numeric(12,2) DEFAULT 0,
    subtotal numeric(12,2) DEFAULT 0
);
CREATE TABLE public.pedido_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pedido_id uuid,
    producto_id uuid,
    cantidad numeric(12,3) NOT NULL,
    precio_unitario numeric(12,2) NOT NULL,
    descuento_pct numeric(5,2) DEFAULT 0,
    subtotal numeric(12,2) NOT NULL,
    cantidad_entregada numeric(12,3)
);
CREATE TABLE public.pedidos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    cliente_id uuid,
    vendedor_id uuid,
    estado public.estado_pedido DEFAULT 'borrador'::public.estado_pedido,
    subtotal numeric(12,2) DEFAULT 0,
    descuento numeric(12,2) DEFAULT 0,
    iva_total numeric(12,2) DEFAULT 0,
    total numeric(12,2) DEFAULT 0,
    notas_cliente text,
    notas_internas text,
    fecha_pedido timestamp with time zone DEFAULT now(),
    fecha_entrega date,
    created_at timestamp with time zone DEFAULT now(),
    remito_nro integer,
    factura_id uuid,
    fecha_despacho timestamp with time zone,
    generado_automatico boolean DEFAULT false,
    confianza_sugerencia numeric(4,2),
    ciclo_referencia_id uuid
);
CREATE TABLE public.precios_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lista_id uuid,
    producto_id uuid,
    precio numeric(12,2) NOT NULL
);
CREATE TABLE public.presupuesto_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    presupuesto_id uuid,
    producto_id uuid,
    cantidad numeric(12,3) NOT NULL,
    precio_unitario numeric(12,2) NOT NULL,
    descuento_pct numeric(5,2) DEFAULT 0,
    subtotal numeric(12,2) NOT NULL
);
CREATE TABLE public.presupuestos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    cliente_id uuid,
    vendedor_id uuid,
    numero text,
    estado text DEFAULT 'borrador'::text,
    subtotal numeric(12,2) DEFAULT 0,
    iva_total numeric(12,2) DEFAULT 0,
    total numeric(12,2) DEFAULT 0,
    notas_cliente text,
    notas_admin text,
    fecha_vencimiento date,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT presupuestos_estado_check CHECK ((estado = ANY (ARRAY['borrador'::text, 'enviado'::text, 'aceptado'::text, 'rechazado'::text, 'vencido'::text])))
);
CREATE TABLE public.productos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    codigo text,
    nombre text NOT NULL,
    descripcion text,
    categoria_id uuid,
    unidad text DEFAULT 'unidad'::text,
    costo numeric(12,2) DEFAULT 0,
    precio_base numeric(12,2) DEFAULT 0,
    iva numeric(5,2) DEFAULT 21,
    foto_url text,
    activo boolean DEFAULT true,
    permite_negativo boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    stock_minimo numeric(12,3) DEFAULT 0,
    lead_time_dias integer DEFAULT 7,
    stock_objetivo numeric(12,3) DEFAULT 0
);
CREATE TABLE public.programas_fidelizacion (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid NOT NULL,
    nombre character varying(100) DEFAULT 'Programa de Puntos'::character varying NOT NULL,
    puntos_por_peso numeric(5,2) DEFAULT 1.0,
    puntos_minimos_canje integer DEFAULT 100,
    activo boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE public.saldo_puntos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    empresa_id uuid NOT NULL,
    puntos_disponibles numeric(10,2) DEFAULT 0,
    puntos_canjeados numeric(10,2) DEFAULT 0,
    puntos_totales numeric(10,2) DEFAULT 0,
    ultimo_movimiento timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE public.recompensas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid NOT NULL,
    nombre character varying(150) NOT NULL,
    descripcion text,
    puntos_requeridos integer NOT NULL,
    tipo character varying(30) NOT NULL,
    valor numeric(10,2),
    cantidad_disponible integer,
    cantidad_canjeada integer DEFAULT 0,
    activa boolean DEFAULT true,
    fecha_inicio date,
    fecha_fin date,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE public.reglas_score (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid NOT NULL,
    umbral_premium integer DEFAULT 80,
    umbral_bueno integer DEFAULT 65,
    umbral_normal integer DEFAULT 45,
    umbral_riesgo integer DEFAULT 30,
    mult_credito_premium numeric(4,2) DEFAULT 2.0,
    mult_credito_bueno numeric(4,2) DEFAULT 1.5,
    mult_credito_normal numeric(4,2) DEFAULT 1.0,
    mult_credito_riesgo numeric(4,2) DEFAULT 0.5,
    dias_cred_premium integer DEFAULT 45,
    dias_cred_bueno integer DEFAULT 30,
    dias_cred_normal integer DEFAULT 15,
    dias_cred_riesgo integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.rutas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    chofer_id uuid,
    fecha date NOT NULL,
    estado text DEFAULT 'pendiente'::text,
    notas text
);
CREATE TABLE public.scores_cliente (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    empresa_id uuid NOT NULL,
    score numeric(5,2) NOT NULL,
    score_pagos numeric(5,2),
    score_frecuencia numeric(5,2),
    score_deuda numeric(5,2),
    score_devolucion numeric(5,2),
    motivo_cambio text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT scores_cliente_score_check CHECK (((score >= (0)::numeric) AND (score <= (100)::numeric)))
);
CREATE TABLE public.stock (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    producto_id uuid,
    deposito_id uuid,
    cantidad numeric(12,3) DEFAULT 0,
    cantidad_reservada numeric(12,3) DEFAULT 0,
    costo_promedio numeric(12,2) DEFAULT 0
);
CREATE TABLE public.sugerencias_pedido (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    empresa_id uuid NOT NULL,
    producto_id uuid NOT NULL,
    cantidad_sugerida integer NOT NULL,
    razon character varying(100),
    score_relevancia numeric(3,2),
    visualizada boolean DEFAULT false,
    convertida_en_pedido boolean DEFAULT false,
    pedido_id uuid,
    created_at timestamp without time zone DEFAULT now(),
    expira_at timestamp without time zone DEFAULT (now() + '30 days'::interval)
);
CREATE TABLE public.transacciones_pago (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid NOT NULL,
    cliente_id uuid NOT NULL,
    pedido_id uuid,
    factura_id uuid,
    monto numeric(12,2) NOT NULL,
    moneda character varying(3) DEFAULT 'ARS'::character varying,
    proveedor character varying(50) DEFAULT 'mercado_pago'::character varying NOT NULL,
    referencia_externa character varying(100),
    estado character varying(30) DEFAULT 'pendiente'::character varying NOT NULL,
    metodo_pago character varying(50),
    respuesta_json jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE public.usuarios (
    id uuid NOT NULL,
    empresa_id uuid,
    nombre text NOT NULL,
    email text NOT NULL,
    rol public.rol_usuario DEFAULT 'vendedor'::public.rol_usuario NOT NULL,
    telefono text,
    activo boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.zonas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    empresa_id uuid,
    nombre text NOT NULL,
    dias_reparto text[],
    activa boolean DEFAULT true
);
