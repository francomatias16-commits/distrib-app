// tests/permisos-service.test.js
//
// Fase 7, sección 2 — piloto del PermisosService (reglas_automatizacion +
// tareas_automatizacion, migrados desde los ROLES_* sueltos de
// reglas-automatizacion.js). Foco: que la tabla de reglas devuelva
// exactamente lo mismo que los arrays ROLES_LECTURA/ROLES_ESCRITURA/
// ROLES_TAREAS originales, y que un recurso/acción mal escritos revienten
// en vez de devolver "sin permiso" en silencio (fail-closed sobre errores
// de programación, no solo sobre roles).

import { describe, it, expect } from 'vitest';
import { puede, rolesDe } from '../lib/permisos-service.js';

describe('puede — reglas_automatizacion', () => {
  it.each(['dueno', 'admin'])('%s puede leer reglas_automatizacion', (rol) => {
    expect(puede({ rol }, 'leer', 'reglas_automatizacion')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'contador', 'chofer'])(
    '%s NO puede leer reglas_automatizacion',
    (rol) => {
      expect(puede({ rol }, 'leer', 'reglas_automatizacion')).toBe(false);
    }
  );

  it.each(['dueno', 'admin'])('%s puede escribir reglas_automatizacion', (rol) => {
    expect(puede({ rol }, 'escribir', 'reglas_automatizacion')).toBe(true);
  });

  it('vendedor no puede escribir reglas_automatizacion', () => {
    expect(puede({ rol: 'vendedor' }, 'escribir', 'reglas_automatizacion')).toBe(false);
  });
});

describe('puede — tareas_automatizacion', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'contador'])(
    '%s puede leer tareas_automatizacion',
    (rol) => {
      expect(puede({ rol }, 'leer', 'tareas_automatizacion')).toBe(true);
    }
  );

  it('chofer no puede leer tareas_automatizacion (portal propio, no rol interno de empresa)', () => {
    expect(puede({ rol: 'chofer' }, 'leer', 'tareas_automatizacion')).toBe(false);
  });

  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'contador'])(
    '%s puede completar tareas_automatizacion (mismo set que leer — un único ROLES_TAREAS original)',
    (rol) => {
      expect(puede({ rol }, 'completar', 'tareas_automatizacion')).toBe(true);
    }
  );
});

describe('puede — export_contable', () => {
  it.each(['dueno', 'admin', 'contador'])('%s puede acceder a export_contable', (rol) => {
    expect(puede({ rol }, 'acceder', 'export_contable')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'chofer'])('%s NO puede acceder a export_contable', (rol) => {
    expect(puede({ rol }, 'acceder', 'export_contable')).toBe(false);
  });

  it.each(['dueno', 'admin'])('%s puede configurar export_contable', (rol) => {
    expect(puede({ rol }, 'configurar', 'export_contable')).toBe(true);
  });

  it('contador puede acceder pero NO configurar (gate más restrictivo)', () => {
    expect(puede({ rol: 'contador' }, 'acceder', 'export_contable')).toBe(true);
    expect(puede({ rol: 'contador' }, 'configurar', 'export_contable')).toBe(false);
  });
});

describe('puede — importar', () => {
  it.each(['dueno', 'admin'])('%s puede cargar importaciones', (rol) => {
    expect(puede({ rol }, 'cargar', 'importar')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'contador', 'chofer'])('%s NO puede cargar importaciones', (rol) => {
    expect(puede({ rol }, 'cargar', 'importar')).toBe(false);
  });
});

describe('puede — bcra', () => {
  it.each(['dueno', 'admin', 'contador'])('%s puede consultar BCRA', (rol) => {
    expect(puede({ rol }, 'consultar', 'bcra')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'chofer'])('%s NO puede consultar BCRA', (rol) => {
    expect(puede({ rol }, 'consultar', 'bcra')).toBe(false);
  });
});

describe('puede — busqueda', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'contador'])(
    '%s puede buscar',
    (rol) => {
      expect(puede({ rol }, 'buscar', 'busqueda')).toBe(true);
    }
  );

  it('chofer no puede buscar', () => {
    expect(puede({ rol: 'chofer' }, 'buscar', 'busqueda')).toBe(false);
  });
});

