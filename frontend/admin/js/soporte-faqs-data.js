const SOPORTE_FAQS_DATA = {
  "ventas": [
    {
      "slug": "pedidos-presupuestos-y-carrito",
      "titulo": "Pedidos, presupuestos y carrito",
      "faqs": [
        {
          "q": "¿Qué diferencia hay entre un presupuesto y un pedido en borrador?",
          "a": "El presupuesto es una cotización que no reserva stock ni compromete nada; el pedido en borrador ya es un pedido real en proceso de armado."
        },
        {
          "q": "¿Las sugerencias de pedido se generan solas?",
          "a": "Sí, en base al historial de compra de cada cliente, sin necesidad de que alguien las cargue manualmente. El cliente o vendedor decide si las confirma o las descarta."
        },
        {
          "q": "¿El precio del carrito puede cambiar entre que lo agrego y confirmo el pedido?",
          "a": "No, el precio queda fijado al momento de agregarlo al carrito."
        }
      ]
    },
    {
      "slug": "gestion-de-clientes",
      "titulo": "Gestión de clientes",
      "faqs": [
        {
          "q": "¿Cómo se calcula el precio final que ve un cliente?",
          "a": "Primero se busca si tiene un precio especial cargado para ese producto puntual. Si no lo tiene, se usa el precio de la lista de precios asignada a ese cliente."
        },
        {
          "q": "¿Un cliente puede tener más de una dirección de entrega?",
          "a": "Sí, podés cargar varias y marcar cuál es la principal; cada pedido puede entregarse en la dirección que corresponda."
        },
        {
          "q": "¿Se puede desactivar un cliente sin borrarlo?",
          "a": "Sí, marcándolo como inactivo se lo saca de circulación sin perder su historial."
        }
      ]
    },
    {
      "slug": "bloqueos-y-score-de-cliente",
      "titulo": "Bloqueo de clientes y score de cliente",
      "faqs": [
        {
          "q": "¿El score se actualiza en tiempo real?",
          "a": "Se recalcula cuando ocurren eventos relevantes (un pago, una nueva deuda, una devolución), no es un valor fijo."
        },
        {
          "q": "¿Se puede ajustar manualmente el score de un cliente?",
          "a": "El score se calcula automáticamente según las reglas configuradas; lo que sí se puede ajustar son esas reglas (los umbrales y multiplicadores) a nivel empresa."
        }
      ]
    },
    {
      "slug": "pos-apertura-cierre-caja",
      "titulo": "Apertura y cierre de caja (turno)",
      "faqs": [
        {
          "q": "¿Puedo tener dos turnos abiertos en la misma caja al mismo tiempo?",
          "a": "No. Una caja tiene un solo turno activo (estado `abierto`) por vez. Si necesitás que dos personas vendan en simultáneo, usá cajas distintas."
        },
        {
          "q": "¿Qué pasa si me olvido de cerrar el turno y sigo vendiendo al otro día?",
          "a": "Las ventas van a seguir sumando al mismo turno hasta que alguien lo cierre. Conviene cerrar el turno todos los días para que el arqueo de caja sea preciso."
        },
        {
          "q": "¿Quién puede ver la diferencia de caja?",
          "a": "El admin puede revisar todos los turnos y sus diferencias para detectar problemas recurrentes de un cajero o de una caja puntual."
        }
      ]
    },
    {
      "slug": "pos-devoluciones",
      "titulo": "Cómo hacer una devolución en el POS",
      "faqs": [
        {
          "q": "¿Se puede devolver un ítem que ya fue devuelto antes?",
          "a": "No debería duplicarse — cada devolución queda asociada al ítem específico de la venta, así que el sistema lleva el control de cuánto de ese ítem ya fue devuelto."
        },
        {
          "q": "¿La devolución afecta la factura ya emitida?",
          "a": "La devolución en sí no modifica la factura original. Si necesitás un comprobante fiscal por la devolución, se maneja con una nota de crédito (ver artículo de notas de crédito)."
        }
      ]
    },
    {
      "slug": "pos-favoritos-y-movimientos-caja",
      "titulo": "Productos favoritos y movimientos manuales de caja",
      "faqs": [
        {
          "q": "¿Los movimientos de caja afectan el stock?",
          "a": "No, son solo de efectivo/caja. No tienen relación con productos ni stock."
        },
        {
          "q": "¿Puedo editar un movimiento de caja ya cargado?",
          "a": "Depende de los permisos configurados para tu rol. Como buena práctica, si te equivocaste, cargá un movimiento inverso en vez de editar el original, para mantener el historial claro."
        }
      ]
    },
    {
      "slug": "pos-realizar-venta",
      "titulo": "Cómo realizar una venta en el POS",
      "faqs": [
        {
          "q": "¿Puedo vender sin stock disponible?",
          "a": "Depende de la configuración de tu empresa. Si el control de stock está activo, el sistema va a advertir o bloquear la venta de un producto sin stock suficiente en el depósito de esa caja."
        },
        {
          "q": "¿Se puede anular una venta ya confirmada?",
          "a": "No se anula directamente; se hace a través de una **devolución** (ver artículo de devoluciones POS), que ajusta stock y montos correctamente."
        }
      ]
    },
    {
      "slug": "pos-ventas-sin-conexion",
      "titulo": "Vender sin conexión a internet",
      "faqs": [
        {
          "q": "¿Cómo sé si una venta se sincronizó?",
          "a": "Una vez sincronizada, la venta deja de figurar como pendiente y aparece con normalidad en el listado de ventas del turno, con su numeración definitiva."
        },
        {
          "q": "¿Puedo facturar una venta que todavía está offline, sin sincronizar?",
          "a": "No. La factura electrónica requiere que la venta ya esté sincronizada con el servidor."
        }
      ]
    },
    {
      "slug": "rutas-y-entregas",
      "titulo": "Rutas y entregas",
      "faqs": [
        {
          "q": "¿Se puede reordenar las paradas de una ruta ya creada?",
          "a": "Sí, el orden de las paradas es editable mientras la ruta no esté finalizada."
        },
        {
          "q": "¿Qué pasa si el chofer pierde conexión durante el reparto?",
          "a": "Puede seguir marcando entregas; la ubicación en tiempo real y la sincronización de las confirmaciones se actualizan apenas vuelve la conexión."
        },
        {
          "q": "¿Un pedido puede estar en dos rutas a la vez?",
          "a": "No, cada pedido pertenece a una sola ruta activa por vez."
        }
      ]
    },
    {
      "slug": "reportes-de-ruta",
      "titulo": "Reportes de ruta",
      "faqs": [
        {
          "q": "¿El reporte se genera automáticamente o hay que pedirlo?",
          "a": "Se genera automáticamente al cerrar la ruta."
        },
        {
          "q": "¿Puedo ver el historial de reportes de rutas anteriores?",
          "a": "Sí, quedan guardados y se pueden consultar por chofer, por zona o por rango de fechas."
        }
      ]
    }
  ],
  "deposito": [
    {
      "slug": "stock-y-depositos",
      "titulo": "Stock y depósitos",
      "faqs": [
        {
          "q": "¿Por qué la cantidad disponible es menor a la cantidad total?",
          "a": "Porque hay pedidos confirmados que ya reservaron parte de ese stock, aunque todavía no se despacharon."
        },
        {
          "q": "¿Se puede vender con stock negativo?",
          "a": "Depende de la configuración de cada producto — algunos productos pueden estar habilitados para permitir stock negativo (por ejemplo, productos de reposición constante), y otros no."
        },
        {
          "q": "¿Cómo corrijo un stock que no coincide con lo que hay físicamente?",
          "a": "Con un movimiento de tipo ajuste, indicando la diferencia y, si corresponde, el motivo."
        }
      ]
    },
    {
      "slug": "lotes-vencimientos-y-liquidacion",
      "titulo": "Lotes, vencimientos y ofertas de liquidación",
      "faqs": [
        {
          "q": "¿Qué pasa si un producto tiene varios lotes con distinta fecha de vencimiento?",
          "a": "El sistema puede generar una oferta de liquidación por cada lote próximo a vencer de forma independiente."
        },
        {
          "q": "¿Las ofertas de liquidación se aplican solas en el POS o en pedidos?",
          "a": "Sí, si la oferta está activa, el precio con descuento se aplica automáticamente al vender ese producto, hasta que se desactive."
        }
      ]
    },
    {
      "slug": "productos-categorias-y-promociones",
      "titulo": "Productos, categorías y promociones",
      "faqs": [
        {
          "q": "¿Puedo tener dos promociones activas sobre el mismo producto?",
          "a": "No es recomendable, ya que puede generar ambigüedad sobre cuál se aplica. Lo ideal es que cada producto tenga una sola promoción vigente por vez."
        },
        {
          "q": "¿Qué pasa cuando vence una promoción?",
          "a": "Deja de aplicarse automáticamente a partir de la fecha de fin configurada, sin necesidad de desactivarla a mano."
        }
      ]
    },
    {
      "slug": "ordenes-de-compra-y-recepcion",
      "titulo": "Órdenes de compra y recepción de mercadería",
      "faqs": [
        {
          "q": "¿Qué hago si el proveedor entregó menos cantidad de la pedida?",
          "a": "Se registra la cantidad realmente recibida en la recepción — el sistema muestra la diferencia como discrepancia, y el stock solo se actualiza con lo efectivamente recibido."
        },
        {
          "q": "¿Se puede recibir una orden de compra en varias partes?",
          "a": "Sí, una orden de compra puede recibirse de forma parcial en distintas recepciones hasta completarse."
        }
      ]
    },
    {
      "slug": "facturas-y-pagos-a-proveedores",
      "titulo": "Facturas y pagos a proveedores",
      "faqs": [
        {
          "q": "¿Qué pasa si una factura autocargada por el proveedor tiene un error?",
          "a": "Queda en estado pendiente hasta que el admin la revise; se puede corregir o rechazar antes de aprobarla."
        },
        {
          "q": "¿Se puede pagar una factura en varias cuotas?",
          "a": "Sí, podés registrar varios pagos parciales contra la misma factura hasta cubrir el total."
        }
      ]
    },
    {
      "slug": "portal-de-proveedores",
      "titulo": "Portal de autogestión de proveedores",
      "faqs": [
        {
          "q": "¿Qué pasa si el link del proveedor se filtra o se pierde?",
          "a": "El admin puede revocarlo en cualquier momento y generar uno nuevo."
        },
        {
          "q": "¿El proveedor ve información de otros proveedores o de la empresa en general?",
          "a": "No, el acceso del portal está limitado únicamente a los datos de ese proveedor puntual."
        },
        {
          "q": "¿El link vence solo?",
          "a": "Sí, tiene una fecha de expiración configurada al generarlo."
        }
      ]
    },
    {
      "slug": "devoluciones-de-pedidos",
      "titulo": "Devoluciones de pedidos (reparto)",
      "faqs": [
        {
          "q": "¿Toda devolución de reparto genera una nota de crédito al cliente automáticamente?",
          "a": "No es automático — depende de si esa mercadería devuelta ya estaba facturada. Si corresponde, la nota de crédito se genera como un paso aparte."
        },
        {
          "q": "¿Quién puede registrar una devolución de reparto?",
          "a": "Normalmente el chofer al momento de la entrega, aunque el admin también puede cargarla o corregirla después."
        }
      ]
    }
  ],
  "cobros": [
    {
      "slug": "cobros-y-cuenta-corriente",
      "titulo": "Cobros y cuenta corriente de clientes",
      "faqs": [
        {
          "q": "¿Qué pasa si registro un cobro por un monto mayor a la deuda del cliente?",
          "a": "El cliente queda con saldo a favor, que se puede descontar de una futura factura."
        },
        {
          "q": "¿Se puede anular un cobro ya cargado?",
          "a": "Depende de los permisos de tu rol. Como regla general, ante un error conviene registrar un movimiento de ajuste en vez de eliminar el cobro, para no perder el rastro contable."
        },
        {
          "q": "¿Cómo sé si un cheque todavía no se depositó?",
          "a": "Podés revisar el estado del cheque — mientras no esté marcado como cobrado, no impacta el saldo real de caja."
        }
      ]
    },
    {
      "slug": "riesgo-de-cheques",
      "titulo": "Riesgo de cheques",
      "faqs": [
        {
          "q": "¿Esto bloquea o rechaza cheques automáticamente?",
          "a": "No. Es una vista de análisis para ayudarte a decidir; las acciones sobre cada cheque (depositar, marcar como rechazado, etc.) se siguen haciendo desde la pantalla de Cheques."
        },
        {
          "q": "¿De dónde sale la deuda actual y el límite de crédito?",
          "a": "Del mismo cálculo que usa el resto del sistema para priorizar cobranzas (ver artículo de Cobros y cuenta corriente), no es un número aparte."
        },
        {
          "q": "¿Con qué frecuencia se actualiza?",
          "a": "Se recalcula cada vez que entrás a la pantalla, o con el botón \"Actualizar\". El score del cliente en sí se recalcula automáticamente ante eventos relevantes (ver artículo de Bloqueos y score de cliente)."
        }
      ]
    },
    {
      "slug": "medios-de-pago-online",
      "titulo": "Medios de pago online (integraciones)",
      "faqs": [
        {
          "q": "¿Qué pasa si el webhook de la pasarela no llega?",
          "a": "La transacción puede quedar en estado pendiente más tiempo del esperado. El admin puede revisar el estado directamente en el panel de la pasarela de pago para confirmar si se acreditó."
        },
        {
          "q": "¿Puedo tener más de una integración de pago activa?",
          "a": "Depende de tu configuración — cada integración se identifica por proveedor, así que técnicamente se pueden tener varias, aunque lo más común es tener una activa por vez."
        },
        {
          "q": "¿Los datos de la tarjeta del cliente pasan por nuestro sistema?",
          "a": "No. El cobro con tarjeta se procesa siempre del lado de la pasarela de pago (Mercado Pago u otra); nuestro sistema solo recibe la confirmación del resultado."
        }
      ]
    }
  ],
  "facturacion": [
    {
      "slug": "facturacion-electronica-afip",
      "titulo": "Facturación electrónica (AFIP/ARCA)",
      "faqs": [
        {
          "q": "¿Por qué una factura quedó en error_afip?",
          "a": "Puede ser un problema de conexión temporal con ARCA, un dato mal cargado (CUIT del cliente inválido, por ejemplo), o el certificado digital vencido. El mensaje de error específico queda guardado junto a la factura."
        },
        {
          "q": "¿Se puede facturar sin conexión a internet?",
          "a": "No, la emisión de un comprobante fiscal siempre requiere conexión con los servicios de ARCA en el momento de autorizar el CAE."
        },
        {
          "q": "¿Qué pasa si vence el certificado digital?",
          "a": "Todas las emisiones van a fallar hasta que se renueve el certificado en ARCA y se vuelva a cargar en la configuración de facturación. Esto lo gestiona el admin o el contador de la empresa."
        }
      ]
    },
    {
      "slug": "notas-credito-y-debito",
      "titulo": "Notas de crédito y notas de débito",
      "faqs": [
        {
          "q": "¿Puedo hacer una nota de crédito parcial?",
          "a": "Sí, no hace falta anular el total de la factura — podés acreditar solo los ítems o el monto que corresponda."
        },
        {
          "q": "¿Una nota de crédito afecta el stock?",
          "a": "No directamente. Si la nota de crédito es consecuencia de una devolución física de mercadería, el ajuste de stock se maneja por separado en el módulo de devoluciones."
        }
      ]
    }
  ],
  "fidelizacion": [
    {
      "slug": "fidelizacion-puntos-y-recompensas",
      "titulo": "Programa de fidelización: puntos y recompensas",
      "faqs": [
        {
          "q": "¿Los puntos vencen?",
          "a": "Depende de la configuración del programa de fidelización de tu empresa — consultá con el admin si tu programa tiene vencimiento de puntos."
        },
        {
          "q": "¿Se pueden perder puntos ya ganados?",
          "a": "Sí, por ejemplo si se anula el pedido que los generó, o al canjear una recompensa (se descuentan del saldo disponible)."
        },
        {
          "q": "¿Todos los clientes participan del programa automáticamente?",
          "a": "Sí, mientras el programa de fidelización de la empresa esté activo, todos los clientes acumulan puntos automáticamente con sus **pedidos** (carrito del portal/app, o pedido cargado por un vendedor/admin). Las ventas de mostrador (punto de venta / caja) no acreditan puntos por el momento, aunque la venta esté asociada a un cliente identificado."
        }
      ]
    }
  ],
  "reportes": [],
  "config": [
    {
      "slug": "usuarios-y-roles",
      "titulo": "Usuarios y roles del sistema",
      "faqs": [
        {
          "q": "¿Un usuario puede tener más de un rol?",
          "a": "No, cada usuario tiene un único rol asignado, que determina qué partes del sistema puede ver y operar."
        },
        {
          "q": "¿Cómo doy de baja a un usuario que ya no trabaja en la empresa?",
          "a": "Desde Configuración → Usuarios, con el botón \"Desactivar\" en su fila. Se lo marca como inactivo — no se borra, para conservar el historial de las operaciones que hizo. No se puede desactivar al propio usuario logueado ni dejar a la empresa sin ningún dueño activo."
        },
        {
          "q": "¿El rol \"cliente\" es el mismo que un cliente normal de la base de clientes?",
          "a": "Sí, está vinculado: un usuario con rol cliente tiene asociado su registro en la tabla de clientes, para que solo pueda ver su propia información."
        }
      ]
    },
    {
      "slug": "empresas-y-plan-saas",
      "titulo": "Tu empresa y el plan del servicio",
      "faqs": [
        {
          "q": "¿Qué pasa si supero el límite de usuarios o clientes de mi plan?",
          "a": "El sistema va a advertir o bloquear la creación de nuevos registros hasta que actualices a un plan de mayor capacidad."
        },
        {
          "q": "¿Qué pasa si mi cuenta queda suspendida?",
          "a": "El acceso operativo se restringe hasta regularizar el pago pendiente del servicio."
        },
        {
          "q": "¿Puedo cambiar de plan en cualquier momento?",
          "a": "Sí, se puede pasar a un tier superior según la necesidad de la empresa."
        }
      ]
    },
    {
      "slug": "auditoria-y-seguridad",
      "titulo": "Auditoría y detección de anomalías",
      "faqs": [
        {
          "q": "¿Quién puede ver el registro de auditoría?",
          "a": "Normalmente solo el admin o el dueño de la empresa."
        },
        {
          "q": "¿Una anomalía detectada significa necesariamente que hubo un problema?",
          "a": "No siempre — el sistema marca patrones que ameritan revisión, pero puede haber explicaciones legítimas (por ejemplo, un ajuste de stock autorizado verbalmente que todavía no tenía la orden de compra cargada). Por eso cada anomalía se revisa y se documenta el resultado."
        }
      ]
    },
    {
      "slug": "notificaciones-push-y-email",
      "titulo": "Notificaciones (push y email)",
      "faqs": [
        {
          "q": "¿Por qué un cliente no recibe notificaciones push?",
          "a": "Puede ser que nunca aceptó los permisos de notificación en su dispositivo, o que el dispositivo quedó marcado como inactivo."
        },
        {
          "q": "¿Se puede reenviar un email que falló?",
          "a": "Sí — en el historial de notificaciones, las filas de email fallidas tienen un botón \"Reintentar\" (ver arriba). Cubre confirmación de pedido, despacho, estado de cuenta y recepción a proveedores; otros tipos todavía no se pueden reintentar desde el panel."
        }
      ]
    }
  ],
  "automatizacion": []
};

// Fuente: docs/ayuda/*.md, sección "## Preguntas frecuentes" de cada artículo,
// extraídas y agrupadas por workspace (ver WORKSPACE_MAP en el script que
// generó este archivo). Si se edita un .md, hay que volver a generar esto
// a mano por ahora (no hay build step todavía para docs/ayuda -> frontend).
window.SOPORTE_FAQS_DATA = SOPORTE_FAQS_DATA;

