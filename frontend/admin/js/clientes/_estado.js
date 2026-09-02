// frontend/admin/js/clientes/_estado.js
// Estado y constantes compartidas entre todos los módulos de
// frontend/admin/js/clientes/. Parte del split de clientes.js (25/08/2026).
//
// clientes.js se cargaba con <script type="module">, así que a diferencia
// de los splits de pos.js/migracion.js/productos.js (scripts clásicos que
// comparten el scope global de window) acá cada archivo tiene su propio
// module scope real — el estado mutable compartido (antes ~20 variables
// `let` sueltas a nivel de archivo) se centralizó en el objeto
// `estadoModulo` de más abajo, exportado como binding vivo: cualquier
// módulo que lo importe ve los cambios que hacen los demás.
//
// El nombre `estadoModulo` (en vez de `estado`, más corto) se eligió a
// propósito: `estado` ya se usaba como nombre de parámetro en
// selFiltroEstado(estado, btn) — reusarlo hubiera generado un shadowing
// silencioso. Verificado con un chequeo de AST (acorn) que no hay ningún
// otro parámetro, variable local, ni catch-param en todo el archivo que
// re-declare ninguno de los 20 nombres movidos acá.

export const estadoModulo = {
  sb: null,
  usuario: null,
  empresaData: null,
  clientesData: [],
  filtrados: [],
  zonas: [],
  listas: [],
  vendedores: [],
  filtroEstado: '',
  paginaActual: 1,
  totalResultados: 0,
  modalClienteId: null,   // null = nuevo, uuid = edición
  preciosData: [],
  productosParaPrecios: [],
  direccionesData: [],
  vistaActual: 'clientes',
  listasPreciosTabData: [],
  modalListaPrecioId: null,
  accesosPortalData: [],
  _pendientesGeocodificar: [],
};

export const itemsPorPagina = 50;

export const ETIQUETA_TIPO_COMPROBANTE = { factura: 'Factura', nota_credito: 'Nota de crédito', nota_debito: 'Nota de débito' };

export const SCORE_CATEGORIAS = {
  premium:   { cls: 'score-premium',  icono: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px;margin-right:3px"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>', label: 'Premium'  },
  bueno:     { cls: 'score-bueno',    icono: '<svg width="8" height="8" viewBox="0 0 8 8" style="vertical-align:1px;margin-right:3px"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>', label: 'Bueno'    },
  normal:    { cls: 'score-normal',   icono: '<svg width="8" height="8" viewBox="0 0 8 8" style="vertical-align:1px;margin-right:3px"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>', label: 'Normal'   },
  riesgo:    { cls: 'score-riesgo',   icono: '<svg width="8" height="8" viewBox="0 0 8 8" style="vertical-align:1px;margin-right:3px"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>', label: 'Riesgo'   },
  bloqueado: { cls: 'score-bloqueado',icono: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>', label: 'Bloqueado'},
};
