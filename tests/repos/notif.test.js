// tests/repos/notif.test.js
//
// Fase 7, paso 7 — `lib/repos/notif.js` no tenía tests de repo todavía
// (checklist punto 5). Cubre las funciones agregadas en los lotes 1, 2 y 3 —
// las que ya existían antes de la migración (`ultimoEnvio`, `listarLogs`,
// `listarDispositivos`, `registrarLog`, `registrarLogs`, `registrarEmail`)
// quedan sin tests nuevos en este paso, mismo criterio que un lote no
// reabre lo que no toca.
//
// Mismo query builder falso que tests/repos/stock.test.js/productos.test.js.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  ultimoEnvioPorTipo, ultimoEnvioPorCliente,
  listarAdminsDueno,
  listarChequesPorIds, listarChequesPorVencer,
  listarClientesActivosConCtaCte,
  actualizarNecesitaReconexionWhatsapp,
  obtenerPerfilEstadoCuenta,
  obtenerClienteEstadoCuenta, obtenerClienteEstadoCuentaPorId,
  listarFacturasPendientes,
  registrarLogConAviso,
  obtenerNotifLogPorId,
  obtenerEmpresaParaEmail,
  obtenerClienteParaReintento,
  obtenerPedidoConItemsParaReintento, obtenerPedidoDespachoParaReintento,
  obtenerRecepcionParaReintento, obtenerOrdenCompraConProveedor,
  obtenerRutaDeEmpresa, listarEntregasDeRuta, marcarRutaEnCamino,
  obtenerPedidoParaNotifEntrega, marcarPedidoEntregado,
  listarUsuariosPorRoles, obtenerUsuarioDeEmpresa,
  upsertDispositivoPush, desactivarDispositivoPush,
  obtenerPrefsAuto, listarTokensPushDeUsuarios, desactivarDispositivoPushPorEndpoint,
  obtenerTokensPushDeUsuario, obtenerEmpresaIdDeUsuario,
  listarClientesActivosDeEmpresa, obtenerUsuarioPorClienteId,
} = await import('../../lib/repos/notif.js');

function fakeQuery(result) {
  const obj = {
    select:      vi.fn(() => obj),
    insert:      vi.fn(() => obj),
    update:      vi.fn(() => obj),
    upsert:      vi.fn(() => obj),
    delete:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    in:          vi.fn(() => obj),
    gte:         vi.fn(() => obj),
    lte:         vi.fn(() => obj),
    limit:       vi.fn(() => obj),
    order:       vi.fn(() => obj),
    single:      vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then:        (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
});

// ── ultimoEnvioPorTipo ───────────────────────────────────────────────────

describe('ultimoEnvioPorTipo', () => {
  it('sin empresa_id, consulta global por tipo (caso: alerta del número compartido)', async () => {
    const query = fakeQuery({ data: { created_at: '2026-08-01T00:00:00Z' }, error: null });
    dbMock.from.mockReturnValue(query);

    const fecha = await ultimoEnvioPorTipo('wa_token_vencido');

    expect(dbMock.from).toHaveBeenCalledWith('notif_log');
    expect(query.eq).toHaveBeenCalledWith('tipo', 'wa_token_vencido');
    // No debe filtrar por empresa_id cuando no se pasa
    expect(query.eq).not.toHaveBeenCalledWith('empresa_id', expect.anything());
    expect(fecha).toBe('2026-08-01T00:00:00Z');
  });

  it('con empresa_id, filtra también por empresa (caso: número propio de una empresa)', async () => {
    const query = fakeQuery({ data: { created_at: '2026-08-01T00:00:00Z' }, error: null });
    dbMock.from.mockReturnValue(query);

    await ultimoEnvioPorTipo('cheques_por_vencer', { empresa_id: 'e1' });

    expect(query.eq).toHaveBeenCalledWith('tipo', 'cheques_por_vencer');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
  });

  it('devuelve null (no lanza) si no hay envío previo', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    expect(await ultimoEnvioPorTipo('cheques_por_vencer', { empresa_id: 'e1' })).toBeNull();
  });
});

// ── ultimoEnvioPorCliente ────────────────────────────────────────────────

