-- ============================================================
-- DISTRIB-APP — Seed de datos de prueba
-- Ejecutar DESPUÉS de 002_rls.sql
-- SOLO para entorno de desarrollo/staging — NUNCA en producción
-- MF Web Solutions | v1.0 | Junio 2026
-- ============================================================

-- ============================================================
-- IMPORTANTE: este seed usa UUIDs fijos para facilitar el
-- testing. En producción los IDs los genera la base de datos.
-- ============================================================

-- IDs fijos para referencias cruzadas
-- empresa   : 00000000-0000-0000-0000-000000000001
-- deposito  : 00000000-0000-0000-0000-000000000010
-- zona_norte: 00000000-0000-0000-0000-000000000020
-- zona_sur  : 00000000-0000-0000-0000-000000000021
-- lista_gen : 00000000-0000-0000-0000-000000000030
-- lista_may : 00000000-0000-0000-0000-000000000031
-- cat_lact  : 00000000-0000-0000-0000-000000000040
-- cat_alim  : 00000000-0000-0000-0000-000000000041
-- cliente_1 : 00000000-0000-0000-0000-000000000050
-- cliente_2 : 00000000-0000-0000-0000-000000000051
-- cliente_3 : 00000000-0000-0000-0000-000000000052

-- ============================================================
-- 1. EMPRESA DE PRUEBA
-- ============================================================
INSERT INTO empresas (id, nombre, cuit, domicilio, telefono, email)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Distribuidora El Progreso',
  '30-12345678-9',
  'Av. San Martín 1234, Reconquista, Santa Fe',
  '+54 3482 123456',
  'admin@elprogreso.com.ar'
);

-- ============================================================
-- 2. ZONA Y DEPOSITO
-- ============================================================
INSERT INTO zonas (id, empresa_id, nombre, dias_reparto) VALUES
  ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001', 'Zona Norte', ARRAY['lunes','miercoles','viernes']),
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001', 'Zona Sur',   ARRAY['martes','jueves']);

INSERT INTO depositos (id, empresa_id, nombre, es_principal) VALUES
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'Depósito Central', true);

-- ============================================================
-- 3. LISTAS DE PRECIOS
-- ============================================================
INSERT INTO listas_precios (id, empresa_id, nombre, es_default) VALUES
  ('00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000001', 'Lista General',    true),
  ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000001', 'Lista Mayorista',  false);

-- ============================================================
-- 4. CATEGORIAS DE PRODUCTOS
-- ============================================================
INSERT INTO categorias (id, empresa_id, nombre, orden) VALUES
  ('00000000-0000-0000-0000-000000000040', '00000000-0000-0000-0000-000000000001', 'Lácteos',        1),
  ('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-000000000001', 'Alimentos secos', 2),
  ('00000000-0000-0000-0000-000000000042', '00000000-0000-0000-0000-000000000001', 'Bebidas',         3),
  ('00000000-0000-0000-0000-000000000043', '00000000-0000-0000-0000-000000000001', 'Limpieza',        4);

-- ============================================================
-- 5. PRODUCTOS (10 productos de prueba)
-- ============================================================
INSERT INTO productos (id, empresa_id, codigo, nombre, categoria_id, unidad, costo, precio_base, iva) VALUES
  ('00000000-0000-0000-0000-000000000060', '00000000-0000-0000-0000-000000000001', 'LAC001', 'Leche entera 1L',           '00000000-0000-0000-0000-000000000040', 'unidad', 800,  1050,  10.5),
  ('00000000-0000-0000-0000-000000000061', '00000000-0000-0000-0000-000000000001', 'LAC002', 'Yogur natural 200g',        '00000000-0000-0000-0000-000000000040', 'unidad', 350,   480,  10.5),
  ('00000000-0000-0000-0000-000000000062', '00000000-0000-0000-0000-000000000001', 'LAC003', 'Queso cremoso 1kg',         '00000000-0000-0000-0000-000000000040', 'kg',    3200,  4500,  10.5),
  ('00000000-0000-0000-0000-000000000063', '00000000-0000-0000-0000-000000000001', 'ALI001', 'Arroz largo fino 1kg',      '00000000-0000-0000-0000-000000000041', 'unidad', 600,   850,  10.5),
  ('00000000-0000-0000-0000-000000000064', '00000000-0000-0000-0000-000000000001', 'ALI002', 'Aceite girasol 1.5L',       '00000000-0000-0000-0000-000000000041', 'unidad', 900,  1300,  10.5),
  ('00000000-0000-0000-0000-000000000065', '00000000-0000-0000-0000-000000000001', 'ALI003', 'Fideos tallarines 500g',    '00000000-0000-0000-0000-000000000041', 'unidad', 280,   420,  10.5),
  ('00000000-0000-0000-0000-000000000066', '00000000-0000-0000-0000-000000000001', 'BEB001', 'Gaseosa cola 2.25L',        '00000000-0000-0000-0000-000000000042', 'unidad', 650,   950,  21),
  ('00000000-0000-0000-0000-000000000067', '00000000-0000-0000-0000-000000000001', 'BEB002', 'Agua mineral 500ml',        '00000000-0000-0000-0000-000000000042', 'unidad', 180,   290,  10.5),
  ('00000000-0000-0000-0000-000000000068', '00000000-0000-0000-0000-000000000001', 'LIM001', 'Detergente limón 500ml',    '00000000-0000-0000-0000-000000000043', 'unidad', 420,   650,  21),
  ('00000000-0000-0000-0000-000000000069', '00000000-0000-0000-0000-000000000001', 'LIM002', 'Lavandina concentrada 1L',  '00000000-0000-0000-0000-000000000043', 'unidad', 380,   580,  21);

