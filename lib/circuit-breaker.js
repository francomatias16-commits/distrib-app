/**
 * circuit-breaker.js — Disyuntor para llamadas a servicios externos
 * distrib-v38-optimized | Módulo 2: Resiliencia API
 *
 * ESTADOS:
 *   CLOSED   → Funciona normal. Pasa todas las llamadas.
 *   OPEN     → Cortocircuito. Rechaza inmediato sin intentar la red (evita colapso).
 *   HALF_OPEN → Prueba con 1 llamada. Si OK → CLOSED. Si falla → OPEN de nuevo.
 *
 * USO:
 *   const supabaseBreaker = new CircuitBreaker({ name: 'supabase' });
 *   const result = await supabaseBreaker.exec(() => supabase.rpc('rpc_crear_pedido', params));
 */



const ESTADOS = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {string}  opts.name            Nombre del servicio (para logs)
   * @param {number}  opts.umbralFallas     Fallas consecutivas para abrir (default: 5)
   * @param {number}  opts.tiempoRecuperacion Ms antes de pasar a HALF_OPEN (default: 30000)
   * @param {number}  opts.timeoutMs        Ms máx por llamada individual (default: 8000)
   */
  constructor({ name = 'service', umbralFallas = 5, tiempoRecuperacion = 30_000, timeoutMs = 8_000 } = {}) {
    this.name               = name;
    this.umbralFallas       = umbralFallas;
    this.tiempoRecuperacion = tiempoRecuperacion;
    this.timeoutMs          = timeoutMs;

    this._estado            = ESTADOS.CLOSED;
    this._fallasConsecutivas = 0;
    this._ultimaFallaTs      = null;
  }

  get estado() { return this._estado; }

  /**
   * Ejecuta la función protegida.
   * @param {() => Promise<any>} fn
   * @throws {CircuitBreakerOpenError} si el circuito está abierto
   */
  async exec(fn) {
    this._verificarRecuperacion();

    if (this._estado === ESTADOS.OPEN) {
      const restante = Math.ceil(
        (this.tiempoRecuperacion - (Date.now() - this._ultimaFallaTs)) / 1000
      );
      throw new CircuitBreakerOpenError(this.name, restante);
    }

    try {
      const resultado = await Promise.race([
        fn(),
        this._timeout(),
      ]);
      this._registrarExito();
      return resultado;
    } catch (err) {
      this._registrarFalla(err);
      throw err;
    }
  }

  // ── Privados ─────────────────────────────────────────────────────────────

  _verificarRecuperacion() {
    if (
      this._estado === ESTADOS.OPEN &&
      this._ultimaFallaTs &&
      Date.now() - this._ultimaFallaTs >= this.tiempoRecuperacion
    ) {
      this._estado = ESTADOS.HALF_OPEN;
    }
  }

  _registrarExito() {
    this._fallasConsecutivas = 0;
    this._estado = ESTADOS.CLOSED;
  }

  _registrarFalla(err) {
    this._fallasConsecutivas += 1;
    this._ultimaFallaTs       = Date.now();

    if (
      this._estado === ESTADOS.HALF_OPEN ||
      this._fallasConsecutivas >= this.umbralFallas
    ) {
      this._estado = ESTADOS.OPEN;
      console.error(
        `[CircuitBreaker:${this.name}] ABIERTO tras ${this._fallasConsecutivas} fallas.`,
        err?.message || err
      );
    }
  }

  _timeout() {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[CircuitBreaker:${this.name}] Timeout ${this.timeoutMs}ms`)), this.timeoutMs)
    );
  }

  /** Exponer estado para healthcheck / métricas */
  healthcheck() {
    return {
      name:               this.name,
      estado:             this._estado,
      fallasConsecutivas: this._fallasConsecutivas,
      ultimaFallaTs:      this._ultimaFallaTs,
    };
  }
}

class CircuitBreakerOpenError extends Error {
  constructor(name, segundosRestantes) {
    super(`Servicio ${name} no disponible. Reintento en ~${segundosRestantes}s.`);
    this.name    = 'CircuitBreakerOpenError';
    this.service = name;
    this.retryAfterSeconds = segundosRestantes;
  }
}

export { CircuitBreaker, CircuitBreakerOpenError, ESTADOS };