describe('puede — ciclos', () => {
  it.each(['dueno', 'admin', 'vendedor'])('%s puede acceder a ciclos', (rol) => {
    expect(puede({ rol }, 'acceder', 'ciclos')).toBe(true);
  });

  it.each(['depositero', 'contador', 'chofer'])('%s NO puede acceder a ciclos', (rol) => {
    expect(puede({ rol }, 'acceder', 'ciclos')).toBe(false);
  });
});

describe('puede — admin_dashboard', () => {
  it.each(['dueno', 'admin', 'vendedor', 'contador'])('%s puede acceder al dashboard admin', (rol) => {
    expect(puede({ rol }, 'acceder', 'admin_dashboard')).toBe(true);
  });

  it.each(['depositero', 'chofer'])('%s NO puede acceder al dashboard admin', (rol) => {
    expect(puede({ rol }, 'acceder', 'admin_dashboard')).toBe(false);
  });
});

describe('puede — auto_imagenes', () => {
  it.each(['dueno', 'admin'])('%s puede ejecutar auto-imágenes', (rol) => {
    expect(puede({ rol }, 'ejecutar', 'auto_imagenes')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'contador', 'chofer'])('%s NO puede ejecutar auto-imágenes', (rol) => {
    expect(puede({ rol }, 'ejecutar', 'auto_imagenes')).toBe(false);
  });
});

describe('puede — clientes (gestión de acceso portal)', () => {
  it.each(['dueno', 'admin', 'vendedor'])('%s puede acceder a la gestión de clientes', (rol) => {
    expect(puede({ rol }, 'acceder', 'clientes')).toBe(true);
  });

  it.each(['depositero', 'contador', 'chofer'])('%s NO puede acceder a la gestión de clientes', (rol) => {
    expect(puede({ rol }, 'acceder', 'clientes')).toBe(false);
  });
});

describe('puede — empresa_config', () => {
  it.each(['dueno', 'admin'])('%s puede acceder a la config de empresa', (rol) => {
    expect(puede({ rol }, 'acceder', 'empresa_config')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'contador', 'chofer'])('%s NO puede acceder a la config de empresa', (rol) => {
    expect(puede({ rol }, 'acceder', 'empresa_config')).toBe(false);
  });
});

describe('puede — reglas_precio', () => {
  it.each(['dueno', 'admin', 'contador', 'vendedor'])('%s puede leer reglas_precio', (rol) => {
    expect(puede({ rol }, 'leer', 'reglas_precio')).toBe(true);
  });

  it.each(['depositero', 'chofer'])('%s NO puede leer reglas_precio', (rol) => {
    expect(puede({ rol }, 'leer', 'reglas_precio')).toBe(false);
  });

  it.each(['dueno', 'admin', 'contador'])('%s puede escribir reglas_precio', (rol) => {
    expect(puede({ rol }, 'escribir', 'reglas_precio')).toBe(true);
  });

  it('vendedor puede leer pero NO escribir reglas_precio (gate más restrictivo)', () => {
    expect(puede({ rol: 'vendedor' }, 'leer', 'reglas_precio')).toBe(true);
    expect(puede({ rol: 'vendedor' }, 'escribir', 'reglas_precio')).toBe(false);
  });
});

describe('puede — maestros', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'contador'])(
    '%s puede leer maestros (zonas/depósitos/listas de precio/categorías)',
    (rol) => {
      expect(puede({ rol }, 'leer', 'maestros')).toBe(true);
    }
  );

  it('chofer no puede leer maestros', () => {
    expect(puede({ rol: 'chofer' }, 'leer', 'maestros')).toBe(false);
  });

  it.each(['dueno', 'admin'])('%s puede escribir maestros', (rol) => {
    expect(puede({ rol }, 'escribir', 'maestros')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'contador'])(
    '%s puede leer pero NO escribir maestros (gate más restrictivo, solo dueño/admin)',
    (rol) => {
      expect(puede({ rol }, 'leer', 'maestros')).toBe(true);
      expect(puede({ rol }, 'escribir', 'maestros')).toBe(false);
    }
  );
});

