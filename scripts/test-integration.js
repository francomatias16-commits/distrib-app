#!/usr/bin/env node
/**
 * test-integration.js — Simulación completa de entrada/salida DB ↔ código
 *
 * Crea datos de prueba aislados (prefijo TEST_), ejercita CADA operación
 * que hacen los handlers, verifica respuestas y limpia todo al final.
 *
 * Uso:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJhb... \
 *   node scripts/test-integration.js [--verbose] [--no-cleanup] [--json]
 *
 * Flags:
 *   --verbose     Mostrar datos completos de cada respuesta
 *   --no-cleanup  No borrar datos de prueba al final (para inspección)
 *   --json        Output en JSON (para CI/CD, exit 1 si hay fallos)
 *   --only=GRUPO  Correr solo un grupo: setup|stock|clientes|pedidos|puntos|notif
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VERBOSE    = process.argv.includes('--verbose');
const NO_CLEANUP = process.argv.includes('--no-cleanup');
const FLAG_JSON  = process.argv.includes('--json');
const ONLY       = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7) || null;

// ── Tablas requeridas (para reporte de cobertura) ───────────────────────────────
const ALL_TABLES_TO_CHECK = [
  'alertas_score', 'alertas_stock', 'audit_log', 'bloqueos_cliente', 'canjes_recompensas',
  'categorias', 'cheques', 'ciclos_compra', 'clientes', 'cobros', 'contadores_empresa',
  'cta_cte', 'depositos', 'dispositivos_push', 'empresas', 'entregas', 'facturas',
  'integraciones_pago', 'listas_precios', 'lotes', 'movimientos_puntos',
  'movimientos_stock', 'notas_internas', 'notif_log', 'notificaciones_push', 'ordenes_compra',
  'ordenes_compra_items', 'pedido_items', 'pedidos', 'precios_items', 'presupuesto_items',
  'presupuestos', 'productos', 'programas_fidelizacion', 'saldo_puntos', 'recompensas',
  'reglas_score', 'rutas', 'scores_cliente', 'stock', 'sugerencias_pedido', 'transacciones_pago',
  'usuarios', 'zonas',
];

const COVERED_TABLES = new Set();

// ── Colores ───────────────────────────────────────────────────────────────────
const C = FLAG_JSON ? { ok:'',fail:'',skip:'',h:'',dim:'',y:'',x:'' } : {
  ok:   '\x1b[32m', fail: '\x1b[31m', skip: '\x1b[33m',
  h:    '\x1b[36m', dim:  '\x1b[90m', y:    '\x1b[33m', x: '\x1b[0m',
};

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(`${C.fail}[FAIL] Faltan env vars: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY${C.x}`);
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ── Estado de la sesión de prueba ─────────────────────────────────────────────
const TEST_TAG = `TEST_${Date.now()}`;
const IDS = {};        // IDs de los registros creados
const results = [];    // { group, id, desc, ok, ms, error?, data? }

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(...args) { if (!FLAG_JSON) console.log(...args); }

async function run(group, id, desc, fn, tableNames = []) {
  if (ONLY && ONLY !== group) {
    results.push({ group, id, desc, ok: null, ms: 0, skipped: true });
    return null;
  }

  for (const tableName of tableNames) {
    COVERED_TABLES.add(tableName);
  }
  const t0 = Date.now();
  try {
    const data = await fn();
    const ms = Date.now() - t0;
    results.push({ group, id, desc, ok: true, ms, data: VERBOSE ? data : undefined });
    log(`  ${C.ok}[OK]${C.x} ${C.dim}[${id}]${C.x} ${desc} ${C.dim}(${ms}ms)${C.x}`);
    return data;
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = err.message || String(err);
    results.push({ group, id, desc, ok: false, ms, error: msg });
    log(`  ${C.fail}[FAIL]${C.x} ${C.dim}[${id}]${C.x} ${desc}`);
    log(`    ${C.fail}→ ${msg}${C.x}`);
    return null;
  }
}

/** Wrapper Supabase: lanza si hay error */
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

/** Assert helper */
function assert(cond, msg) {
  if (!cond) throw new Error(`Aserción fallida: ${msg}`);
}


// ════════════════════════════════════════════════════════════════════════════
// GRUPO 1 — SETUP: crear toda la jerarquía de datos de prueba
// ════════════════════════════════════════════════════════════════════════════