-- ============================================================
-- 6. PRECIOS EN LISTA GENERAL (= precio_base)
--    Y LISTA MAYORISTA (-10%)
-- ============================================================
INSERT INTO precios_items (lista_id, producto_id, precio)
SELECT '00000000-0000-0000-0000-000000000030', id, precio_base
FROM productos WHERE empresa_id = '00000000-0000-0000-0000-000000000001';

INSERT INTO precios_items (lista_id, producto_id, precio)
SELECT '00000000-0000-0000-0000-000000000031', id, ROUND(precio_base * 0.90, 2)
FROM productos WHERE empresa_id = '00000000-0000-0000-0000-000000000001';

-- ============================================================
-- 7. STOCK INICIAL (en depósito central)
-- ============================================================
INSERT INTO stock (producto_id, deposito_id, cantidad, costo_promedio)
SELECT
  p.id,
  '00000000-0000-0000-0000-000000000010',
  CASE
    WHEN p.codigo LIKE 'LAC%' THEN 200
    WHEN p.codigo LIKE 'BEB%' THEN 500
    ELSE 300
  END,
  p.costo
FROM productos p
WHERE p.empresa_id = '00000000-0000-0000-0000-000000000001';

-- ============================================================
-- 8. CLIENTES DE PRUEBA
-- (los auth.users de Supabase se crean manualmente o via signup;
--  acá creamos solo el registro en la tabla clientes)
-- ============================================================
INSERT INTO clientes (id, empresa_id, razon_social, nombre_fantasia, cuit, condicion_iva, domicilio, localidad, zona_id, telefono, email, lista_precio_id, limite_credito, dias_credito) VALUES
  (
    '00000000-0000-0000-0000-000000000050',
    '00000000-0000-0000-0000-000000000001',
    'Almacén Don Luis S.R.L.',
    'Almacén Don Luis',
    '30-87654321-0',
    'responsable_inscripto',
    'Belgrano 456',
    'Reconquista',
    '00000000-0000-0000-0000-000000000020',
    '+54 3482 987654',
    'donluis@gmail.com',
    '00000000-0000-0000-0000-000000000030',
    50000,
    30
  ),
  (
    '00000000-0000-0000-0000-000000000051',
    '00000000-0000-0000-0000-000000000001',
    'Supermercado El Ahorro',
    'El Ahorro',
    '20-11223344-5',
    'responsable_inscripto',
    'Mitre 789',
    'Reconquista',
    '00000000-0000-0000-0000-000000000020',
    '+54 3482 456789',
    'elahorro@hotmail.com',
    '00000000-0000-0000-0000-000000000031',
    100000,
    15
  ),
  (
    '00000000-0000-0000-0000-000000000052',
    '00000000-0000-0000-0000-000000000001',
    'Kiosco La Esquina',
    'Kiosco La Esquina',
    '27-99887766-3',
    'monotributo',
    'San Martín 101',
    'Villa Ocampo',
    '00000000-0000-0000-0000-000000000021',
    '+54 3482 111222',
    'laesquina@gmail.com',
    '00000000-0000-0000-0000-000000000030',
    20000,
    0
  );

-- ============================================================
-- 9. PEDIDO DE PRUEBA (para verificar el flujo completo)
-- ============================================================
INSERT INTO pedidos (id, empresa_id, cliente_id, estado, subtotal, iva_total, total, notas_cliente, fecha_entrega)
VALUES (
  '00000000-0000-0000-0000-000000000070',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000050',
  'confirmado',
  2905.00,
  304.98,
  3209.98,
  'Entregar en horario de mañana',
  CURRENT_DATE + INTERVAL '2 days'
);

INSERT INTO pedido_items (pedido_id, producto_id, cantidad, precio_unitario, subtotal) VALUES
  ('00000000-0000-0000-0000-000000000070', '00000000-0000-0000-0000-000000000060', 10, 1050.00, 10500.00),
  ('00000000-0000-0000-0000-000000000070', '00000000-0000-0000-0000-000000000063',  5,  850.00,  4250.00),
  ('00000000-0000-0000-0000-000000000070', '00000000-0000-0000-0000-000000000066', 12,  950.00, 11400.00);

-- ============================================================
-- NOTA SOBRE USUARIOS:
-- Los usuarios (dueno, vendedor, cliente) se crean primero
-- en Supabase Auth (Dashboard > Authentication > Users),
-- y luego se inserta su registro en la tabla usuarios así:
--
-- INSERT INTO usuarios (id, empresa_id, nombre, email, rol)
-- VALUES (
--   '<UUID del auth.user creado en Supabase>',
--   '00000000-0000-0000-0000-000000000001',
--   'Carlos Martínez',
--   'carlos@elprogreso.com.ar',
--   'dueno'
-- );
--
-- Repetir para vendedor (rol='vendedor') y cliente (rol='cliente')
-- El cliente debe tener el mismo email que el registro en clientes
-- ============================================================

-- ============================================================
-- FIN DEL SEED
-- ============================================================