describe('puede — conciliacion_bancaria', () => {
  it.each(['dueno', 'admin', 'contador', 'vendedor'])(
    '%s puede leer conciliacion_bancaria',
    (rol) => {
      expect(puede({ rol }, 'leer', 'conciliacion_bancaria')).toBe(true);
    }
  );

  it.each(['depositero', 'chofer'])('%s NO puede leer conciliacion_bancaria', (rol) => {
    expect(puede({ rol }, 'leer', 'conciliacion_bancaria')).toBe(false);
  });

  it.each(['dueno', 'admin', 'contador'])('%s puede escribir conciliacion_bancaria', (rol) => {
    expect(puede({ rol }, 'escribir', 'conciliacion_bancaria')).toBe(true);
  });

  it('vendedor puede leer pero NO escribir conciliacion_bancaria (gate más restrictivo)', () => {
    expect(puede({ rol: 'vendedor' }, 'leer', 'conciliacion_bancaria')).toBe(true);
    expect(puede({ rol: 'vendedor' }, 'escribir', 'conciliacion_bancaria')).toBe(false);
  });
});

describe('puede — cc_proveedores', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'contador'])(
    '%s puede leer cc_proveedores (balance/facturas/pagos)',
    (rol) => {
      expect(puede({ rol }, 'leer', 'cc_proveedores')).toBe(true);
    }
  );

  it('chofer no puede leer cc_proveedores', () => {
    expect(puede({ rol: 'chofer' }, 'leer', 'cc_proveedores')).toBe(false);
  });

  it.each(['dueno', 'admin', 'contador'])('%s puede escribir cc_proveedores (alta/edición de factura)', (rol) => {
    expect(puede({ rol }, 'escribir', 'cc_proveedores')).toBe(true);
  });

  it.each(['dueno', 'admin', 'contador'])('%s puede pagar cc_proveedores (registrar_pago_proveedor)', (rol) => {
    expect(puede({ rol }, 'pagar', 'cc_proveedores')).toBe(true);
  });

  it.each(['vendedor', 'depositero'])(
    '%s puede leer pero NO escribir ni pagar cc_proveedores (gates más restrictivos)',
    (rol) => {
      expect(puede({ rol }, 'leer', 'cc_proveedores')).toBe(true);
      expect(puede({ rol }, 'escribir', 'cc_proveedores')).toBe(false);
      expect(puede({ rol }, 'pagar', 'cc_proveedores')).toBe(false);
    }
  );

  it('escribir y pagar comparten el mismo set de roles pero son acciones independientes', () => {
    for (const rol of ['dueno', 'admin', 'contador']) {
      expect(puede({ rol }, 'escribir', 'cc_proveedores')).toBe(true);
      expect(puede({ rol }, 'pagar', 'cc_proveedores')).toBe(true);
    }
  });
});

describe('puede — stock (handler principal, lotes-fefo, liquidación)', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero'])('%s puede acceder a stock', (rol) => {
    expect(puede({ rol }, 'acceder', 'stock')).toBe(true);
  });

  it.each(['contador', 'chofer'])('%s NO puede acceder a stock', (rol) => {
    expect(puede({ rol }, 'acceder', 'stock')).toBe(false);
  });
});

describe('puede — stock_lotes (sub-módulo _svc=lotes)', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'contador'])(
    '%s puede leer stock_lotes',
    (rol) => {
      expect(puede({ rol }, 'leer', 'stock_lotes')).toBe(true);
    }
  );

  it('chofer no puede leer stock_lotes', () => {
    expect(puede({ rol: 'chofer' }, 'leer', 'stock_lotes')).toBe(false);
  });

  it.each(['dueno', 'admin', 'depositero'])('%s puede escribir stock_lotes', (rol) => {
    expect(puede({ rol }, 'escribir', 'stock_lotes')).toBe(true);
  });

  it.each(['vendedor', 'contador'])(
    '%s puede leer pero NO escribir stock_lotes (gate más restrictivo, no incluye vendedor)',
    (rol) => {
      expect(puede({ rol }, 'leer', 'stock_lotes')).toBe(true);
      expect(puede({ rol }, 'escribir', 'stock_lotes')).toBe(false);
    }
  );
});