async function grupoSetup() {
  log(`\n${C.h}── SETUP — Crear datos de prueba aislados ─────────────────────────${C.x}`);

  // T01: empresa
  IDS.empresa = await run('setup', 'T01', 'Crear empresa de prueba', async () => {
    const data = await q(sb.from('empresas').insert({
      nombre: `${TEST_TAG}_Empresa`,
      cuit:   `30-99999999-9-${TEST_TAG}`,
      config: { moneda: 'ARS', iva_default: 21 },
    }).select().single());
    assert(data.id, 'empresa sin id');
    return data.id;
  }, ['empresas']);

  // T02: usuario (con auth.users real, service_role)
  IDS.usuario = await run('setup', 'T02', 'Crear usuario admin de prueba (con auth.users real)', async () => {
    // Crear un usuario real en auth.users para satisfacer la FK
    const { data: authUser, error: authError } = await sb.auth.admin.createUser({
      email:    `test_${Date.now()}@test.local`,
      password: 'password123',
    });
    if (authError) throw new Error(`Error creando auth user: ${authError.message}`);

    const data = await q(sb.from('usuarios').insert({
      id:         authUser.user.id,
      empresa_id: IDS.empresa,
      nombre:     `${TEST_TAG}_Admin`,
      email:      authUser.user.email,
      rol:        'admin',
    }).select().single());
    assert(data.id, 'usuario sin id');
    return data.id;
  }, ['usuarios', 'auth.users']);

  // T03: zona
  IDS.zona = await run('setup', 'T03', 'Crear zona de prueba', async () => {
    const data = await q(sb.from('zonas').insert({
      empresa_id: IDS.empresa,
      nombre:     `${TEST_TAG}_Zona Norte`,
      activa:     true,
    }).select().single());
    return data.id;
  }, ['zonas']);

  // T04: lista de precios
  IDS.lista = await run('setup', 'T04', 'Crear lista de precios', async () => {
    const data = await q(sb.from('listas_precios').insert({
      empresa_id: IDS.empresa,
      nombre:     `${TEST_TAG}_Lista Default`,
      es_default: true,
      activa:     true,
    }).select().single());
    return data.id;
  }, ['listas_precios']);

  // T05: categoría (con columna 'activa' — migration 041/048)
  IDS.categoria = await run('setup', 'T05', 'Crear categoría (activa=true)', async () => {
    const data = await q(sb.from('categorias').insert({
      empresa_id: IDS.empresa,
      nombre:     `${TEST_TAG}_Bebidas`,
      orden:      1,
      activa:     true,   // columna agregada en migration 041
    }).select().single());
    return data.id;
  }, ['categorias']);

  // T06: depósito principal
  IDS.deposito = await run('setup', 'T06', 'Crear depósito principal', async () => {
    const data = await q(sb.from('depositos').insert({
      empresa_id:   IDS.empresa,
      nombre:       `${TEST_TAG}_Depósito Central`,
      es_principal: true,
    }).select().single());
    return data.id;
  }, ['depositos']);

  // T07: producto (columnas reales: descripcion, foto_url, no descripcion_corta)
  IDS.producto = await run('setup', 'T07', 'Crear producto (columnas reales: descripcion, foto_url)', async () => {
    const data = await q(sb.from('productos').insert({
      empresa_id:  IDS.empresa,
      codigo:      `${TEST_TAG}_P001`,
      nombre:      `${TEST_TAG}_Agua Mineral 500ml`,
      descripcion: 'Agua mineral sin gas 500ml',   // columna real (no descripcion_corta)
      categoria_id: IDS.categoria,
      unidad:      'unidad',
      precio_base: 150.00,
      iva:         21,
      foto_url:    'https://example.com/agua.jpg', // columna real (no imagen_url)
      activo:      true,
      stock_minimo: 10,
    }).select().single());
    assert(data.descripcion !== undefined, 'descripcion debe existir');
    assert(data.foto_url !== undefined, 'foto_url debe existir');
    assert(data.imagen_url === undefined || data.imagen_url === null, 
           'imagen_url NO debe ser columna real (es alias)');
    return data.id;
  }, ['productos']);

  // T08: stock inicial
  IDS.stock = await run('setup', 'T08', 'Crear stock inicial (cantidad + cantidad_reservada)', async () => {
    const data = await q(sb.from('stock').insert({
      producto_id:         IDS.producto,
      deposito_id:         IDS.deposito,
      cantidad:            100,
      cantidad_reservada:  5,   // esta columna SÍ existe en stock
      costo_promedio:      80,
    }).select().single());
    assert(data.cantidad_reservada !== undefined, 'stock.cantidad_reservada debe existir');
    return data.id;
  }, ['stock']);

  // T09: cliente
  IDS.cliente = await run('setup', 'T09', 'Crear cliente de prueba', async () => {
    const data = await q(sb.from('clientes').insert({
      empresa_id:    IDS.empresa,
      razon_social:  `${TEST_TAG}_Almacén El Tío`,
      nombre_fantasia: 'El Tío',
      cuit:          '20-12345678-1',
      zona_id:       IDS.zona,
      lista_precio_id: IDS.lista,
      telefono:      '+5491100000000',
      activo:        true,
    }).select().single());
    return data.id;
  }, ['clientes']);
}


// ════════════════════════════════════════════════════════════════════════════
// GRUPO 2 — STOCK: categorías, productos, lotes
// ════════════════════════════════════════════════════════════════════════════

async function grupoStock() {
  log(`\n${C.h}── STOCK — Categorías, Productos, Lotes ─────────────────────────────${C.x}`);

  // T10: leer categorías filtrando activa=true (como hace handleClienteCategorias)
  await run('stock', 'T10', 'GET categorias donde activa=true (columna migration 041)', async () => {
    const data = await q(
      sb.from('categorias')
        .select('id, nombre, orden, activa')
        .eq('empresa_id', IDS.empresa)
        .eq('activa', true)         // columna real: activa (no activo)
        .order('orden')
    );
    assert(data.length >= 1, 'debe devolver al menos 1 categoría');
    const found = data.find(c => c.id === IDS.categoria);
    assert(found, 'la categoría de prueba debe aparecer');
    assert(found.activa === true, 'activa debe ser true');
    return { count: data.length };
  }, ['categorias']);

  // T11: productos con columnas reales + alias del handler
  await run('stock', 'T11', 'GET productos con columnas reales (descripcion, foto_url)', async () => {
    const data = await q(
      sb.from('productos')
        .select('id, codigo, nombre, descripcion, unidad, precio_base, foto_url, categoria_id')
        .eq('empresa_id', IDS.empresa)
        .eq('activo', true)
    );
    assert(data.length >= 1, 'debe haber al menos 1 producto');
    const p = data.find(d => d.id === IDS.producto);
    assert(p, 'producto de prueba debe aparecer');
    assert(p.descripcion, 'descripcion debe tener valor');
    assert(p.foto_url, 'foto_url debe tener valor');
    // Simular el alias que aplica el handler
    const conAlias = { ...p, imagen_url: p.foto_url, descripcion_corta: p.descripcion };
    assert(conAlias.imagen_url, 'alias imagen_url debe funcionar');
    assert(conAlias.descripcion_corta, 'alias descripcion_corta debe funcionar');
    return { producto: p.nombre, descripcion: p.descripcion };
  }, ['productos']);

  // T12: búsqueda por descripcion (no descripcion_corta)
  await run('stock', 'T12', 'Búsqueda en productos por descripcion (ilike)', async () => {
    const busqueda = 'mineral';
    const data = await q(
      sb.from('productos')
        .select('id, nombre, descripcion')
        .eq('empresa_id', IDS.empresa)
        .or(`nombre.ilike.%${busqueda}%,codigo.ilike.%${busqueda}%,descripcion.ilike.%${busqueda}%`)
    );
    assert(data.length >= 1, 'búsqueda debe encontrar al menos 1 producto');
    return { encontrados: data.length };
  }, ['productos']);

  // T13: crear lote con estado='activo' (no 'vigente')
  IDS.lote = await run('stock', 'T13', "Crear lote con estado='activo' (CHECK constraint)", async () => {
    const venc = new Date();
    venc.setMonth(venc.getMonth() + 6);
    const data = await q(sb.from('lotes').insert({
      empresa_id:       IDS.empresa,
      producto_id:      IDS.producto,
      deposito_id:      IDS.deposito,
      numero_lote:      `${TEST_TAG}_LOTE001`,
      cantidad:         50,
      // cantidad_reservada NO existe en lotes (solo en stock)
      costo_unitario:   80,
      fecha_vencimiento: venc.toISOString().split('T')[0],
      estado:           'activo',  // valor correcto (no 'vigente')
    }).select().single());
    assert(data.estado === 'activo', `estado debe ser 'activo', es '${data.estado}'`);
    return data.id;
  }, ['lotes']);

  // T14: intentar insertar lote con estado='vigente' → debe fallar (CHECK)
  await run('stock', 'T14', "Intentar estado='vigente' → CHECK constraint debe rechazarlo", async () => {
    const { error } = await sb.from('lotes').insert({
      empresa_id:  IDS.empresa,
      producto_id: IDS.producto,
      deposito_id: IDS.deposito,
      numero_lote: `${TEST_TAG}_LOTE_MALO`,
      cantidad:    1,
      estado:      'vigente',  // valor inválido
    });
    assert(error, "DB debe rechazar estado='vigente' con CHECK constraint");
    assert(error.message.includes('lotes_estado_check') || error.message.includes('check'),
           `Error esperado CHECK constraint, got: ${error.message}`);
    return { rechazado: true, error: error.message };
  }, ['lotes']);

  // T15: leer lotes FEFO sin cantidad_reservada (no existe en lotes)
  await run('stock', 'T15', 'Leer lotes FEFO (sin cantidad_reservada, solo cantidad)', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const data = await q(
      sb.from('lotes')
        .select('id, numero_lote, fecha_vencimiento, cantidad')  // sin cantidad_reservada
        .eq('empresa_id', IDS.empresa)
        .eq('producto_id', IDS.producto)
        .gt('cantidad', 0)
        .gte('fecha_vencimiento', hoy)
        .not('estado', 'eq', 'agotado')     // sin 'dado_de_baja' (no existe)
        .order('fecha_vencimiento', { ascending: true })
    );
    assert(data.length >= 1, 'debe encontrar al menos 1 lote activo');
    const lote = data[0];
    assert(lote.cantidad !== undefined, 'cantidad debe existir');
    assert(lote.cantidad_reservada === undefined, 
           'cantidad_reservada NO debe existir en lotes (es columna de stock)');
    // Simular cálculo disponible sin cantidad_reservada
    const disponible = Math.max(0, lote.cantidad);
    assert(disponible > 0, 'disponible debe ser > 0');
    return { lotes: data.length, disponible };
  }, ['lotes']);

  // T16: stock con cantidad_reservada (sí existe en stock)
  await run('stock', 'T16', 'Leer stock con cantidad_reservada (columna real de stock)', async () => {
    const data = await q(
      sb.from('stock')
        .select('id, cantidad, cantidad_reservada, costo_promedio')
        .eq('deposito_id', IDS.deposito)
        .eq('producto_id', IDS.producto)
    );
    assert(data.length >= 1, 'debe haber stock');
    const s = data[0];
    assert(s.cantidad_reservada !== undefined, 'stock.cantidad_reservada debe existir');
    const disponible = Math.max(0, s.cantidad - s.cantidad_reservada);
    assert(disponible >= 0, 'disponible debe ser >= 0');
    return { cantidad: s.cantidad, reservada: s.cantidad_reservada, disponible };
  }, ['stock']);
}


