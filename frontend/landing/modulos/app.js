(() => {
  const modules = [
    {
      slug: 'tienda-online',
      title: 'Tienda online con Mercado Pago',
       eyebrow: 'Venta digital',
      lead: 'Una tienda conectada con tu catálogo, tu stock y el circuito de pedidos, para que el cliente pueda comprar sin que tengas que cargar la operación dos veces.',
      badges: ['Catálogo online', 'Carrito', 'Mercado Pago', 'Stock actualizado'],
      intro: 'Fluxo reúne la vidriera digital y la operación interna. El cliente ve los productos habilitados, arma su carrito y confirma el pedido; del otro lado, el equipo recibe la operación con la información necesaria para prepararla, cobrarla y entregarla.',
      steps: [
        'La empresa publica los productos, precios, categorías y disponibilidad que quiere mostrar.',
        'El cliente navega el catálogo, selecciona cantidades y arma su carrito.',
        'Fluxo valida los datos de la operación y resuelve los precios en el servidor, sin confiar en importes manipulados desde el navegador.',
        'El pedido queda registrado para que el equipo pueda prepararlo, facturarlo, asignarlo a una ruta y consultar su estado.',
        'Cuando corresponde, Mercado Pago procesa el pago y el webhook actualiza el circuito sin depender de que el usuario vuelva a la pantalla.'
      ],
      capabilities: ['Catálogo de productos', 'Clientes y direcciones de entrega', 'Carrito y checkout', 'Pedidos y estados', 'Mercado Pago', 'Protección server-side de precios'],
      note: 'Pedido y pago son etapas relacionadas, pero no son exactamente lo mismo: el detalle de cada operación debe mostrar su estado real.'
    },
    {
      slug: 'whatsapp-business',
      title: 'WhatsApp Business integrado',
       eyebrow: 'Conversaciones que se convierten en operación',
      lead: 'Comunicación bidireccional: Fluxo recibe y responde mensajes de WhatsApp automáticamente, sin que nadie del equipo tenga que escribir a mano, y cada pedido entra al mismo circuito que el resto de la empresa.',
      badges: ['WhatsApp Business', 'Bidireccional', 'Respuesta automática', 'Notificaciones'],
      intro: 'La integración conecta el canal donde ya hablan tus clientes con el sistema operativo de Fluxo. Funciona en los dos sentidos: Fluxo recibe los mensajes entrantes y responde automáticamente, sin intervención humana, salvo que la empresa configure una excepción puntual. El objetivo no es solo enviar mensajes: es conservar el contexto de la conversación y convertir una intención de compra en un pedido trazable.',
      steps: [
        'La empresa configura WhatsApp Business y vincula la cuenta correspondiente.',
        'El sistema recibe los eventos del webhook y valida la integración antes de procesarlos.',
        'El cliente puede iniciar una conversación o expresar que quiere hacer un pedido.',
        'Fluxo identifica o crea el contexto del cliente y responde automáticamente, sin que un operador tenga que intervenir en la conversación.',
        'Fluxo carga los productos y cantidades en el pedido a partir de esa conversación automática.',
        'El pedido sigue el mismo circuito de stock, preparación, entrega, facturación y cobro que los demás canales.'
      ],
      capabilities: ['Onboarding de WhatsApp', 'Conversaciones por empresa', 'Respuesta automática bidireccional', 'Creación de pedidos', 'Mensajes de estado', 'Detección de credenciales vencidas', 'Registro de notificaciones'],
      note: 'La comunicación es bidireccional y automática: Fluxo responde sin que un humano del equipo escriba cada mensaje. La integración igual distingue entre mensajes entrantes, respuestas automáticas y notificaciones salientes, y la disponibilidad de cada automatización depende de la configuración de la cuenta.'
    },
    {
      slug: 'punto-de-venta',
      title: 'Punto de venta y medios de pago',
       eyebrow: 'Mostrador y caja',
      lead: 'Un POS conectado con productos, stock y clientes para vender en el mostrador, registrar cómo se cobró y cerrar la caja con una cuenta clara.',
      badges: ['Caja', 'Multi-pago', 'QR', 'Offline'],
      intro: 'El POS está pensado para el momento de la venta presencial. Cada operación valida el stock y calcula los importes en el servidor, mientras la caja conserva el turno, los movimientos y el arqueo necesario para saber qué pasó.',
      steps: [
        'El operador abre un turno de caja con un fondo inicial.',
        'Busca productos por nombre, código o lector, aplica precios especiales, promociones o descuentos autorizados.',
        'Registra uno o varios medios de pago: efectivo, tarjeta, QR u otra combinación válida.',
        'Fluxo valida que los pagos coincidan con el total, descuenta stock y guarda la venta.',
        'Al finalizar, el operador informa el efectivo contado y el sistema compara el resultado con ventas y movimientos manuales.'
      ],
      capabilities: ['Apertura y cierre de caja', 'Arqueo', 'Pagos múltiples', 'Códigos de barra', 'Descuentos con control de supervisor', 'Ventas sin conexión', 'Devoluciones y anulación total autorizada'],
      note: 'Una devolución parcial y la anulación total son operaciones distintas. La devolución es el camino habitual para productos específicos; la anulación completa queda restringida a roles autorizados.'
    },
    {
      slug: 'facturacion-arca',
      title: 'Facturación ARCA homologada',
       eyebrow: 'Comprobantes electrónicos',
      lead: 'Emití comprobantes desde el flujo operativo, guardá el CAE y mantené la factura vinculada al pedido y a la cuenta corriente del cliente.',
      badges: ['ARCA', 'CAE', 'Factura C', 'Notas de crédito'],
      intro: 'Fluxo conecta la operación comercial con ARCA para que la facturación no sea una tarea aislada. La empresa configura su punto de venta y credenciales; luego el comprobante puede generarse desde un pedido o desde el módulo de facturación.',
      steps: [
        'El responsable configura punto de venta, condición de IVA y certificado digital.',
        'Fluxo conserva las credenciales sensibles cifradas y no las expone al frontend.',
        'Desde un pedido o una factura nueva se arma el comprobante con sus datos y totales.',
        'El backend consulta ARCA, guarda el resultado y el CAE cuando la autorización es exitosa.',
        'Para corregir el efecto de una factura emitida, se utiliza una nota de crédito en lugar de borrar el comprobante.'
      ],
      capabilities: ['Configuración de facturación', 'Emisión electrónica', 'Consulta de autorización', 'CAE', 'PDF con código de barras', 'Notas de crédito', 'Estados de error y reintento'],
      note: 'La implementación actual soporta Factura C. La página no promete Factura A/B: para una empresa Responsable Inscripta todavía hace falta desarrollar la discriminación de IVA y esos comprobantes.'
    },
    {
      slug: 'reparto-en-vivo',
      title: 'Sistema de reparto en vivo',
       eyebrow: 'Logística y entregas',
      lead: 'Convertí pedidos listos en rutas de trabajo, asigná choferes y seguí qué entregas están pendientes, en camino, entregadas o necesitan reprogramación.',
      badges: ['Rutas', 'Choferes', 'Remitos', 'Entregas'],
      intro: 'El módulo une la planificación del depósito con lo que sucede en la calle. El administrador arma la ruta y el chofer trabaja desde su aplicación con los remitos y las paradas que le corresponden.',
      steps: [
        'El equipo selecciona pedidos listos para entrega y crea una ruta.',
        'Asigna un chofer y ordena las paradas según la planificación del recorrido.',
        'El chofer consulta su ruta y el detalle de cada remito desde su dispositivo.',
        'Cada confirmación actualiza el estado de la entrega y del pedido para el equipo.',
        'Si no se puede entregar, el chofer registra el motivo, notas y una foto opcional para que el pedido pueda revisarse o reprogramarse.'
      ],
      capabilities: ['Rutas del día', 'Asignación de choferes', 'Orden de paradas', 'Remitos', 'Confirmación de entrega', 'Devoluciones parciales', 'Modo de conectividad limitada', 'Registro de no entrega'],
      note: '“En vivo” significa que los estados se sincronizan a medida que se registran las acciones. No debe interpretarse como promesa de rastreo GPS permanente en todos los escenarios.'
    },
    {
      slug: 'asistente-ia',
      title: 'Asistente IA incluido',
       eyebrow: 'Operar con lenguaje natural',
      lead: 'Consultá información y convertí instrucciones, archivos o mensajes de voz en acciones dentro del sistema, respetando los permisos y las confirmaciones necesarias.',
      badges: ['Archivos', 'Voz', 'Acciones', 'Confirmación'],
      intro: 'El asistente funciona como una capa de operación sobre los módulos de Fluxo. Puede interpretar una intención, buscar datos y preparar una acción; cuando la acción modifica información, el sistema utiliza confirmaciones y controles de rol.',
      steps: [
        'El usuario escribe, habla o adjunta un archivo con una necesidad concreta.',
        'El asistente identifica la intención y consulta las herramientas disponibles para ese usuario.',
        'Puede buscar pedidos, clientes, productos, stock, cobros u órdenes de compra.',
        'Cuando corresponde, prepara una operación como crear, registrar, emitir o modificar.',
        'Las acciones de escritura se confirman antes de ejecutarse y quedan sujetas a los permisos del usuario.'
      ],
      capabilities: ['Lectura de archivos', 'Búsqueda aproximada', 'Crear pedidos', 'Presupuestos', 'Cobros', 'Stock', 'Órdenes de compra', 'Notas de crédito', 'Reglas de automatización', 'Comandos de voz'],
      note: 'El asistente no reemplaza los controles del sistema: no puede hacer cualquier acción para cualquier usuario y las operaciones sensibles requieren confirmación.'
    },
    {
      slug: 'etiquetas-precio-codigo-barras',
      title: 'Etiquetas de precio y código de barras',
       eyebrow: 'Del depósito a la góndola',
      lead: 'Elegí los productos y mandá a imprimir etiquetas con precio, código de barras real y oferta tachada cuando corresponda, hasta 500 productos por tanda.',
      badges: ['EAN-13', 'CODE128', 'IVA opcional', 'Hasta 500 productos'],
      intro: 'Fluxo genera la etiqueta con el código de barras que ya tiene cada producto: EAN-13 real si es válido, o CODE128 con el código interno cuando no lo es. La selección puede ser manual desde el listado o precargada automáticamente desde una recepción de mercadería, para no tener que volver a tipear cantidades.',
      steps: [
        'El usuario selecciona productos desde el listado, o los trae ya precargados desde una recepción de mercadería reciente.',
        'Fluxo resuelve el código de cada producto: EAN-13 si es un código de barras válido de 13 dígitos, CODE128 con el código interno en cualquier otro caso.',
        'Se define si el precio se muestra con IVA incluido o no, y si corresponde mostrar el precio promocional tachado sobre el regular.',
        'El usuario revisa la vista previa de las etiquetas antes de imprimir.',
        'Fluxo genera la tanda de impresión, hasta 500 productos por vez.'
      ],
      capabilities: ['Código de barras EAN-13 real', 'CODE128 con código interno', 'IVA incluido u opcional', 'Precio promocional tachado', 'Selección manual o desde Recepción', 'Vista previa antes de imprimir', 'Hasta 500 productos por tanda'],
      note: 'El código de barras que se imprime es el mismo que usa el resto del sistema (POS, stock): no es una etiqueta genérica, es el código real del producto.'
    },
    {
      slug: 'automatizacion-pedido-cobro',
      title: 'Automatización del pedido al cobro',
       eyebrow: 'El circuito completo',
      lead: 'Conectá venta, stock, facturación, reparto y cobranza para que cada etapa reciba el estado anterior y el equipo no tenga que reconstruir la operación manualmente.',
      badges: ['Circuito completo', 'Estados', 'Alertas', 'Trazabilidad'],
      intro: 'Este es el módulo que explica la relación entre los otros siete. Fluxo no trata el pedido como un registro aislado: lo acompaña desde que nace hasta que se entrega, se factura y se cobra. El circuito no es fijo: cada empresa define sus propias reglas de automatización (condición → acción) para que el sistema notifique o actúe solo cuando corresponde.',
      steps: [
        'El pedido ingresa por tienda online, WhatsApp, administración o POS, según el canal.',
        'Fluxo valida cliente, productos, precios, stock y condiciones comerciales.',
        'La preparación, la facturación y la asignación a reparto trabajan sobre el mismo contexto.',
        'La entrega actualiza el circuito y habilita las acciones posteriores, como facturar o registrar el cobro cuando corresponda.',
        'La empresa configura reglas propias de condición → acción (por ejemplo, avisar por WhatsApp o generar una alerta) sobre cualquier etapa del circuito.',
        'La cuenta corriente, las notificaciones y los reportes conservan la trazabilidad de lo ocurrido.'
      ],
      capabilities: ['Pedidos y presupuestos', 'Stock y depósitos', 'Facturación', 'Rutas', 'Cobranzas', 'Cuenta corriente', 'Notificaciones push', 'Reglas de automatización configurables', 'Auditoría de estados'],
      note: 'Automatizar no significa ocultar excepciones: falta de stock, factura rechazada, entrega no realizada o sesión vencida requieren estados y acciones claras para que el equipo pueda intervenir.'
    },
    {
      slug: 'reportes',
      title: 'Reportes que explican por qué, no solo cuánto',
       eyebrow: 'Decisiones con datos',
      lead: 'Ventas, finanzas, gastos generales, stock y rentabilidad por zona, producto y vendedor, en un solo lugar y sin armar planillas a mano.',
      badges: ['Ventas', 'Finanzas', 'Stock', 'Rentabilidad'],
      intro: 'Fluxo convierte la operación diaria en reportes listos para decidir: qué vender más, dónde se pierde margen y qué zona o vendedor está rindiendo. No hace falta exportar nada a una planilla aparte para entender el negocio.',
      steps: [
        'Cada venta, compra, gasto y movimiento de stock queda registrado en el momento en que ocurre.',
        'Fluxo agrupa esa información en reportes de ventas, finanzas, gastos generales y stock.',
        'La rentabilidad se calcula por zona, por producto y por vendedor, para saber dónde está el margen real.',
        'Los reportes se actualizan solos: no hay que pedirle nada a nadie ni esperar un cierre de mes.'
      ],
      capabilities: ['Reporte de ventas', 'Reporte de finanzas', 'Gastos generales', 'Reporte de stock', 'Rentabilidad por zona', 'Rentabilidad por producto y vendedor'],
      note: 'El nivel de detalle de rentabilidad por zona y por producto/vendedor está disponible en los planes Premium y Platinum.'
    },
    {
      slug: 'alertas-automaticas',
      title: 'Te avisa antes de que sea un problema',
       eyebrow: 'Control proactivo',
      lead: 'Fluxo detecta movimientos raros, manda avisos operativos y muestra la salud general del sistema, para que te enteres antes de que el cliente o el contador te lo digan.',
      badges: ['Anomalías', 'Avisos operativos', 'Salud del sistema'],
      intro: 'En vez de revisar manualmente si algo salió mal, Fluxo vigila la operación en segundo plano y avisa cuando algo se sale de lo esperado: un movimiento de stock inusual, un cobro que no cierra, un proceso que se frenó.',
      steps: [
        'Fluxo compara cada movimiento contra el comportamiento habitual del negocio.',
        'Cuando detecta una anomalía, genera un aviso operativo con el detalle para revisar.',
        'El historial de avisos queda disponible para que el equipo confirme o descarte cada caso.',
        'Un panel de salud del sistema muestra el estado general, para anticipar problemas antes de que crezcan.'
      ],
      capabilities: ['Detección de movimientos raros', 'Avisos operativos', 'Historial de envíos', 'Salud del sistema'],
      note: 'Disponible en los tres planes; Platinum suma auditoría interna sobre cada alerta.'
    },
    {
      slug: 'clientes',
      title: 'Cada cliente, con su historial completo',
       eyebrow: 'Relación comercial',
      lead: 'Cuenta corriente, score de riesgo y programa de fidelización por cliente, para saber a quién venderle fiado y a quién premiar sin adivinar.',
      badges: ['Cuenta corriente', 'Score de riesgo', 'Fidelización', 'Puntos'],
      intro: 'Fluxo no trata a cada cliente como una fila más en una planilla: acumula su historial de compras, pagos y atrasos para calcular un score de riesgo automático, y lo combina con un programa de fidelización que suma puntos por su actividad real.',
      steps: [
        'Cada venta, pago y atraso de un cliente queda registrado en su cuenta corriente.',
        'Fluxo calcula un score de riesgo a partir de ese comportamiento, sin que nadie tenga que estimarlo a mano.',
        'El programa de fidelización suma puntos según la actividad del cliente y permite canjearlos.',
        'El equipo de ventas ve ese contexto antes de aprobar una venta a cuenta o una promoción.'
      ],
      capabilities: ['Cuenta corriente', 'Score de riesgo automático', 'Programa de fidelización', 'Puntos y canjes', 'Direcciones de entrega', 'Historial de operaciones'],
      note: 'El score de riesgo por cliente está disponible desde el plan Básico; la fidelización y los puntos acompañan a los tres planes.'
    },
    {
      slug: 'responsive-celular',
      title: 'Responsive en celular',
       eyebrow: 'Operación móvil',
      lead: 'Pedidos, stock y cobranzas disponibles desde el celular, con una experiencia pensada para operar mientras el negocio está en movimiento.',
      badges: ['Mobile first', 'Pedidos', 'Stock', 'Cobranzas'],
      intro: 'Fluxo adapta las vistas clave a pantallas pequeñas sin reducir la operación a una versión de consulta. El equipo puede revisar pendientes, actualizar estados y tomar decisiones desde el depósito, el reparto o el mostrador.',
      steps: [
        'El equipo ingresa desde el celular con la misma cuenta y permisos de Fluxo.',
        'Consulta pedidos, clientes, stock y cobranzas en vistas optimizadas para toque.',
        'Actualiza estados y registra avances sin volver a una computadora.',
        'La información se sincroniza con el resto del circuito operativo.'
      ],
      capabilities: ['Panel móvil', 'Pedidos y estados', 'Stock disponible', 'Cobranzas', 'Diseño responsive', 'Acciones rápidas'],
      note: 'La experiencia móvil conserva los permisos y validaciones de la operación principal; no crea un circuito paralelo.'
    }
  ];

  const context = {
    'tienda-online': {
      forWho: 'Distribuidoras que quieren vender online sin separar la tienda de la operación interna.',
      connects: 'Catálogo · clientes · pedidos · stock · Mercado Pago',
      outcome: 'Un pedido digital listo para seguir el mismo circuito que cualquier otra venta.'
    },
    'whatsapp-business': {
      forWho: 'Equipos cuyos clientes ya hacen pedidos y consultas por WhatsApp.',
      connects: 'Conversaciones · clientes · pedidos · notificaciones',
      outcome: 'Menos copia manual y más trazabilidad desde el mensaje hasta la entrega.'
    },
    'punto-de-venta': {
      forWho: 'Locales, depósitos y vendedores que necesitan cobrar en mostrador con control de caja.',
      connects: 'Productos · stock · turnos · ventas · pagos · devoluciones',
      outcome: 'Una venta presencial registrada, cobrada y reflejada en el stock.'
    },
    'facturacion-arca': {
      forWho: 'Empresas que necesitan emitir comprobantes electrónicos desde su operación diaria.',
      connects: 'Pedidos · facturas · ARCA · CAE · cuenta corriente',
      outcome: 'Un comprobante autorizado y vinculado a la operación que lo originó.'
    },
    'reparto-en-vivo': {
      forWho: 'Distribuidoras que preparan pedidos y necesitan coordinar choferes y entregas.',
      connects: 'Pedidos listos · rutas · choferes · remitos · entregas',
      outcome: 'El equipo sabe qué salió, quién lo lleva y qué ocurrió en cada parada.'
    },
    'asistente-ia': {
      forWho: 'Personas que quieren consultar y operar el sistema sin recorrer cada pantalla.',
      connects: 'Pedidos · clientes · stock · cobros · compras · automatizaciones',
      outcome: 'Una intención convertida en información útil o en una acción confirmable.'
    },
    'etiquetas-precio-codigo-barras': {
      forWho: 'Locales y depósitos que necesitan etiquetar góndola o reponer precio después de una recepción.',
      connects: 'Productos · stock · recepción de mercadería · impresión',
      outcome: 'Etiquetas listas para imprimir con el código de barras y el precio reales del producto.'
    },
    'automatizacion-pedido-cobro': {
      forWho: 'Dueños y equipos que necesitan ver el negocio como un circuito, no como pantallas separadas.',
      connects: 'Venta · stock · factura · reparto · entrega · cobranza',
      outcome: 'Cada etapa recibe contexto de la anterior y las excepciones quedan visibles.'
    },
    'reportes': {
      forWho: 'Dueños y equipos que necesitan entender el negocio sin armar planillas a mano.',
      connects: 'Ventas · finanzas · gastos · stock · rentabilidad',
      outcome: 'Un panel que explica dónde está el margen y dónde se está perdiendo.'
    },
    'alertas-automaticas': {
      forWho: 'Equipos que quieren enterarse de un problema antes que el cliente o el contador.',
      connects: 'Stock · cobros · procesos · salud del sistema',
      outcome: 'Un aviso a tiempo en vez de una sorpresa al cierre del mes.'
    },
    'clientes': {
      forWho: 'Equipos que venden a cuenta corriente y necesitan saber a quién fiarle.',
      connects: 'Ventas · cobranzas · cuenta corriente · fidelización',
      outcome: 'Una decisión de crédito o de premio basada en historial real, no en memoria.'
    },
    'responsive-celular': {
      forWho: 'Equipos que necesitan tomar decisiones y actualizar la operación fuera del escritorio.',
      connects: 'Pedidos · stock · clientes · cobranzas · estados',
      outcome: 'La operación acompaña al equipo donde sucede el trabajo, sin perder contexto.'
    }
  };

  const slug = window.location.pathname.split('/').filter(Boolean).pop();
   const module = modules.find((item) => item.slug === slug) || modules[0];
   const index = modules.indexOf(module);
  const moduleContext = context[module.slug];
  const previous = modules[(index - 1 + modules.length) % modules.length];
  const next = modules[(index + 1) % modules.length];

  document.title = `Fluxo — ${module.title}`;
  document.getElementById('module-root').innerHTML = `
    <div class="module-shell">
      <header class="module-header">
        <a class="brand" href="/"><img class="brand-logo-img" src="/frontend/landing/img/logo-fluxo.png" alt="Fluxo"></a>
        <div class="header-actions">
          <a class="back-link" href="/#inicio">Volver al inicio</a>
          <a class="header-cta" href="/demo">Ver demo</a>
        </div>
      </header>
      <main>
        <section class="module-hero module-theme-${module.slug}">
           <div class="module-hero-inner">
             <div class="module-hero-copy">
               <span class="eyebrow">${module.eyebrow}</span>
               <h1>${module.title}</h1>
               <p class="hero-lead">${module.lead}</p>
               <div class="hero-badges">${module.badges.map((badge) => `<span class="badge">${badge}</span>`).join('')}</div>
             </div>
             <div class="module-hero-visual" aria-hidden="true">
               <div class="hero-visual-glow"></div>
               <div class="hero-visual-card hero-visual-card-main"><span class="visual-check">✓</span><div><b>Operación conectada</b><small>Todo en un solo circuito</small></div></div>
               <div class="hero-visual-card hero-visual-card-mini"><span>${module.badges[0]}</span><i></i><span>${module.badges[1] || 'Fluxo'}</span></div>
             </div>
          </div>
        </section>
        <section class="module-content">
          <article class="module-main">
            <div class="context-grid">
              <div class="context-card"><small>Para quién</small><p>${moduleContext.forWho}</p></div>
              <div class="context-card"><small>Resultado</small><p>${moduleContext.outcome}</p></div>
            </div>
            <h2>Qué resuelve</h2>
            <p>${module.intro}</p>
            <h2>Cómo funciona</h2>
             <div class="step-list">${module.steps.map((step) => `<div class="step-list-item"><span class="step-marker" aria-hidden="true"></span><p>${step}</p></div>`).join('')}</div>
            <h2>Qué incluye</h2>
            <ul>${module.capabilities.map((item) => `<li>${item}</li>`).join('')}</ul>
            <div class="note"><strong>Importante</strong>${module.note}</div>
          </article>
          <aside class="module-aside">
            <h2>Explorá los módulos</h2>
            <p class="aside-connects"><strong>Se conecta con</strong>${moduleContext.connects}</p>
             <ul>${modules.map((item) => `<li><a href="/modulos/${item.slug}">${item.title}</a></li>`).join('')}</ul>
          </aside>
        </section>
      </main>
      <nav class="module-nav">
        <a href="/modulos/${previous.slug}"><small>Anterior</small>← ${previous.title}</a>
        <a class="next" href="/modulos/${next.slug}"><small>Siguiente</small>${next.title} →</a>
      </nav>
      <footer class="module-footer">© 2026 Fluxo · Operación conectada</footer>
    </div>`;
})();