describe('puede — facturas (handler principal, ver/emitir)', () => {
  it.each(['dueno', 'admin', 'contador'])('%s puede acceder a facturas', (rol) => {
    expect(puede({ rol }, 'acceder', 'facturas')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'chofer'])('%s NO puede acceder a facturas (nota: rol "cliente" tiene acceso propio aparte, fuera de esta tabla)', (rol) => {
    expect(puede({ rol }, 'acceder', 'facturas')).toBe(false);
  });
});

describe('puede — notas_credito', () => {
  it.each(['dueno', 'admin', 'vendedor', 'contador'])('%s puede leer notas_credito', (rol) => {
    expect(puede({ rol }, 'leer', 'notas_credito')).toBe(true);
  });

  it.each(['depositero', 'chofer'])('%s NO puede leer notas_credito', (rol) => {
    expect(puede({ rol }, 'leer', 'notas_credito')).toBe(false);
  });

  it.each(['dueno', 'admin'])('%s puede escribir notas_credito', (rol) => {
    expect(puede({ rol }, 'escribir', 'notas_credito')).toBe(true);
  });

  it.each(['vendedor', 'contador'])(
    '%s puede leer pero NO escribir notas_credito (gate más restrictivo, no incluye contador)',
    (rol) => {
      expect(puede({ rol }, 'leer', 'notas_credito')).toBe(true);
      expect(puede({ rol }, 'escribir', 'notas_credito')).toBe(false);
    }
  );
});

describe('puede — comprobantes_historicos', () => {
  it.each(['dueno', 'admin', 'contador'])('%s puede acceder a comprobantes_historicos', (rol) => {
    expect(puede({ rol }, 'acceder', 'comprobantes_historicos')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'chofer'])('%s NO puede acceder a comprobantes_historicos', (rol) => {
    expect(puede({ rol }, 'acceder', 'comprobantes_historicos')).toBe(false);
  });
});

describe('puede — proveedores (ABM: alta/edición/baja)', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'contador'])(
    '%s puede leer proveedores',
    (rol) => {
      expect(puede({ rol }, 'leer', 'proveedores')).toBe(true);
    }
  );

  it('chofer no puede leer proveedores', () => {
    expect(puede({ rol: 'chofer' }, 'leer', 'proveedores')).toBe(false);
  });

  it.each(['dueno', 'admin'])('%s puede escribir proveedores', (rol) => {
    expect(puede({ rol }, 'escribir', 'proveedores')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'contador'])(
    '%s puede leer pero NO escribir proveedores (gate más restrictivo, solo dueño/admin)',
    (rol) => {
      expect(puede({ rol }, 'leer', 'proveedores')).toBe(true);
      expect(puede({ rol }, 'escribir', 'proveedores')).toBe(false);
    }
  );
});

describe('puede — compras (órdenes de compra)', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'contador'])(
    '%s puede leer compras',
    (rol) => {
      expect(puede({ rol }, 'leer', 'compras')).toBe(true);
    }
  );

  it('chofer no puede leer compras', () => {
    expect(puede({ rol: 'chofer' }, 'leer', 'compras')).toBe(false);
  });

  it.each(['dueno', 'admin', 'depositero'])('%s puede escribir compras', (rol) => {
    expect(puede({ rol }, 'escribir', 'compras')).toBe(true);
  });

  it('depositero puede escribir compras aunque NO puede escribir proveedores (gates independientes)', () => {
    expect(puede({ rol: 'depositero' }, 'escribir', 'compras')).toBe(true);
    expect(puede({ rol: 'depositero' }, 'escribir', 'proveedores')).toBe(false);
  });

  it.each(['vendedor', 'contador'])(
    '%s puede leer pero NO escribir compras',
    (rol) => {
      expect(puede({ rol }, 'leer', 'compras')).toBe(true);
      expect(puede({ rol }, 'escribir', 'compras')).toBe(false);
    }
  );
});

describe('puede — comparador_precios', () => {
  it.each(['dueno', 'admin', 'depositero', 'contador'])('%s puede leer comparador_precios', (rol) => {
    expect(puede({ rol }, 'leer', 'comparador_precios')).toBe(true);
  });

  it.each(['vendedor', 'chofer'])(
    '%s NO puede leer comparador_precios (a diferencia de proveedores/compras, acá no incluye vendedor)',
    (rol) => {
      expect(puede({ rol }, 'leer', 'comparador_precios')).toBe(false);
    }
  );
});