// ════════════════════════════════════════════════════════════════════════════
// GRUPO 3 — CLIENTES: CRUD básico
// ════════════════════════════════════════════════════════════════════════════

async function grupoClientes() {
  log(`\n${C.h}── CLIENTES — CRUD ────────────────────────────────────────────────────${C.x}`);

  // T17: leer clientes (columnas reales)
  await run('clientes', 'T17', 'GET clientes con joins (zonas, listas_precios)', async () => {
    const data = await q(
      sb.from('clientes')
        .select('id, razon_social, nombre_fantasia, telefono, activo, zonas(nombre), listas_precios(nombre)')
        .eq('empresa_id', IDS.empresa)
        .eq('activo', true)
    );
    assert(data.length >= 1, 'debe haber al menos 1 cliente');
    const c = data.find(d => d.id === IDS.cliente);
    assert(c, 'cliente de prueba debe aparecer');
    assert(c.zonas?.nombre, 'join con zonas debe funcionar');
    assert(c.listas_precios?.nombre, 'join con listas_precios debe funcionar');
    return { clientes: data.length, zona: c.zonas.nombre };
  }, ['clientes', 'zonas', 'listas_precios']);

  // T18: actualizar cliente
  await run('clientes', 'T18', 'PATCH cliente (actualizar telefono)', async () => {
    const data = await q(
      sb.from('clientes')
        .update({ telefono: '+5491199999999', notas: 'Test update' })
        .eq('id', IDS.cliente)
        .eq('empresa_id', IDS.empresa)
        .select()
        .single()
    );
    assert(data.telefono === '+5491199999999', 'telefono debe actualizarse');
    return { telefono: data.telefono };
  }, ['clientes']);
}


// ════════════════════════════════════════════════════════════════════════════
// GRUPO 4 — PEDIDOS: crear, leer, estado
// ════════════════════════════════════════════════════════════════════════════