describe('ultimoEnvioPorCliente', () => {
  it('filtra por cliente_id y tipo, sin empresa_id (handleDeudaCron)', async () => {
    const query = fakeQuery({ data: { created_at: '2026-07-30T00:00:00Z' }, error: null });
    dbMock.from.mockReturnValue(query);

    const fecha = await ultimoEnvioPorCliente('c1', 'deuda_vencida');

    expect(query.eq).toHaveBeenCalledWith('cliente_id', 'c1');
    expect(query.eq).toHaveBeenCalledWith('tipo', 'deuda_vencida');
    expect(fecha).toBe('2026-07-30T00:00:00Z');
  });

  it('devuelve null (no lanza) si no hay envío previo', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    expect(await ultimoEnvioPorCliente('c1', 'deuda_vencida')).toBeNull();
  });
});

// ── listarAdminsDueno ────────────────────────────────────────────────────

describe('listarAdminsDueno', () => {
  it('sin empresa_id, trae admins/dueños de todas las empresas con los campos default', async () => {
    const query = fakeQuery({ data: [{ id: 'u1', empresa_id: 'e1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const admins = await listarAdminsDueno(null);

    expect(query.select).toHaveBeenCalledWith('id, empresa_id');
    expect(query.in).toHaveBeenCalledWith('rol', ['dueno', 'admin']);
    expect(query.eq).not.toHaveBeenCalledWith('empresa_id', expect.anything());
    expect(admins).toEqual([{ id: 'u1', empresa_id: 'e1' }]);
  });

  it('con empresa_id y campos custom, filtra y pide las columnas pedidas', async () => {
    const query = fakeQuery({ data: [{ id: 'u1', nombre: 'Ana', email: 'a@x.com', telefono: '123' }], error: null });
    dbMock.from.mockReturnValue(query);

    await listarAdminsDueno('e1', { campos: 'id, nombre, email, telefono' });

    expect(query.select).toHaveBeenCalledWith('id, nombre, email, telefono');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
  });

  it('devuelve [] (no lanza) si la query falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    expect(await listarAdminsDueno('e1')).toEqual([]);
  });
});

// ── listarChequesPorIds ──────────────────────────────────────────────────

describe('listarChequesPorIds', () => {
  it('filtra por lote de ids y devuelve { data, error } tal cual', async () => {
    const query = fakeQuery({ data: [{ id: 'ch1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const res = await listarChequesPorIds(['ch1']);

    expect(dbMock.from).toHaveBeenCalledWith('cheques');
    expect(query.in).toHaveBeenCalledWith('id', ['ch1']);
    expect(res).toEqual({ data: [{ id: 'ch1' }], error: null });
  });

  it('propaga el error sin lanzar (el handler arma su propio mensaje)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    const res = await listarChequesPorIds(['ch1']);
    expect(res.error).toEqual({ message: 'boom' });
  });
});

// ── listarChequesPorVencer ───────────────────────────────────────────────

describe('listarChequesPorVencer', () => {
  it('filtra por estado pendiente y rango de vencimiento', async () => {
    const query = fakeQuery({ data: [{ id: 'ch1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const cheques = await listarChequesPorVencer('2026-08-02', '2026-08-05');

    expect(query.eq).toHaveBeenCalledWith('estado', 'pendiente');
    expect(query.gte).toHaveBeenCalledWith('vencimiento', '2026-08-02');
    expect(query.lte).toHaveBeenCalledWith('vencimiento', '2026-08-05');
    expect(cheques).toEqual([{ id: 'ch1' }]);
  });

  it('propaga error (el handler lo maneja con su propio try/catch)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    await expect(listarChequesPorVencer('2026-08-02', '2026-08-05')).rejects.toEqual({ message: 'boom' });
  });
});

// ── listarClientesActivosConCtaCte ───────────────────────────────────────

describe('listarClientesActivosConCtaCte', () => {
  it('filtra por activo=true y trae la cta_cte embebida', async () => {
    const query = fakeQuery({ data: [{ id: 'c1', cta_cte: [] }], error: null });
    dbMock.from.mockReturnValue(query);

    const clientes = await listarClientesActivosConCtaCte();

    expect(dbMock.from).toHaveBeenCalledWith('clientes');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(clientes).toEqual([{ id: 'c1', cta_cte: [] }]);
  });

  it('propaga error (el handler lo relanza dentro de su try/catch)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    await expect(listarClientesActivosConCtaCte()).rejects.toEqual({ message: 'boom' });
  });
});

// ── actualizarNecesitaReconexionWhatsapp ─────────────────────────────────

describe('actualizarNecesitaReconexionWhatsapp', () => {
  it('actualiza necesita_reconexion filtrando por empresa_id', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await actualizarNecesitaReconexionWhatsapp('e1', true);

    expect(dbMock.from).toHaveBeenCalledWith('empresa_whatsapp');
    expect(query.update).toHaveBeenCalledWith({ necesita_reconexion: true });
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
  });

  it('no lanza si la escritura falla (best-effort, igual que el original)', async () => {
    dbMock.from.mockImplementation(() => { throw new Error('conexión perdida'); });
    await expect(actualizarNecesitaReconexionWhatsapp('e1', true)).resolves.toBeUndefined();
  });
});

// ── Lote 2 — obtenerPerfilEstadoCuenta ───────────────────────────────────

describe('obtenerPerfilEstadoCuenta', () => {
  it('filtra por id y activo=true (Hallazgo: el original no filtraba activo)', async () => {
    const query = fakeQuery({ data: { id: 'u1', rol: 'admin', empresa_id: 'e1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerPerfilEstadoCuenta('u1');

    expect(dbMock.from).toHaveBeenCalledWith('usuarios');
    expect(query.eq).toHaveBeenCalledWith('id', 'u1');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(data.rol).toBe('admin');
  });

  it('devuelve { data: null, error } si el usuario está inactivo o no existe', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'no rows' } }));
    const { data, error } = await obtenerPerfilEstadoCuenta('u-inactivo');
    expect(data).toBeNull();
    expect(error).toBeTruthy();
  });
});

// ── obtenerClienteEstadoCuenta / obtenerClienteEstadoCuentaPorId ─────────

describe('obtenerClienteEstadoCuenta', () => {
  it('filtra por id Y empresa_id', async () => {
    const query = fakeQuery({ data: { id: 'c1', razon_social: 'Acme' }, error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerClienteEstadoCuenta('c1', 'e1');

    expect(query.eq).toHaveBeenCalledWith('id', 'c1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
  });
});

describe('obtenerClienteEstadoCuentaPorId', () => {
  it('filtra solo por id, sin empresa_id (cliente_id ya viene de un notif_log validado)', async () => {
    const query = fakeQuery({ data: { razon_social: 'Acme' }, error: null });
    dbMock.from.mockReturnValue(query);

    const cliente = await obtenerClienteEstadoCuentaPorId('c1');

    expect(query.eq).toHaveBeenCalledWith('id', 'c1');
    expect(query.eq).not.toHaveBeenCalledWith('empresa_id', expect.anything());
    expect(cliente.razon_social).toBe('Acme');
  });
});

// ── listarFacturasPendientes ──────────────────────────────────────────────

describe('listarFacturasPendientes', () => {
  it('filtra por empresa_id, cliente_id y estado emitida/parcial', async () => {
    const query = fakeQuery({ data: [{ id: 'f1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const facturas = await listarFacturasPendientes('e1', 'c1');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.eq).toHaveBeenCalledWith('cliente_id', 'c1');
    expect(query.in).toHaveBeenCalledWith('estado', ['emitida', 'parcial']);
    expect(query.limit).toHaveBeenCalledWith(20);
    expect(facturas).toEqual([{ id: 'f1' }]);
  });

  it('devuelve undefined (no lanza) si la query falla — mismo comportamiento silencioso que el original', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: undefined, error: { message: 'boom' } }));
    expect(await listarFacturasPendientes('e1', 'c1')).toBeUndefined();
  });
});

// ── registrarLogConAviso ──────────────────────────────────────────────────

describe('registrarLogConAviso', () => {
  it('inserta el log sin loguear nada si no hay error', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await registrarLogConAviso({ tipo: 'estado_cuenta' }, 'ESTADO-CUENTA');

    expect(query.insert).toHaveBeenCalledWith({ tipo: 'estado_cuenta' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('avisa por consola con el prefijo de contexto si la escritura falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'boom' } }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await registrarLogConAviso({ tipo: 'estado_cuenta' }, 'ESTADO-CUENTA');

    expect(spy).toHaveBeenCalledWith('[ESTADO-CUENTA] No se pudo loguear envío en notif_log:', 'boom');
    spy.mockRestore();
  });
});

// ── obtenerNotifLogPorId ──────────────────────────────────────────────────

describe('obtenerNotifLogPorId', () => {
  it('filtra por id Y empresa_id, devuelve { data, error }', async () => {
    const query = fakeQuery({ data: { id: 'n1', canal: 'email' }, error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerNotifLogPorId('n1', 'e1');

    expect(query.eq).toHaveBeenCalledWith('id', 'n1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(data.canal).toBe('email');
  });
});

// ── obtenerEmpresaParaEmail (reusada por los 4 helpers _reintentar*) ─────

describe('obtenerEmpresaParaEmail', () => {
  it('filtra por id y trae nombre/email', async () => {
    const query = fakeQuery({ data: { id: 'e1', nombre: 'Distrib SA', email: 'a@x.com' }, error: null });
    dbMock.from.mockReturnValue(query);

    const empresa = await obtenerEmpresaParaEmail('e1');

    expect(dbMock.from).toHaveBeenCalledWith('empresas');
    expect(query.eq).toHaveBeenCalledWith('id', 'e1');
    expect(empresa.nombre).toBe('Distrib SA');
  });
});

// ── obtenerClienteParaReintento ───────────────────────────────────────────

describe('obtenerClienteParaReintento', () => {
  it('pide los campos indicados por el caller (shape distinto en confirmación vs. despacho)', async () => {
    const query = fakeQuery({ data: { email: 'a@x.com', razon_social: 'Acme' }, error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerClienteParaReintento('c1', 'email, razon_social');

    expect(query.select).toHaveBeenCalledWith('email, razon_social');
    expect(query.eq).toHaveBeenCalledWith('id', 'c1');
  });
});

// ── obtenerPedidoConItemsParaReintento / obtenerPedidoDespachoParaReintento ─

describe('obtenerPedidoConItemsParaReintento', () => {
  it('trae el pedido con pedido_items/productos embebidos', async () => {
    const query = fakeQuery({ data: { id: 'p1', pedido_items: [] }, error: null });
    dbMock.from.mockReturnValue(query);

    const pedido = await obtenerPedidoConItemsParaReintento('p1');

    expect(dbMock.from).toHaveBeenCalledWith('pedidos');
    expect(pedido.id).toBe('p1');
  });
});

describe('obtenerPedidoDespachoParaReintento', () => {
  it('trae solo id/total/fecha_entrega (shape más chico que el de confirmación)', async () => {
    const query = fakeQuery({ data: { id: 'p1', total: 100, fecha_entrega: '2026-08-05' }, error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerPedidoDespachoParaReintento('p1');

    expect(query.select).toHaveBeenCalledWith('id, total, fecha_entrega');
  });
});

// ── obtenerRecepcionParaReintento / obtenerOrdenCompraConProveedor ───────

describe('obtenerRecepcionParaReintento', () => {
  it('filtra por id Y empresa_id', async () => {
    const query = fakeQuery({ data: { id: 'r1', orden_id: 'o1' }, error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerRecepcionParaReintento('r1', 'e1');

    expect(query.eq).toHaveBeenCalledWith('id', 'r1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
  });
});

describe('obtenerOrdenCompraConProveedor', () => {
  it('filtra por id Y empresa_id, trae el proveedor embebido', async () => {
    const query = fakeQuery({ data: { id: 'o1', proveedores: { email: 'prov@x.com' } }, error: null });
    dbMock.from.mockReturnValue(query);

    const orden = await obtenerOrdenCompraConProveedor('o1', 'e1');

    expect(query.eq).toHaveBeenCalledWith('id', 'o1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(orden.proveedores.email).toBe('prov@x.com');
  });
});

// ── Lote 3 — obtenerRutaDeEmpresa (reusada por manejarDespacho y pushChoferHandler) ─

describe('obtenerRutaDeEmpresa', () => {
  it('filtra por id Y empresa_id', async () => {
    const query = fakeQuery({ data: { id: 'r1', empresa_id: 'e1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const ruta = await obtenerRutaDeEmpresa('r1', 'e1');

    expect(dbMock.from).toHaveBeenCalledWith('rutas');
    expect(query.eq).toHaveBeenCalledWith('id', 'r1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(ruta.id).toBe('r1');
  });

  it('devuelve null si la ruta no existe o no pertenece a la empresa', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'not found' } }));
    expect(await obtenerRutaDeEmpresa('rX', 'e1')).toBeNull();
  });
});

// ── listarEntregasDeRuta ──────────────────────────────────────────────────

describe('listarEntregasDeRuta', () => {
  it('filtra por ruta_id, devuelve { data, error } tal cual', async () => {
    const query = fakeQuery({ data: [{ pedido_id: 'p1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const { data, error } = await listarEntregasDeRuta('r1');

    expect(dbMock.from).toHaveBeenCalledWith('entregas');
    expect(query.eq).toHaveBeenCalledWith('ruta_id', 'r1');
    expect(data).toEqual([{ pedido_id: 'p1' }]);
    expect(error).toBeNull();
  });

  it('propaga el error sin lanzar (el handler decide si relanza)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    const { error } = await listarEntregasDeRuta('r1');
    expect(error).toEqual({ message: 'boom' });
  });
});

// ── marcarRutaEnCamino ────────────────────────────────────────────────────

describe('marcarRutaEnCamino', () => {
  it('actualiza estado a en_camino filtrando por id', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await marcarRutaEnCamino('r1');

    expect(dbMock.from).toHaveBeenCalledWith('rutas');
    expect(query.update).toHaveBeenCalledWith({ estado: 'en_camino' });
    expect(query.eq).toHaveBeenCalledWith('id', 'r1');
  });
});

// ── obtenerPedidoParaNotifEntrega (reusada por los 3 sub-eventos de entregaHandler) ─

describe('obtenerPedidoParaNotifEntrega', () => {
  it('filtra por id Y empresa_id, trae el cliente embebido', async () => {
    const query = fakeQuery({ data: { id: 'p1', clientes: { telefono: '123' } }, error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerPedidoParaNotifEntrega('p1', 'e1');

    expect(dbMock.from).toHaveBeenCalledWith('pedidos');
    expect(query.eq).toHaveBeenCalledWith('id', 'p1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(data.id).toBe('p1');
  });
});

// ── marcarPedidoEntregado ─────────────────────────────────────────────────

describe('marcarPedidoEntregado', () => {
  it('actualiza estado a entregado filtrando por id', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await marcarPedidoEntregado('p1');

    expect(dbMock.from).toHaveBeenCalledWith('pedidos');
    expect(query.update).toHaveBeenCalledWith({ estado: 'entregado' });
    expect(query.eq).toHaveBeenCalledWith('id', 'p1');
  });
});

// ── listarUsuariosPorRoles ────────────────────────────────────────────────

describe('listarUsuariosPorRoles', () => {
  it('filtra por empresa_id y la lista de roles pedida', async () => {
    const query = fakeQuery({ data: [{ id: 'u1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await listarUsuariosPorRoles('e1', ['dueno', 'admin', 'depositero']);

    expect(dbMock.from).toHaveBeenCalledWith('usuarios');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.in).toHaveBeenCalledWith('rol', ['dueno', 'admin', 'depositero']);
    expect(data).toEqual([{ id: 'u1' }]);
  });
});

// ── obtenerUsuarioDeEmpresa ───────────────────────────────────────────────

describe('obtenerUsuarioDeEmpresa', () => {
  it('filtra por id Y empresa_id (chequeo de pertenencia del chofer)', async () => {
    const query = fakeQuery({ data: { id: 'u1', empresa_id: 'e1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const usuario = await obtenerUsuarioDeEmpresa('u1', 'e1');

    expect(dbMock.from).toHaveBeenCalledWith('usuarios');
    expect(query.eq).toHaveBeenCalledWith('id', 'u1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(usuario.id).toBe('u1');
  });
});

// ── upsertDispositivoPush / desactivarDispositivoPush ────────────────────

describe('upsertDispositivoPush', () => {
  it('hace upsert por token_push con los datos recibidos', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);
    const datos = { usuario_id: 'u1', empresa_id: 'e1', token_push: 't1', tipo_dispositivo: 'web', activo: true };

    const { error } = await upsertDispositivoPush(datos);

    expect(dbMock.from).toHaveBeenCalledWith('dispositivos_push');
    expect(query.upsert).toHaveBeenCalledWith(datos, { onConflict: 'token_push' });
    expect(error).toBeNull();
  });
});

describe('desactivarDispositivoPush', () => {
  it('filtra por token_push Y usuario_id (FIX auditoría: no alcanza con solo el token)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await desactivarDispositivoPush('t1', 'u1');

    expect(dbMock.from).toHaveBeenCalledWith('dispositivos_push');
    expect(query.update).toHaveBeenCalledWith({ activo: false });
    expect(query.eq).toHaveBeenCalledWith('token_push', 't1');
    expect(query.eq).toHaveBeenCalledWith('usuario_id', 'u1');
  });
});

// ── Lote 5 (v595) — migración de notifAuto (_auto-push.js) ─────────────

describe('obtenerPrefsAuto', () => {
  it('selecciona dinámicamente la columna del tipo pedido', async () => {
    const query = fakeQuery({ data: { stock_quiebre: false }, error: null });
    dbMock.from.mockReturnValue(query);

    const pref = await obtenerPrefsAuto('e1', 'stock_quiebre');

    expect(dbMock.from).toHaveBeenCalledWith('notif_prefs_auto');
    expect(query.select).toHaveBeenCalledWith('stock_quiebre');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(pref).toEqual({ stock_quiebre: false });
  });

  it('devuelve null si la empresa no tiene fila de preferencias (default: todo habilitado)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));

    const pref = await obtenerPrefsAuto('e1', 'piloto');

    expect(pref).toBeNull();
  });
});

describe('listarTokensPushDeUsuarios', () => {
  it('trae tokens activos de un batch de usuarios, tope 30', async () => {
    const tokens = [{ endpoint: 'ep1', p256dh: 'a', auth: 'b' }];
    const query = fakeQuery({ data: tokens, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await listarTokensPushDeUsuarios(['u1', 'u2']);

    expect(dbMock.from).toHaveBeenCalledWith('dispositivos_push');
    expect(query.in).toHaveBeenCalledWith('usuario_id', ['u1', 'u2']);
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(query.limit).toHaveBeenCalledWith(30);
    expect(data).toEqual(tokens);
  });

  it('devuelve array vacío (no null) si no hay tokens', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));

    const data = await listarTokensPushDeUsuarios(['u1']);

    expect(data).toEqual([]);
  });
});

describe('desactivarDispositivoPushPorEndpoint', () => {
  it('da de baja por endpoint (no se conoce el usuario en este flujo)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await desactivarDispositivoPushPorEndpoint('ep-vencido');

    expect(dbMock.from).toHaveBeenCalledWith('dispositivos_push');
    expect(query.update).toHaveBeenCalledWith({ activo: false });
    expect(query.eq).toHaveBeenCalledWith('endpoint', 'ep-vencido');
  });
});

// ── Lote 6 (v596) — migración de enviarPush y notificadores (_push.js) ──

describe('obtenerTokensPushDeUsuario', () => {
  it('trae tokens activos de un usuario, propaga { data, error } tal cual', async () => {
    const query = fakeQuery({ data: [{ token_push: 't1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const { data, error } = await obtenerTokensPushDeUsuario('u1');

    expect(dbMock.from).toHaveBeenCalledWith('dispositivos_push');
    expect(query.eq).toHaveBeenCalledWith('usuario_id', 'u1');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(data).toEqual([{ token_push: 't1' }]);
    expect(error).toBeNull();
  });
});

describe('obtenerEmpresaIdDeUsuario', () => {
  it('devuelve el empresa_id del usuario', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: { empresa_id: 'e1' }, error: null }));

    const empresaId = await obtenerEmpresaIdDeUsuario('u1');

    expect(dbMock.from).toHaveBeenCalledWith('usuarios');
    expect(empresaId).toBe('e1');
  });

  it('devuelve null (no lanza) si el usuario no existe', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'no rows' } }));

    const empresaId = await obtenerEmpresaIdDeUsuario('u-inexistente');

    expect(empresaId).toBeNull();
  });
});

describe('listarClientesActivosDeEmpresa', () => {
  it('filtra usuarios de portal por empresa, rol cliente y activo (no debe mandarle push a dueño/admin/etc)', async () => {
    const query = fakeQuery({ data: [{ id: 'u1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await listarClientesActivosDeEmpresa('e1');

    expect(dbMock.from).toHaveBeenCalledWith('usuarios');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.eq).toHaveBeenCalledWith('rol', 'cliente');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(data).toEqual([{ id: 'u1' }]);
  });
});

describe('obtenerUsuarioPorClienteId', () => {
  it('resuelve el usuario de portal a partir del cliente_id', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: { id: 'u1', empresa_id: 'e1' }, error: null }));

    const usuario = await obtenerUsuarioPorClienteId('c1');

    expect(dbMock.from).toHaveBeenCalledWith('usuarios');
    expect(usuario).toEqual({ id: 'u1', empresa_id: 'e1' });
  });

  it('devuelve null si el cliente no tiene usuario de portal asociado', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'no rows' } }));

    const usuario = await obtenerUsuarioPorClienteId('c-sin-portal');

    expect(usuario).toBeNull();
  });
});