describe('puede — whatsapp_panel (tomar/liberar conversación)', () => {
  it.each(['dueno', 'admin', 'vendedor'])('%s puede gestionar whatsapp_panel', (rol) => {
    expect(puede({ rol }, 'gestionar', 'whatsapp_panel')).toBe(true);
  });

  it.each(['depositero', 'contador', 'chofer'])('%s NO puede gestionar whatsapp_panel', (rol) => {
    expect(puede({ rol }, 'gestionar', 'whatsapp_panel')).toBe(false);
  });
});

describe('puede — whatsapp_onboarding (conectar WhatsApp Business propio)', () => {
  it.each(['dueno', 'admin'])('%s puede conectar whatsapp_onboarding', (rol) => {
    expect(puede({ rol }, 'conectar', 'whatsapp_onboarding')).toBe(true);
  });

  it('vendedor puede gestionar el panel pero NO conectar el onboarding (gate más restrictivo)', () => {
    expect(puede({ rol: 'vendedor' }, 'gestionar', 'whatsapp_panel')).toBe(true);
    expect(puede({ rol: 'vendedor' }, 'conectar', 'whatsapp_onboarding')).toBe(false);
  });
});

describe('puede — notif_estado_cuenta', () => {
  it.each(['dueno', 'admin', 'contador', 'vendedor'])('%s puede enviar notif_estado_cuenta', (rol) => {
    expect(puede({ rol }, 'enviar', 'notif_estado_cuenta')).toBe(true);
  });

  it.each(['depositero', 'chofer'])('%s NO puede enviar notif_estado_cuenta', (rol) => {
    expect(puede({ rol }, 'enviar', 'notif_estado_cuenta')).toBe(false);
  });
});

describe('puede — pedidos (handler principal, crearPedidoAdminHandler, handleDevolucionesAdmin)', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'contador'])('%s puede acceder a pedidos', (rol) => {
    expect(puede({ rol }, 'acceder', 'pedidos')).toBe(true);
  });

  it.each(['chofer', 'cliente'])('%s NO puede acceder a pedidos', (rol) => {
    expect(puede({ rol }, 'acceder', 'pedidos')).toBe(false);
  });
});

describe('puede — presupuestos', () => {
  it.each(['dueno', 'admin', 'vendedor', 'contador'])('%s puede acceder a presupuestos', (rol) => {
    expect(puede({ rol }, 'acceder', 'presupuestos')).toBe(true);
  });

  it.each(['depositero', 'chofer'])(
    '%s NO puede acceder a presupuestos (a diferencia de pedidos, acá no incluye depositero)',
    (rol) => {
      expect(puede({ rol }, 'acceder', 'presupuestos')).toBe(false);
    }
  );
});

describe('puede — remitos (reservar próximo número, _svc=remito-nro)', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'chofer', 'contador'])(
    '%s puede acceder a remitos',
    (rol) => {
      expect(puede({ rol }, 'acceder', 'remitos')).toBe(true);
    }
  );

  it('cliente NO puede acceder a remitos', () => {
    expect(puede({ rol: 'cliente' }, 'acceder', 'remitos')).toBe(false);
  });
});