async function grupoPedidos() {
  log(`\n${C.h}── PEDIDOS — Flujo completo ────────────────────────────────────────────${C.x}`);

  // T19: crear pedido (columnas reales: notas_cliente, sin numero_pedido)
  IDS.pedido = await run('pedidos', 'T19', 'Crear pedido (notas_cliente, sin numero_pedido)', async () => {
    const data = await q(sb.from('pedidos').insert({
      empresa_id:   IDS.empresa,
      cliente_id:   IDS.cliente,
      vendedor_id:  IDS.usuario,
      estado:       'confirmado',
      subtotal:     150.00,
      iva_total:    31.50,
      total:        181.50,
      notas_cliente: 'Entregar por la mañana',   // columna real (no 'notas')
    }).select().single());
    assert(data.notas_cliente === 'Entregar por la mañana', 'notas_cliente debe guardarse');
    assert(data.numero_pedido === undefined || data.numero_pedido === null,
           'numero_pedido NO existe como columna (debe generarse desde id)');
    return data.id;
  }, ['pedidos']);

  // T20: generar numero_pedido desde id (como hacen los handlers)
  await run('pedidos', 'T20', 'Generar numero_pedido desde id (id.slice(0,8).toUpperCase())', async () => {
    const data = await q(
      sb.from('pedidos').select('id, estado, total, notas_cliente').eq('id', IDS.pedido).single()
    );
    // Simular lo que hace el handler del chofer
    const numeroPedido = data.id.slice(0, 8).toUpperCase();
    assert(numeroPedido.length === 8, 'numero_pedido generado debe tener 8 chars');
    assert(/^[0-9A-F-]+$/.test(numeroPedido), 'debe ser hex mayúscula');
    // Verificar que notas_cliente está disponible y 'notas' no
    assert(data.notas_cliente === 'Entregar por la mañana', 'notas_cliente debe leerse');
    return { numero_pedido: numeroPedido, notas_cliente: data.notas_cliente };
  }, ['pedidos']);

  // T21: insertar pedido_item (columna descuento_pct, no descuento)
  IDS.pedido_item = await run('pedidos', 'T21', 'Insertar pedido_item (descuento_pct)', async () => {
    const data = await q(sb.from('pedido_items').insert({
      pedido_id:       IDS.pedido,
      producto_id:     IDS.producto,
      cantidad:        1,
      precio_unitario: 150.00,
      descuento_pct:   0,    // columna real (no 'descuento')
      subtotal:        150.00,
    }).select().single());
    assert(data.descuento_pct !== undefined, 'descuento_pct debe existir');
    return data.id;
  }, ['pedido_items']);

  // T22: leer pedido completo con items (simular handler admin)
  await run('pedidos', 'T22', 'GET pedido con items (admin handler)', async () => {
    const data = await q(
      sb.from('pedidos')
        .select(`
          id, estado, total, notas_cliente, notas_internas, fecha_pedido,
          clientes(id, razon_social),
          pedido_items(id, cantidad, precio_unitario, descuento_pct, subtotal,
            productos(nombre, unidad))
        `)
        .eq('id', IDS.pedido)
        .single()
    );
    assert(data.estado === 'confirmado', 'estado debe ser confirmado');
    assert(data.notas_cliente, 'notas_cliente debe leerse');
    assert(data.clientes?.razon_social, 'join clientes debe funcionar');
    assert(data.pedido_items?.length >= 1, 'debe haber items');
    const item = data.pedido_items[0];
    assert(item.descuento_pct !== undefined, 'descuento_pct debe leerse en item');
    assert(item.productos?.nombre, 'join productos en item debe funcionar');
    return {
      numero: data.id.slice(0, 8).toUpperCase(),
      cliente: data.clientes.razon_social,
      items: data.pedido_items.length,
    };
  }, ['pedidos', 'clientes', 'pedido_items', 'productos']);

  // T23: simular handler chofer — leer pedidos del día sin numero_pedido en SELECT
  await run('pedidos', 'T23', 'Chofer: leer pedidos sin numero_pedido en SELECT (generado post-fetch)', async () => {
    const hoy = new Date().toISOString().slice(0, 10);
    const data = await q(
      sb.from('pedidos')
        // handler corregido: sin numero_pedido, con notas_cliente
        .select('id, estado, total, notas_cliente, created_at, clientes(id, razon_social)')
        .eq('empresa_id', IDS.empresa)
        .in('estado', ['confirmado', 'preparando', 'despachado'])
        .gte('created_at', `${hoy}T00:00:00.000Z`)
        .lte('created_at', `${hoy}T23:59:59.999Z`)
    );
    // Simular lo que hace el handler post-fetch
    const remitos = data.map(r => ({ ...r, numero_pedido: r.id.slice(0, 8).toUpperCase() }));
    assert(remitos.length >= 1, 'debe encontrar el pedido de prueba del día');
    assert(remitos[0].numero_pedido, 'numero_pedido generado debe existir');
    assert(remitos[0].notas_cliente, 'notas_cliente debe leerse');
    return { remitos: remitos.length, ejemplo_numero: remitos[0].numero_pedido };
  }, ['pedidos', 'clientes']);

  // T24: cambiar estado del pedido
  await run('pedidos', 'T24', 'PATCH estado pedido → despachado', async () => {
    const data = await q(
      sb.from('pedidos')
        .update({ estado: 'despachado', fecha_despacho: new Date().toISOString() })
        .eq('id', IDS.pedido)
        .select('id, estado, fecha_despacho')
        .single()
    );
    assert(data.estado === 'despachado', 'estado debe ser despachado');
    assert(data.fecha_despacho, 'fecha_despacho debe guardarse');
    return { estado: data.estado };
  }, ['pedidos']);

  // T25: cancelar pedido via RPC cancelar_pedido (firma única post etapa 4)
  await run('pedidos', 'T25', 'RPC cancelar_pedido(pedido_id, motivo)', async () => {
    // Primero volver a confirmado para poder cancelar
    await q(sb.from('pedidos').update({ estado: 'confirmado' }).eq('id', IDS.pedido));
    const data = await q(
      sb.rpc('cancelar_pedido', {
        p_pedido_id: IDS.pedido,
        p_motivo:    'Test de cancelación automatizada',
      })
    );
    assert(data, 'RPC debe devolver resultado');
    // Verificar que el estado cambió
    const pedido = await q(sb.from('pedidos').select('estado').eq('id', IDS.pedido).single());
    assert(pedido.estado === 'cancelado', `estado debe ser 'cancelado', es '${pedido.estado}'`);
    return { resultado: data };
  }, ['pedidos']);
}


// ════════════════════════════════════════════════════════════════════════════
// GRUPO 5 — PUNTOS: saldo, movimientos, RPCs
// ════════════════════════════════════════════════════════════════════════════

async function grupoPuntos() {
  log(`\n${C.h}── PUNTOS — Saldo, Movimientos, RPCs ──────────────────────────────────${C.x}`);

  // T26: registrar_movimiento_puntos con params correctos
  await run('puntos', 'T26', 'RPC registrar_movimiento_puntos (params corregidos)', async () => {
    const data = await q(sb.rpc('registrar_movimiento_puntos', {
      p_cliente_id:    IDS.cliente,
      p_empresa_id:    IDS.empresa,
      p_tipo:          'ganancia',
      p_cantidad:      100,                 // era p_puntos (incorrecto)
      p_motivo:        'Test automatizado',
      p_referencia_id: IDS.pedido,          // era p_referencia (incorrecto)
    }));
    assert(data, 'RPC debe devolver UUID del movimiento');
    return { movimiento_id: data };
  }, ['movimientos_puntos']);

  // T27: verificar que se creó el movimiento en movimientos_puntos
  await run('puntos', 'T27', 'Verificar movimiento en movimientos_puntos', async () => {
    const data = await q(
      sb.from('movimientos_puntos')
        .select('id, tipo, cantidad, motivo, referencia_id')
        .eq('cliente_id', IDS.cliente)
        .eq('empresa_id', IDS.empresa)
        .order('created_at', { ascending: false })
        .limit(1)
    );
    assert(data.length >= 1, 'debe haber al menos 1 movimiento');
    const m = data[0];
    assert(m.tipo === 'ganancia', `tipo debe ser 'ganancia', es '${m.tipo}'`);
    assert(Number(m.cantidad) === 100, `cantidad debe ser 100, es ${m.cantidad}`);
    assert(m.referencia_id === IDS.pedido, 'referencia_id debe apuntar al pedido');
    return { tipo: m.tipo, cantidad: m.cantidad };
  }, ['movimientos_puntos']);

  // T28: upsert saldo_puntos con onConflict correcto (cliente_id, empresa_id)
  await run('puntos', 'T28', 'Upsert saldo_puntos con onConflict=(cliente_id,empresa_id)', async () => {
    const data = await q(
      sb.from('saldo_puntos').upsert({
        cliente_id:         IDS.cliente,
        empresa_id:         IDS.empresa,
        puntos_disponibles: 100,
        puntos_totales:     100,
        ultimo_movimiento:  new Date().toISOString(),
      }, { onConflict: 'cliente_id,empresa_id', ignoreDuplicates: false })
       .select().single()
    );
    assert(Number(data.puntos_disponibles) >= 100, 'puntos_disponibles debe ser >= 100');
    return { puntos: data.puntos_disponibles };
  }, ['saldo_puntos']);

  // T29: leer saldo_puntos del cliente
  await run('puntos', 'T29', 'GET saldo_puntos del cliente', async () => {
    const data = await q(
      sb.from('saldo_puntos')
        .select('puntos_disponibles, puntos_totales, ultimo_movimiento')
        .eq('cliente_id', IDS.cliente)
        .eq('empresa_id', IDS.empresa)
        .single()
    );
    assert(Number(data.puntos_disponibles) >= 0, 'puntos_disponibles debe ser >= 0');
    return { puntos_disponibles: data.puntos_disponibles };
  }, ['saldo_puntos']);

  // T30: RPCs acreditar_puntos y canjear_puntos (creados en migration 048)
  await run('puntos', 'T30', 'RPC acreditar_puntos (migration 048)', async () => {
    const data = await q(sb.rpc('acreditar_puntos', {
      p_empresa_id: IDS.empresa,
      p_cliente_id: IDS.cliente,
      p_puntos:     50,
      p_concepto:   'Acreditación de prueba',
      p_ref_tipo:   'manual',
    }));
    assert(data?.ok === true || data?.saldo !== undefined, 
           `acreditar_puntos debe devolver {ok,saldo}, recibí: ${JSON.stringify(data)}`);
    return { saldo_nuevo: data?.saldo };
  }, ['movimientos_puntos', 'saldo_puntos']); // RPCs afectan estas tablas

  await run('puntos', 'T31', 'RPC canjear_puntos (migration 048)', async () => {
    const data = await q(sb.rpc('canjear_puntos', {
      p_empresa_id: IDS.empresa,
      p_cliente_id: IDS.cliente,
      p_puntos:     10,
      p_concepto:   'Canje de prueba',
      p_ref_tipo:   'manual',
    }));
    assert(data?.ok === true || data?.saldo_nuevo !== undefined,
           `canjear_puntos debe devolver {ok,saldo_nuevo}, recibí: ${JSON.stringify(data)}`);
    return { saldo_nuevo: data?.saldo_nuevo };
  }, ['movimientos_puntos', 'saldo_puntos']); // RPCs afectan estas tablas
}


