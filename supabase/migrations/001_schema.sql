-- ============================================================
-- DISTRIB-APP — Schema SQL completo
-- Ejecutar en orden en Supabase SQL Editor
-- MF Web Solutions | v1.0 | Junio 2026
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS (con bloque DO para no fallar si ya existen)
-- ============================================================
DO $$ BEGIN
  CREATE TYPE rol_usuario AS ENUM (
    'dueno', 'admin', 'vendedor', 'depositero', 'chofer', 'contador', 'cliente'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE tipo_movimiento AS ENUM (
    'ingreso', 'egreso', 'reserva', 'liberacion', 'ajuste', 'transferencia'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE estado_pedido AS ENUM (
    'borrador', 'confirmado', 'preparando', 'despachado', 'entregado', 'cancelado'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE estado_factura AS ENUM (
    'pendiente', 'emitida', 'anulada', 'error_afip'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- TABLA: empresas
-- ============================================================
CREATE TABLE IF NOT EXISTS empresas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      TEXT NOT NULL,
  cuit        TEXT NOT NULL UNIQUE,
  domicilio   TEXT,
  telefono    TEXT,
  email       TEXT,
  logo_url    TEXT,
  config      JSONB DEFAULT '{}',
  activa      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABLA: usuarios
-- ============================================================
CREATE TABLE IF NOT EXISTS usuarios (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  empresa_id  UUID REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  email       TEXT NOT NULL,
  rol         rol_usuario NOT NULL DEFAULT 'vendedor',
  telefono    TEXT,
  activo      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABLA: zonas
-- ============================================================
CREATE TABLE IF NOT EXISTS zonas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID REFERENCES empresas(id) ON DELETE CASCADE,
  nombre        TEXT NOT NULL,
  dias_reparto  TEXT[],
  activa        BOOLEAN DEFAULT true
);

-- ============================================================
-- TABLA: categorias
-- ============================================================
CREATE TABLE IF NOT EXISTS categorias (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  UUID REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  orden       INT DEFAULT 0
);

-- ============================================================
-- TABLA: listas_precios
-- ============================================================
CREATE TABLE IF NOT EXISTS listas_precios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  UUID REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  es_default  BOOLEAN DEFAULT false,
  activa      BOOLEAN DEFAULT true
);

-- ============================================================
-- TABLA: clientes
-- ============================================================
CREATE TABLE IF NOT EXISTS clientes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        UUID REFERENCES empresas(id) ON DELETE CASCADE,
  razon_social      TEXT NOT NULL,
  nombre_fantasia   TEXT,
  cuit              TEXT,
  condicion_iva     TEXT DEFAULT 'consumidor_final',
  domicilio         TEXT,
  localidad         TEXT,
  zona_id           UUID REFERENCES zonas(id),
  telefono          TEXT,
  email             TEXT,
  lista_precio_id   UUID REFERENCES listas_precios(id),
  limite_credito    NUMERIC(12,2) DEFAULT 0,
  dias_credito      INT DEFAULT 0,
  activo            BOOLEAN DEFAULT true,
  notas             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABLA: productos
-- ============================================================
CREATE TABLE IF NOT EXISTS productos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        UUID REFERENCES empresas(id) ON DELETE CASCADE,
  codigo            TEXT,
  nombre            TEXT NOT NULL,
  descripcion       TEXT,
  categoria_id      UUID REFERENCES categorias(id),
  unidad            TEXT DEFAULT 'unidad',
  costo             NUMERIC(12,2) DEFAULT 0,
  precio_base       NUMERIC(12,2) DEFAULT 0,
  iva               NUMERIC(5,2) DEFAULT 21,
  foto_url          TEXT,
  activo            BOOLEAN DEFAULT true,
  permite_negativo  BOOLEAN DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABLA: precios_items
-- ============================================================
CREATE TABLE IF NOT EXISTS precios_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lista_id    UUID REFERENCES listas_precios(id) ON DELETE CASCADE,
  producto_id UUID REFERENCES productos(id) ON DELETE CASCADE,
  precio      NUMERIC(12,2) NOT NULL,
  UNIQUE(lista_id, producto_id)
);

-- ============================================================
-- TABLAS: depositos y stock
-- ============================================================
CREATE TABLE IF NOT EXISTS depositos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID REFERENCES empresas(id) ON DELETE CASCADE,
  nombre        TEXT NOT NULL,
  es_principal  BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS stock (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id         UUID REFERENCES productos(id) ON DELETE CASCADE,
  deposito_id         UUID REFERENCES depositos(id) ON DELETE CASCADE,
  cantidad            NUMERIC(12,3) DEFAULT 0,
  cantidad_reservada  NUMERIC(12,3) DEFAULT 0,
  costo_promedio      NUMERIC(12,2) DEFAULT 0,
  UNIQUE(producto_id, deposito_id)
);

CREATE TABLE IF NOT EXISTS movimientos_stock (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id   UUID REFERENCES productos(id),
  deposito_id   UUID REFERENCES depositos(id),
  tipo          tipo_movimiento NOT NULL,
  cantidad      NUMERIC(12,3) NOT NULL,
  referencia_id UUID,
  referencia    TEXT,
  usuario_id    UUID REFERENCES usuarios(id),
  notas         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABLAS: pedidos
-- ============================================================
CREATE TABLE IF NOT EXISTS pedidos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id      UUID REFERENCES clientes(id),
  vendedor_id     UUID REFERENCES usuarios(id),
  estado          estado_pedido DEFAULT 'borrador',
  subtotal        NUMERIC(12,2) DEFAULT 0,
  descuento       NUMERIC(12,2) DEFAULT 0,
  iva_total       NUMERIC(12,2) DEFAULT 0,
  total           NUMERIC(12,2) DEFAULT 0,
  notas_cliente   TEXT,
  notas_internas  TEXT,
  fecha_pedido    TIMESTAMPTZ DEFAULT now(),
  fecha_entrega   DATE,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pedido_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id       UUID REFERENCES pedidos(id) ON DELETE CASCADE,
  producto_id     UUID REFERENCES productos(id),
  cantidad        NUMERIC(12,3) NOT NULL,
  precio_unitario NUMERIC(12,2) NOT NULL,
  descuento_pct   NUMERIC(5,2) DEFAULT 0,
  subtotal        NUMERIC(12,2) NOT NULL
);

-- ============================================================
-- TABLA: facturas
-- ============================================================
CREATE TABLE IF NOT EXISTS facturas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id     UUID REFERENCES pedidos(id),
  cliente_id    UUID REFERENCES clientes(id),
  tipo          TEXT DEFAULT 'B',
  numero        TEXT,
  cae           TEXT,
  cae_vto       DATE,
  neto          NUMERIC(12,2),
  iva           NUMERIC(12,2),
  total         NUMERIC(12,2),
  estado        estado_factura DEFAULT 'pendiente',
  pdf_url       TEXT,
  fecha_emision TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABLAS: logistica
-- ============================================================
CREATE TABLE IF NOT EXISTS rutas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  UUID REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id   UUID REFERENCES usuarios(id),
  fecha       DATE NOT NULL,
  estado      TEXT DEFAULT 'pendiente',
  notas       TEXT
);

CREATE TABLE IF NOT EXISTS entregas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ruta_id             UUID REFERENCES rutas(id) ON DELETE CASCADE,
  pedido_id           UUID REFERENCES pedidos(id),
  orden               INT,
  estado              TEXT DEFAULT 'pendiente',
  firma_url           TEXT,
  foto_url            TEXT,
  receptor            TEXT,
  notas_entrega       TEXT,
  fecha_confirmacion  TIMESTAMPTZ
);