describe('puede — pedidos_chofer (portal PWA de entrega, _svc=chofer)', () => {
  it.each(['chofer', 'dueno', 'admin'])('%s puede acceder al portal del chofer', (rol) => {
    expect(puede({ rol }, 'acceder', 'pedidos_chofer')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'contador'])(
    '%s NO puede acceder al portal del chofer',
    (rol) => {
      expect(puede({ rol }, 'acceder', 'pedidos_chofer')).toBe(false);
    }
  );
});

describe('puede — pos (vender)', () => {
  it.each(['dueno', 'admin', 'vendedor'])('%s puede vender en pos', (rol) => {
    expect(puede({ rol }, 'vender', 'pos')).toBe(true);
  });

  it.each(['depositero', 'contador', 'chofer'])('%s NO puede vender en pos', (rol) => {
    expect(puede({ rol }, 'vender', 'pos')).toBe(false);
  });
});

describe('puede — pos (transferir stock entre depósitos)', () => {
  it.each(['dueno', 'admin', 'depositero'])('%s puede transferir en pos', (rol) => {
    expect(puede({ rol }, 'transferir', 'pos')).toBe(true);
  });

  it.each(['vendedor', 'contador'])('%s NO puede transferir en pos', (rol) => {
    expect(puede({ rol }, 'transferir', 'pos')).toBe(false);
  });
});

describe('puede — pos (anular venta / gestionar favoritos y promociones)', () => {
  it.each(['dueno', 'admin'])('%s puede anular en pos', (rol) => {
    expect(puede({ rol }, 'anular', 'pos')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'contador', 'chofer'])('%s NO puede anular en pos', (rol) => {
    expect(puede({ rol }, 'anular', 'pos')).toBe(false);
  });
});

describe('puede — pos (facturar comprobante AFIP / config hardware y pin)', () => {
  it.each(['dueno', 'admin'])('%s puede facturar en pos', (rol) => {
    expect(puede({ rol }, 'facturar', 'pos')).toBe(true);
  });

  it('vendedor NO puede facturar aunque sí puede vender (gate más restrictivo)', () => {
    expect(puede({ rol: 'vendedor' }, 'vender', 'pos')).toBe(true);
    expect(puede({ rol: 'vendedor' }, 'facturar', 'pos')).toBe(false);
  });
});

describe('puede — pos (administrar_cajas: forzar cierre, historial, ABM de cajas)', () => {
  it.each(['dueno', 'admin'])('%s puede administrar_cajas en pos', (rol) => {
    expect(puede({ rol }, 'administrar_cajas', 'pos')).toBe(true);
  });

  it.each(['vendedor', 'depositero', 'contador'])(
    '%s NO puede administrar_cajas en pos',
    (rol) => {
      expect(puede({ rol }, 'administrar_cajas', 'pos')).toBe(false);
    }
  );

  it('anular, facturar y administrar_cajas comparten el mismo set de roles pero son acciones separadas', () => {
    expect(puede({ rol: 'dueno' }, 'anular', 'pos')).toBe(true);
    expect(puede({ rol: 'dueno' }, 'facturar', 'pos')).toBe(true);
    expect(puede({ rol: 'dueno' }, 'administrar_cajas', 'pos')).toBe(true);
  });
});

describe('rolesDe — reexportación como valor (ROLES_ADMIN/ROLES_ADMIN_PRES en pedidos.js)', () => {
  it('rolesDe(pedidos, acceder) devuelve el mismo set que ROLES_ADMIN original', () => {
    expect(rolesDe('pedidos', 'acceder')).toEqual(
      ['dueno', 'admin', 'vendedor', 'depositero', 'contador']
    );
  });

  it('rolesDe(presupuestos, acceder) devuelve el mismo set que ROLES_ADMIN_PRES original', () => {
    expect(rolesDe('presupuestos', 'acceder')).toEqual(
      ['dueno', 'admin', 'vendedor', 'contador']
    );
  });

  it('lanza si se pide un recurso/acción inexistente, igual que puede()', () => {
    expect(() => rolesDe('recurso_inexistente', 'acceder')).toThrow(/recurso desconocido/);
    expect(() => rolesDe('pedidos', 'accion_inexistente')).toThrow(/acción desconocida/);
  });
});

describe('puede — fail-closed ante nombres inválidos', () => {
  it('lanza si el recurso no existe en la tabla de reglas', () => {
    expect(() => puede({ rol: 'dueno' }, 'leer', 'recurso_inexistente')).toThrow(
      /recurso desconocido/
    );
  });

  it('lanza si la acción no existe para ese recurso', () => {
    expect(() => puede({ rol: 'dueno' }, 'accion_inexistente', 'reglas_automatizacion')).toThrow(
      /acción desconocida/
    );
  });
});

describe('puede — perfil sin rol', () => {
  it('devuelve false (no lanza) si perfil es null/undefined', () => {
    expect(puede(null, 'leer', 'reglas_automatizacion')).toBe(false);
    expect(puede(undefined, 'leer', 'reglas_automatizacion')).toBe(false);
  });

  it('devuelve false si perfil.rol no está en ningún set', () => {
    expect(puede({ rol: 'rol_inventado' }, 'leer', 'reglas_automatizacion')).toBe(false);
  });
});