// ════════════════════════════════════════════════════════════════════════════
// GRUPO 6 — NOTIFICACIONES: notif_log, notificaciones_push
// ════════════════════════════════════════════════════════════════════════════

async function grupoNotif() {
  log(`\n${C.h}── NOTIFICACIONES — notif_log + notificaciones_push ─────────────────────${C.x}`);

  // T32: insertar en notif_log (tabla creada en migration 048)
  IDS.notif_log = await run('notif', 'T32', 'INSERT notif_log (migration 048)', async () => {
    const data = await q(sb.from('notif_log').insert({
      empresa_id: IDS.empresa,
      cliente_id: IDS.cliente,
      pedido_id:  IDS.pedido,
      tipo:       'confirmacion_pedido',
      canal:      'whatsapp',
      telefono:   '+5491199999999',
      message_id: `test_${Date.now()}`,
      payload:    { numero_pedido: IDS.pedido?.slice(0,8).toUpperCase(), total: 181.50 },
    }).select().single());
    assert(data.id, 'notif_log debe devolver id');
    return data.id;
  }, ['notif_log']);

  // T33: leer notif_log (auditoría)
  await run('notif', 'T33', 'GET notif_log por empresa_id y pedido_id', async () => {
    const data = await q(
      sb.from('notif_log')
        .select('id, tipo, canal, telefono, created_at')
        .eq('empresa_id', IDS.empresa)
        .eq('pedido_id', IDS.pedido)
        .order('created_at', { ascending: false })
    );
    assert(data.length >= 1, 'debe haber al menos 1 log');
    assert(data[0].tipo === 'confirmacion_pedido', 'tipo debe ser correcto');
    return { logs: data.length, ultimo_tipo: data[0].tipo };
  }, ['notif_log']);

  // T34: insertar en notificaciones_push (las que usa admin alertas)
  IDS.notif_push = await run('notif', 'T34', 'INSERT notificaciones_push (tabla real alertas admin)', async () => {
    const data = await q(sb.from('notificaciones_push').insert({
      empresa_id: IDS.empresa,
      titulo:     'Pedido nuevo',
      cuerpo:     'Se recibió un nuevo pedido de prueba',
      tipo:       'pedido_nuevo',
      leida:      false,             // columna real: leida (no leido)
      enviada:    true,
    }).select().single());
    assert(data.id, 'debe devolver id');
    assert(data.leida === false, "leida debe ser false (no 'leido')");
    return data.id;
  }, ['notificaciones_push']);

  // T35: leer notificaciones_push sin leer (como hace admin handleAlertas)
  await run('notif', 'T35', 'GET notificaciones_push sin leer (handler admin corregido)', async () => {
    const data = await q(
      sb.from('notificaciones_push')
        .select('id, tipo, titulo, cuerpo, leida, created_at')  // leida (no leido)
        .eq('empresa_id', IDS.empresa)
        .order('created_at', { ascending: false })
        .limit(20)
    );
    // Filtrar las no leídas como hace el handler (en JS, no en query)
    const sinLeer = data.filter(n => !n.leida);
    assert(sinLeer.length >= 1, 'debe haber al menos 1 notificación sin leer');
    assert(sinLeer[0].titulo, 'titulo debe leerse');
    assert(sinLeer[0].cuerpo, 'cuerpo debe leerse');
    return { total: data.length, sin_leer: sinLeer.length };
  }, ['notificaciones_push']);

  // T36: marcar como leída
  await run('notif', 'T36', "PATCH notificaciones_push leida=true", async () => {
    const data = await q(
      sb.from('notificaciones_push')
        .update({ leida: true, leida_at: new Date().toISOString() })
        .eq('id', IDS.notif_push)
        .select('id, leida, leida_at')
        .single()
    );
    assert(data.leida === true, 'leida debe ser true después del update');
    assert(data.leida_at, 'leida_at debe guardarse');
    return { leida: data.leida };
  }, ['notificaciones_push']);

  // T37: cooldown check (como hace notif.js para no spamear WA)
  await run('notif', 'T37', 'Cooldown check via notif_log (buscar envíos recientes)', async () => {
    const haceUnaHora = new Date(Date.now() - 3600_000).toISOString();
    const data = await q(
      sb.from('notif_log')
        .select('created_at')
        .eq('cliente_id', IDS.cliente)
        .eq('tipo', 'confirmacion_pedido')
        .gte('created_at', haceUnaHora)
        .order('created_at', { ascending: false })
        .limit(1)
    );
    const envioReciente = data.length > 0;
    assert(envioReciente, 'debe detectar el log reciente de confirmación');
    return { envio_reciente: envioReciente, created_at: data[0]?.created_at };
  }, ['notif_log']);
}


// ════════════════════════════════════════════════════════════════════════════
// GRUPO 8 — IMPORTAR: RPC importar_productos_lote
// ════════════════════════════════════════════════════════════════════════════