-- ============================================================
-- TABLAS: finanzas
-- ============================================================
CREATE TABLE IF NOT EXISTS cobros (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  UUID REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id  UUID REFERENCES clientes(id),
  monto       NUMERIC(12,2) NOT NULL,
  medio       TEXT,
  referencia  TEXT,
  notas       TEXT,
  usuario_id  UUID REFERENCES usuarios(id),
  fecha       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cheques (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id    UUID REFERENCES clientes(id),
  banco         TEXT,
  numero        TEXT,
  monto         NUMERIC(12,2) NOT NULL,
  fecha_vto     DATE NOT NULL,
  estado        TEXT DEFAULT 'en_cartera',
  cobro_id      UUID REFERENCES cobros(id),
  notas         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cta_cte (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID REFERENCES clientes(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL,
  monto       NUMERIC(12,2) NOT NULL,
  factura_id  UUID REFERENCES facturas(id),
  cobro_id    UUID REFERENCES cobros(id),
  saldo       NUMERIC(12,2),
  fecha       TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- INDICES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_usuarios_empresa      ON usuarios(empresa_id);
CREATE INDEX IF NOT EXISTS idx_clientes_empresa      ON clientes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_productos_empresa     ON productos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_empresa       ON pedidos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente       ON pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_estado        ON pedidos(estado);
CREATE INDEX IF NOT EXISTS idx_pedidos_created       ON pedidos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_facturas_empresa      ON facturas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_facturas_estado       ON facturas(estado);
CREATE INDEX IF NOT EXISTS idx_stock_producto        ON stock(producto_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_producto  ON movimientos_stock(producto_id);
CREATE INDEX IF NOT EXISTS idx_cta_cte_cliente       ON cta_cte(cliente_id);
CREATE INDEX IF NOT EXISTS idx_cobros_empresa        ON cobros(empresa_id);
CREATE INDEX IF NOT EXISTS idx_cheques_empresa       ON cheques(empresa_id);
CREATE INDEX IF NOT EXISTS idx_cheques_vto           ON cheques(fecha_vto);

-- ============================================================
-- FIN DEL SCHEMA — Continuar con 002_rls.sql
-- ============================================================