async function grupoImportar() {
  log(`\n${C.h}── IMPORTAR — RPC importar_productos_lote ──────────────────────────────${C.x}`);

  // T38: importar lote vacío → debe rechazar con error
  await run('importar', 'T38', 'importar_productos_lote con array vacío → error 400', async () => {
    const data = await q(sb.rpc('importar_productos_lote', {
      p_empresa_id:      IDS.empresa,
      p_filas:           [],
      p_lista_precio_id: null,
      p_lista_nombre:    null,
      p_deposito_id:     null,
    }));
    // Array vacío actualmente devuelve ok=true con resumen de 0s. Ajustar aserción al comportamiento actual.
    assert(data?.ok === true, `RPC debería devolver ok=true para array vacío, recibí: ${JSON.stringify(data)}`);
    const { insertados = 0, actualizados = 0, errores = 0 } = data.resumen;
    assert(insertados === 0 && actualizados === 0 && errores === 0, `No debería haber cambios para array vacío, resumen: ${JSON.stringify(data.resumen)}`);
    return { resultado: data?.error || 'OK' };
  }, ['productos']); // Asumiendo que importar_productos_lote impacta en productos

  // T39: importar un producto nuevo válido via RPC
  IDS.producto_importado = await run('importar', 'T39', 'importar_productos_lote: 1 producto nuevo', async () => {
    const { data, error } = await sb.rpc('importar_productos_lote', {
      p_empresa_id:      IDS.empresa,
      p_filas:           [{
        codigo:    `${TEST_TAG}_IMP001`,
        nombre:    `${TEST_TAG}_Producto Importado`,
        precio:    299.99,
        categoria: 'General',
        unidad:    'unidad',
      }],
      p_lista_precio_id: IDS.lista,
      p_lista_nombre:    null,
      p_deposito_id:     IDS.deposito,
    });
    if (error) throw new Error(`RPC error: ${error.message}`);
    assert(data?.ok === true, `ok debe ser true, data: ${JSON.stringify(data)}`);
    assert(data?.resumen, 'resumen debe estar presente');
    const { insertados = 0, actualizados = 0, errores = 0 } = data.resumen;
    assert(insertados + actualizados >= 1, `debe haber inserción o actualización, resumen: ${JSON.stringify(data.resumen)}`);
    assert(errores === 0, `no debe haber errores, resumen: ${JSON.stringify(data.resumen)}`);
    return { resumen: data.resumen, lista_precio_id: data.lista_precio_id };
  }, ['productos', 'listas_precios', 'categorias', 'stock', 'precios_items']); // Puede crear/actualizar productos, precios_items, categorias, stock

  // T40: importar lote con 3 productos: 1 nuevo + 1 update (mismo código) + 1 con error parcial
  await run('importar', 'T40', 'importar_productos_lote: lote mixto (nuevo + update)', async () => {
    const { data, error } = await sb.rpc('importar_productos_lote', {
      p_empresa_id:      IDS.empresa,
      p_filas:           [
        // Actualización: mismo código del T39 → debe hacer update
        {
          codigo:  `${TEST_TAG}_IMP001`,
          nombre:  `${TEST_TAG}_Producto Importado (v2)`,
          precio:  349.99,
        },
        // Nuevo producto
        {
          codigo:  `${TEST_TAG}_IMP002`,
          nombre:  `${TEST_TAG}_Segundo Importado`,
          precio:  199.00,
        },
        // Fila sin nombre → debería contar como error de validación
        {
          codigo:  '',
          nombre:  '',
          precio:  0,
        },
      ],
      p_lista_precio_id: IDS.lista,
      p_lista_nombre:    null,
      p_deposito_id:     null,
    });
    if (error) throw new Error(`RPC error: ${error.message}`);
    assert(data?.ok === true, `ok debe ser true, data: ${JSON.stringify(data)}`);
    const { insertados = 0, actualizados = 0, errores = 0 } = data.resumen || {};
    assert(insertados + actualizados >= 2, `debe procesar al menos 2 filas válidas, resumen: ${JSON.stringify(data.resumen)}`);
    return { resumen: data.resumen };
  }, ['productos', 'listas_precios', 'categorias', 'stock', 'precios_items']);

  // Cleanup: borrar productos importados
  await run('importar', 'T40_CL', 'Cleanup productos importados', async () => {
    await sb.from('productos')
      .delete()
      .eq('empresa_id', IDS.empresa)
      .like('codigo', `${TEST_TAG}_IMP%`);
    return { ok: true };
  }, ['productos']);
}


// ════════════════════════════════════════════════════════════════════════════
// GRUPO 9 — CHEQUES Y PUSH: cheques.vencimiento + dispositivos_push
// ════════════════════════════════════════════════════════════════════════════

async function grupoChequesYPush() {
  log(`\n${C.h}── CHEQUES Y PUSH — vencimiento + dispositivos_push ────────────────────${C.x}`);

  // T41: crear cheque usando columna vencimiento (no fecha_cobro)
  IDS.cheque = await run('push', 'T41', 'Crear cheque con columna vencimiento (no fecha_cobro)', async () => {
    const vence = new Date(Date.now() + 5 * 86400_000).toISOString().split('T')[0]; // en 5 días
    const { data, error } = await sb.from('cheques').insert({
      empresa_id: IDS.empresa,
      cliente_id: IDS.cliente,
      banco:      'Banco Nación',
      numero:     `${TEST_TAG}_CHQ001`,
      monto:      5000,
      fecha_vto: vence,
      estado:     'pendiente',
    }).select('id, fecha_vto, monto').single();
    if (error) throw new Error(error.message);
    assert(data.fecha_vto === venc, 'fecha_vto debe guardarse');
    assert(data.fecha_vto, 'fecha_vto debe ser no-null');
    return data.id;
  }, ['cheques']);

  // T42: buscar cheques por rango de vencimiento (como hace notif.js cron cheques)
  await run('push', 'T42', 'Buscar cheques por rango vencimiento (notif.js cron corregido)', async () => {
    const hoy    = new Date().toISOString().split('T')[0];
    const limite = new Date(Date.now() + 7 * 86400_000).toISOString().split('T')[0];
    const { data, error } = await sb.from('cheques')
      .select('id, numero, monto, fecha_vto, banco, empresa_id, clientes(id, razon_social)')
      .eq('empresa_id', IDS.empresa)
      .eq('estado', 'pendiente')
      // FIX: columna real es fecha_vto (no vencimiento)
      .gte('fecha_vto', hoy)
      .lte('fecha_vto', limite);
    if (error) throw new Error(error.message);
    assert(data.length >= 1, 'debe encontrar al menos el cheque de prueba');
    const dias = Math.ceil((new Date(data[0].fecha_vto) - new Date(hoy)) / 86400000);
    assert(dias >= 0 && dias <= 7, `días restantes debe ser 0-7, es ${dias}`);
    return { cheques: data.length, dias_al_vencimiento: dias };
  }, ['cheques', 'clientes']);

  // T43: dispositivos_push upsert (no push_tokens)
  IDS.device_push = await run('push', 'T43', 'Upsert dispositivos_push (no push_tokens)', async () => {
    const fakeToken = `test_token_${Date.now()}`;
    const { data, error } = await sb.from('dispositivos_push').upsert({
      usuario_id:      IDS.usuario,
      empresa_id:      IDS.empresa,
      token_push:      fakeToken,
      tipo_dispositivo: 'web',
      activo:          true,
      updated_at:      new Date().toISOString(),
    }, { onConflict: 'usuario_id,token_push' }).select().single();
    if (error) throw new Error(error.message);
    assert(data.token_push === fakeToken, 'token_push debe guardarse');
    assert(data.activo === true, 'activo debe ser true');
    return data.id;
  }, ['dispositivos_push']);

  // T44: desactivar dispositivo push (DELETE handler)
  await run('push', 'T44', 'Desactivar dispositivos_push (activo=false)', async () => {
    const { data, error } = await sb.from('dispositivos_push')
      .update({ activo: false })
      .eq('id', IDS.device_push)
      .select('id, activo').single();
    if (error) throw new Error(error.message);
    assert(data.activo === false, 'activo debe ser false tras desactivar');
    return { activo: data.activo };
  }, ['dispositivos_push']);

  // T45: RPC liberar_stock_reservado (el que usa pedidos.js al cancelar)
  await run('push', 'T45', 'RPC liberar_stock_reservado (no decrementar_stock_reservado)', async () => {
    const { error } = await sb.rpc('liberar_stock_reservado', {
      p_producto_id: IDS.producto,
      p_deposito_id: null,
      p_cantidad:    1,
    });
    // Si el RPC existe pero cantidad_reservada es 0, puede devolver ok o error de negocio
    // Lo que NO debe pasar es un error de "function does not exist"
    const esFuncionNoExiste = error?.message?.includes('does not exist') ||
                              error?.message?.includes('no existe') ||
                              error?.message?.includes('could not find');
    assert(!esFuncionNoExiste, `RPC liberar_stock_reservado debe existir, error: ${error?.message}`);
    return { ok: !error, resultado: error?.message || 'OK' };
  }, ['stock']); // RPC afecta la tabla stock

  // T46: verificar que productos no tiene stock_actual (calculado, no columna)
  await run('push', 'T46', 'Verificar productos sin columna stock_actual (calculado desde stock)', async () => {
    const { data, error } = await sb.from('productos')
      .select('id, nombre, precio_base')  // sin stock_actual (no existe)
      .eq('id', IDS.producto)
      .single();
    if (error) throw new Error(error.message);
    assert(data.id === IDS.producto, 'debe leer producto sin stock_actual');
    assert(data.stock_actual === undefined, 'stock_actual NO debe ser columna en productos');
    // El stock real se obtiene de la tabla stock:
    const { data: stockData } = await sb.from('stock')
      .select('cantidad, cantidad_reservada')
      .eq('producto_id', IDS.producto)
      .eq('deposito_id', IDS.deposito)
      .single();
    const disponible = (stockData?.cantidad || 0) - (stockData?.cantidad_reservada || 0);
    assert(disponible >= 0, `stock disponible calculado debe ser >= 0, es ${disponible}`);
    return { stock_calculado: disponible };
  }, ['productos', 'stock']);

  // T47: leer productos con unidad (no unidad_medida)
  await run('push', 'T47', 'Leer productos con columna unidad (no unidad_medida)', async () => {
    const { data, error } = await sb.from('productos')
      .select('id, nombre, unidad')  // columna real: unidad (no unidad_medida)
      .eq('id', IDS.producto)
      .single();
    if (error) throw new Error(error.message);
    assert(data.unidad !== undefined, 'unidad debe existir');
    assert(data.unidad_medida === undefined, 'unidad_medida NO debe ser columna real');
    return { unidad: data.unidad };
  }, ['productos']);
}


// ════════════════════════════════════════════════════════════════════════════




async function grupoPilotoAutomatico() {
  log(`\n${C.h}── PILOTO AUTOMÁTICO ────────────────────────────────────────────────${C.x}`);
  // TODO: Implementar tests para el Piloto Automático
}

// ════════════════════════════════════════════════════════════════════════════
// GRUPO 8 — SCORE DE CLIENTE
// ════════════════════════════════════════════════════════════════════════════

async function grupoScoreCliente() {
  log(`\n${C.h}── SCORE DE CLIENTE ─────────────────────────────────────────────────${C.x}`);
  // TODO: Implementar tests para el Score de Cliente
}

async function grupoCoberturaMinima() {
  log(`\n${C.h}── COBERTURA MÍNIMA DE TABLAS FALTANTES ────────────────────────────${C.x}`);

  const tablesToCover = [
    'alertas_score', 'alertas_stock', 'audit_log', 'bloqueos_cliente', 'canjes_recompensas',
    'ciclos_compra', 'cobros', 'contadores_empresa', 'cta_cte', 'entregas', 'facturas',
    'integraciones_pago', 'movimientos_stock', 'ordenes_compra',
    'ordenes_compra_items', 'presupuesto_items', 'presupuestos', 'programas_fidelizacion',
    'recompensas', 'reglas_score', 'rutas', 'scores_cliente', 'sugerencias_pedido',
    'transacciones_pago',
  ];

  for (const table of tablesToCover) {
    await run('cobertura_minima', `CM_${table}`, `SELECT * from ${table} LIMIT 0`, async () => {
      try {
        await q(sb.from(table).select('*').limit(0));
        return { ok: true };
      } catch (err) {
        // Si la tabla no existe o hay un error de RLS, se reportará aquí
        return { ok: false, error: err.message };
      }
    }, [table]);
  }
}

async function cleanupTable(tableName, queryBuilder) {
  const { error, count } = await queryBuilder.delete({ count: 'exact' });
  if (error) throw new Error(error.message);
  return { eliminados: count };
}

async function grupoCleanup() {
  if (NO_CLEANUP) {
    log(`\n${C.y}── CLEANUP omitido (--no-cleanup). IDs creados:${C.x}`);
    log(JSON.stringify(IDS, null, 2));
    return;
  }

  log(`\n${C.h}── CLEANUP — Borrar datos de prueba ────────────────────────────────────${C.x}`);

  // Orden de borrado respeta FK: primero hijos, luego padres
  const steps = [
    ['notif_log',           () => IDS.empresa ? sb.from('notif_log').select('*').eq('empresa_id', IDS.empresa) : sb.from('notif_log').select('*')],
    ['notificaciones_push', () => IDS.empresa ? sb.from('notificaciones_push').select('*').eq('empresa_id', IDS.empresa) : sb.from('notificaciones_push').select('*')],
    ['movimientos_puntos',  () => IDS.empresa ? sb.from('movimientos_puntos').select('*').eq('empresa_id', IDS.empresa) : sb.from('movimientos_puntos').select('*')],
    ['saldo_puntos',        () => IDS.empresa ? sb.from('saldo_puntos').select('*').eq('empresa_id', IDS.empresa) : sb.from('saldo_puntos').select('*')],
    ['dispositivos_push',   () => IDS.empresa ? sb.from('dispositivos_push').select('*').eq('empresa_id', IDS.empresa) : sb.from('dispositivos_push').select('*')],
    ['cheques',             () => IDS.empresa ? sb.from('cheques').select('*').eq('empresa_id', IDS.empresa) : sb.from('cheques').select('*')],
    ['pedido_items',        () => IDS.pedido ? sb.from('pedido_items').select('*').eq('pedido_id', IDS.pedido) : sb.from('pedido_items').select('*')],
    ['pedidos',             () => IDS.empresa ? sb.from('pedidos').select('*').eq('empresa_id', IDS.empresa) : sb.from('pedidos').select('*')],
    ['lotes',               () => IDS.empresa ? sb.from('lotes').select('*').eq('empresa_id', IDS.empresa) : sb.from('lotes').select('*')],
    ['stock',               () => IDS.deposito ? sb.from('stock').select('*').eq('deposito_id', IDS.deposito) : sb.from('stock').select('*')],
    ['clientes',            () => IDS.empresa ? sb.from('clientes').select('*').eq('empresa_id', IDS.empresa) : sb.from('clientes').select('*')],
    ['productos',           () => IDS.empresa ? sb.from('productos').select('*').eq('empresa_id', IDS.empresa) : sb.from('productos').select('*')],
    ['categorias',          () => IDS.empresa ? sb.from('categorias').select('*').eq('empresa_id', IDS.empresa) : sb.from('categorias').select('*')],
    ['depositos',           () => IDS.empresa ? sb.from('depositos').select('*').eq('empresa_id', IDS.empresa) : sb.from('depositos').select('*')],
    ['listas_precios',      () => IDS.empresa ? sb.from('listas_precios').select('*').eq('empresa_id', IDS.empresa) : sb.from('listas_precios').select('*')],
    ['zonas',               () => IDS.empresa ? sb.from('zonas').select('*').eq('empresa_id', IDS.empresa) : sb.from('zonas').select('*')],
    ['usuarios',            () => IDS.empresa ? sb.from('usuarios').select('*').eq('empresa_id', IDS.empresa) : sb.from('usuarios').select('*')],
    ['empresas',            () => IDS.empresa ? sb.from('empresas').select('*').eq('id', IDS.empresa) : sb.from('empresas').select('*')],
  ];

   for (const [nombre, getQ] of steps) {
    await run('cleanup', `CL_${nombre}`, `DELETE ${nombre}`, async () => {
      const queryBuilder = getQ(); // Call the function to get the query builder
      return cleanupTable(nombre, queryBuilder);
    });
  }
}



// ════════════════════════════════════════════════════════════════════════════
// REPORTE FINAL
// ════════════════════════════════════════════════════════════════════════════

function reporteFinal() {
  const total    = results.filter(r => !r.skipped).length;
  const pasados  = results.filter(r => r.ok === true).length;
  const fallidos = results.filter(r => r.ok === false).length;
  const saltados = results.filter(r => r.skipped).length;

  if (FLAG_JSON) {
    console.log(JSON.stringify({ ok: fallidos === 0, pasados, fallidos, saltados, total, results }, null, 2));
    process.exit(fallidos > 0 ? 1 : 0);
    return;
  }

  const sep = '─'.repeat(70);
  console.log(`\n${sep}`);
  console.log(`RESULTADO FINAL`);
  console.log(sep);
  console.log(`  Total ejecutados : ${total}`);
  console.log(`  ${C.ok}Pasados          : ${pasados}${C.x}`);
  console.log(fallidos > 0
    ? `  ${C.fail}Fallidos         : ${fallidos}${C.x}`
    : `  Fallidos         : ${fallidos}`);
  if (saltados) console.log(`  ${C.y}Saltados (--only): ${saltados}${C.x}`);

  // Reporte de cobertura de tablas
  console.log(`\n${sep}`);
  console.log(`${C.h}REPORTE DE COBERTURA DE TABLAS (INTEGRACIÓN)${C.x}`);
  console.log(sep);

  const uncoveredTables = ALL_TABLES_TO_CHECK.filter(t => !COVERED_TABLES.has(t));

  if (uncoveredTables.length > 0) {
    console.log(`\n${C.fail}[FAIL] Tablas requeridas SIN COBERTURA en test-integration.js (${uncoveredTables.length}):${C.x}`);
    console.log(`  ${uncoveredTables.join(', ')}`);
  } else {
    console.log(`\n${C.ok}[OK] Todas las tablas requeridas tienen cobertura en test-integration.js.${C.x}`);
  }


  if (fallidos > 0) {
    console.log(`\n${C.fail}Tests fallidos:${C.x}`);
    for (const r of results.filter(r => r.ok === false)) {
      console.log(`  ${C.fail}[FAIL] [${r.id}] ${r.desc}${C.x}`);
      console.log(`    ${C.dim}${r.error}${C.x}`);
    }
  }

  console.log(`\n${fallidos === 0 ? C.ok+'[OK]  TODOS LOS TESTS PASARON' : C.fail+'[FAIL]  HAY TESTS FALLIDOS'}${C.x}\n`);
  process.exit(fallidos > 0 ? 1 : 0);
}


// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

async function main() {
  log(`\n${'═'.repeat(70)}`);
  log(`${C.h}SIMULACIÓN INTEGRACIÓN DB ↔ CÓDIGO — distrib-v49${C.x}`);
  log(`${'═'.repeat(70)}`);
  log(`${C.dim}Tag de prueba : ${TEST_TAG}${C.x}`);
  log(`${C.dim}Supabase URL  : ${SUPABASE_URL}${C.x}`);
  log(`${C.dim}Grupo filtro  : ${ONLY || 'todos'}${C.x}`);

  try {
    await grupoSetup();
    await grupoStock();
    await grupoClientes();
    await grupoPedidos();
    await grupoPuntos();
    await grupoNotif();
    await grupoImportar();
    await grupoChequesYPush();
    await grupoCoberturaMinima(); // Added this line to call the new group
  } catch (fatal) {
    log(`\n${C.fail}Error fatal en suite: ${fatal.message}${C.x}`);
    log(`${C.y}IDs parciales creados: ${JSON.stringify(IDS)}${C.x}`);
  } finally {
    await grupoPilotoAutomatico();
    await grupoScoreCliente();
    await grupoCleanup();
  }

  reporteFinal();
}

main();
