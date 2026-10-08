/**
 * Reproductor de StreamBox — simulación con reloj.
 *
 * No hay vídeo real: el "tiempo" avanza con `requestAnimationFrame` y
 * `performance.now()`. Lo importante no es el píxel sino el ESTADO: siempre
 * honesto, sin temporizadores huérfanos, sin reentrada y con todos los
 * controles accesibles por teclado y lector de pantalla.
 *
 * IIFE clásica que publica en `window.TemaUI`, sin `import`/`export`: la demo
 * se abre con doble clic (file://) y los módulos ES quedarían bloqueados por
 * la política CORS. Orden de carga: data.js → themes.js → player.js → app.js.
 *
 * Mecanismo de coordinación de menús (compartido con themes.js y app.js):
 * al abrir el menú de ajustes se despacha `tema-ui:close-menus` en `document`;
 * quien escuche ese evento debe cerrar SU menú. Así nunca hay dos menús
 * abiertos a la vez y no hace falta que ningún módulo conozca a los demás.
 */
(function (global) {
  'use strict';

  var TemaUI = (global.TemaUI = global.TemaUI || {});

  /* --- Constantes -------------------------------------------------------- */

  /**
   * Nombre EXACTO del CustomEvent de coordinación entre menús.
   * themes.js debe escucharlo (y despacharlo al abrir `#themeMenu`);
   * app.js puede usarlo para cerrar cualquier panel propio (p. ej. la ayuda).
   */
  var CLOSE_MENUS_EVENT = 'tema-ui:close-menus';

  /** Ritmo permitido por el menú de velocidad (0,5× … 2×). */
  var MIN_RATE = 0.5;
  var MAX_RATE = 2;

  /**
   * Cadencia máxima de refresco de stats y notificaciones mientras se
   * reproduce: 250 ms = 4 veces por segundo, como exige el contrato.
   * A cada fotograma (~60/s) sólo se mueve la barra, que sí es visual.
   */
  var STATS_INTERVAL = 250;

  /** Volumen que se restaura si el anterior resultara ser 0. */
  var FALLBACK_VOLUME = 70;

  /* --- Datos (cargados antes por data.js) -------------------------------- */

  var data = TemaUI.data || {};

  /* --- Estado interno ---------------------------------------------------- */

  var state = {
    /** Objeto Episode completo de data.js (null si el módulo no está). */
    episode: null,
    playing: false,
    time: 872,
    volume: 70,
    muted: false,
    /** Volumen anterior al silencio: `toggleMute` lo restaura. */
    lastVolume: 70,
    rate: 1,
    captions: false,
    quality: 'auto',
    fullscreen: false,
    /** Avance de búfer, 0-1 (empieza en 0,62 con el episodio por defecto). */
    buffered: 0.62,
  };

  /** Nodos enlazados. `null` si el id no existe: cada uso lleva su guard. */
  var el = {};

  /** Suscriptores de `onChange`. */
  var listeners = [];

  /** Claves ya enlazadas: `init()` puede llamarse más de una vez sin duplicar. */
  var bound = {};

  /** Handle del bucle de animación. 0 = no hay reloj en marcha. */
  var rafId = 0;
  /** Marca de tiempo del fotograma anterior (0 = fotograma de arranque). */
  var lastTs = 0;
  /** Último instante en que se actualizaron stats/avisos. */
  var lastStatsAt = 0;
  /** Estado inicial ya tomado de data.js (sólo se hace una vez). */
  var initialDone = false;

  /**
   * Bandera de sincronía del rango de progreso.
   *
   * Cuando EL PROPIO JS escribe `input.value`, el handler `input` no debe
   * interpretarlo como un arrastre del usuario: sin esta bandera, un navegador
   * que emitiera el evento de forma síncrona nos devolvería el valor al mismo
   * `seek` que lo acababa de escribir (bucle de reentrada).
   */
  var syncing = false;
  /** Igual para el slider de volumen, para que los dos guardas no se pisen. */
  var syncingVolume = false;

  /**
   * ¿La pausa la provocó la pestaña oculta (y no el usuario)?
   * Política elegida: al volver se reanuda SOLO si fuimos nosotros quienes
   * pausamos al ocultar. Si el usuario pausó a mano mientras la pestaña
   * estaba visible, `pausedByVisibility` es false y NO se le respawnea la
   * reproducción: la última decisión del usuario manda.
   */
  var pausedByVisibility = false;

  /* --- Utilidades -------------------------------------------------------- */

  /**
   * @param {HTMLElement} target
   * @param {string} name
   * @param {boolean} on
   */
  function setClass(target, name, on) {
    if (!target || !target.classList) return;
    if (on) target.classList.add(name);
    else target.classList.remove(name);
  }

  /**
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  /**
   * Segundos → `14:32`. Delega en data.js; sólo usa el respaldo si ese
   * módulo no se hubiera cargado (nunca debe lanzar).
   *
   * @param {number} seconds
   * @returns {string}
   */
  function fmt(seconds) {
    if (typeof data.formatTime === 'function') return data.formatTime(seconds);
    var safe = Math.max(0, Math.floor(Number(seconds) || 0));
    var minutes = Math.floor(safe / 60);
    var rest = safe % 60;
    return minutes + ':' + (rest < 10 ? '0' + rest : String(rest));
  }

  /**
   * @param {string} id
   * @returns {Object|undefined}
   */
  function getEpisode(id) {
    if (typeof data.getEpisode !== 'function') return undefined;
    return data.getEpisode(id);
  }

  /**
   * @param {string} id
   * @returns {Object|undefined}
   */
  function getNextEpisode(id) {
    if (typeof data.getNextEpisode !== 'function') return undefined;
    return data.getNextEpisode(id);
  }

  /** Duración del episodio cargado (0 si no hay ninguno). */
  function duration() {
    return state.episode ? state.episode.duration : 0;
  }

  /** Instante en la misma base de tiempo que los timestamps de rAF. */
  function nowMs() {
    if (global.performance && typeof global.performance.now === 'function') {
      return global.performance.now();
    }
    return Date.now();
  }

  /* --- Notificaciones ---------------------------------------------------- */

  /**
   * Copia plana del estado para el exterior.
   *
   * `episode`/`current` apuntan al objeto de data.js (no se copia: es de solo
   * lectura y copiarlo sólo invitaría a mutarlo). El resto son primitivos.
   *
   * @returns {Object}
   */
  function getState() {
    return {
      episode: state.episode,
      current: state.episode,
      id: state.episode ? state.episode.id : null,
      playing: state.playing,
      time: state.time,
      volume: state.volume,
      muted: state.muted,
      lastVolume: state.lastVolume,
      rate: state.rate,
      captions: state.captions,
      quality: state.quality,
      fullscreen: state.fullscreen,
      buffered: state.buffered,
    };
  }

  /**
   * Avisa a los suscriptores con un snapshot. Un callback defectuoso no debe
   * tumbar el resto (mismo criterio que themes.js).
   */
  function notify() {
    if (!listeners.length) return;
    var snapshot = getState();
    var current = listeners.slice();
    for (var i = 0; i < current.length; i += 1) {
      try {
        current[i](snapshot);
      } catch (err) {
        if (global.console && global.console.warn) {
          global.console.warn('[tema-ui] Falló un suscriptor de onChange del reproductor:', err);
        }
      }
    }
  }

  /**
   * @param {Function} callback recibe `getState()`.
   * @returns {Function} función de baja.
   */
  function onChange(callback) {
    if (typeof callback !== 'function') return function () {};
    listeners.push(callback);
    return function unsubscribe() {
      var index = listeners.indexOf(callback);
      if (index !== -1) listeners.splice(index, 1);
    };
  }

  /* --- Pintado ----------------------------------------------------------- */

  /** Ficha del episodio: título, sinopsis, miga, código, etiqueta y matiz. */
  function renderMeta() {
    var ep = state.episode;
    if (!ep) return;
    var code = 'T' + ep.season + ' E' + ep.episode;

    if (el.nowPlayingTitle) el.nowPlayingTitle.textContent = ep.series + ' — ' + code;
    if (el.metaDesc) el.metaDesc.textContent = ep.description;
    if (el.metaSeries) el.metaSeries.textContent = ep.series;
    if (el.metaSeason) el.metaSeason.textContent = 'Temporada ' + ep.season;
    if (el.videoCode) el.videoCode.textContent = code;
    if (el.videoTag) el.videoTag.textContent = ep.tag;
    // La carátula es un gradiente procedural cuyo matiz sale del episodio:
    // un solo custom property y el CSS hace el resto.
    if (el.videoArt) el.videoArt.style.setProperty('--art-hue', String(ep.hue));
  }

  /** Botón de play, overlay, marcos y subtítulos. */
  function renderPlayState() {
    var playing = state.playing;

    if (el.videoFrame) setClass(el.videoFrame, 'is-playing', playing);
    if (el.videoCanvas) setClass(el.videoCanvas, 'is-playing', playing);

    if (el.playBtn) {
      setClass(el.playBtn, 'is-playing', playing);
      el.playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
      el.playBtn.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
    }

    if (el.playOverlay) {
      // Oculto mientras reproduce: así el clic central no pausa por accidente.
      el.playOverlay.hidden = playing;
      el.playOverlay.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
    }

    renderCaptions();
  }

  /** Subtítulos: visibles SOLO con CC activos Y en reproducción. */
  function renderCaptions() {
    var on = state.captions && state.playing;
    if (el.videoCaptions) el.videoCaptions.hidden = !on;
    if (el.ccBtn) {
      el.ccBtn.setAttribute('aria-pressed', state.captions ? 'true' : 'false');
      el.ccBtn.setAttribute('aria-label', state.captions ? 'Desactivar subtítulos' : 'Activar subtítulos');
    }
  }

  /**
   * Barra de progreso, cronómetro y `aria-valuetext`.
   *
   * El búfer simulado nunca retrocede: `max(buffered, visto + 8 %)`,
   * limitado al 100 %.
   */
  function renderProgress() {
    var dur = duration();
    var pct = clamp(dur > 0 ? (state.time / dur) * 100 : 0, 0, 100);
    var played = dur > 0 ? state.time / dur : 0;

    // El búfer REAL sólo avanza (nunca retrocede al buscar atrás), pero se
    // pinta por delante: lo visto + 8 puntos. Por eso el estado conserva su
    // valor (0,06 recién cargado) y el ancho del DIV es el máximo de ambos.
    if (played > state.buffered) state.buffered = played;
    var buffered = Math.max(state.buffered, (pct + 8) / 100);
    if (buffered > 1) buffered = 1;

    if (el.progressPlayed) el.progressPlayed.style.width = pct + '%';
    if (el.progressBuffered) {
      el.progressBuffered.style.width = Math.round(buffered * 1000) / 10 + '%';
    }

    if (el.progressInput) {
      // Escritura con guard: ver comentario de `syncing`.
      syncing = true;
      el.progressInput.max = String(dur);
      el.progressInput.value = String(Math.round(clamp(state.time, 0, dur)));
      syncing = false;
      // Texto legible para lectores de pantalla: "14:32 de 42:10", no "872".
      el.progressInput.setAttribute('aria-valuetext', fmt(state.time) + ' de ' + fmt(dur));
    }

    if (el.timeCurrent) el.timeCurrent.textContent = fmt(state.time);
    if (el.timeTotal) el.timeTotal.textContent = fmt(dur);
  }

  /** Duración, restante y porcentaje visto. Se llama a 4 Hz, no a 60. */
  function renderStats() {
    var dur = duration();
    var seen = dur > 0 ? (state.time / dur) * 100 : 0;
    if (el.statDuration) el.statDuration.textContent = fmt(dur);
    if (el.statRemaining) el.statRemaining.textContent = fmt(Math.max(0, dur - state.time));
    if (el.statProgress) el.statProgress.textContent = Math.round(seen) + ' %';
  }

  /** Volumen, silencio e icono `vol-high` / `vol-low` / `vol-mute`. */
  function renderVolume() {
    if (el.volumeInput) {
      syncingVolume = true;
      el.volumeInput.value = String(state.volume);
      syncingVolume = false;
      el.volumeInput.setAttribute('aria-valuetext', state.volume + ' por ciento');
    }

    if (el.muteBtn) {
      // Icono según volumen efectivo: 0 o silenciado → mudo; <50 → bajo.
      var level = 'vol-high';
      if (state.muted || state.volume <= 0) level = 'vol-mute';
      else if (state.volume < 50) level = 'vol-low';

      setClass(el.muteBtn, 'vol-high', level === 'vol-high');
      setClass(el.muteBtn, 'vol-low', level === 'vol-low');
      setClass(el.muteBtn, 'vol-mute', level === 'vol-mute');
      setClass(el.muteBtn, 'is-muted', state.muted);

      el.muteBtn.setAttribute('aria-pressed', state.muted ? 'true' : 'false');
      el.muteBtn.setAttribute('aria-label', state.muted ? 'Activar sonido' : 'Silenciar');
    }
  }

  /** Marca `aria-checked` de velocidad y el chip `1,5×`. */
  function renderRate() {
    if (el.rateChip) {
      // Coma decimal española: 1,5× y no 1.5×.
      var label = String(state.rate).replace('.', ',') + '×';
      if (state.rate !== 1) {
        el.rateChip.hidden = false;
        el.rateChip.textContent = label;
      } else {
        el.rateChip.hidden = true;
      }
    }

    if (el.settingsMenu) {
      var rates = el.settingsMenu.querySelectorAll('[data-rate]');
      for (var i = 0; i < rates.length; i += 1) {
        var active = parseFloat(rates[i].getAttribute('data-rate')) === state.rate;
        rates[i].setAttribute('aria-checked', active ? 'true' : 'false');
      }
    }
  }

  /** Marca `aria-checked` de calidad. */
  function renderQuality() {
    if (!el.settingsMenu) return;
    var options = el.settingsMenu.querySelectorAll('[data-quality]');
    for (var i = 0; i < options.length; i += 1) {
      var active = options[i].getAttribute('data-quality') === state.quality;
      options[i].setAttribute('aria-checked', active ? 'true' : 'false');
    }
  }

  /**
   * Marca la fila cargada en `#upNextList`.
   *
   * La lista la pinta app.js, así que sólo se reconoce un episodio si la fila
   * trae `data-id` (o `data-episode-id`/`data-episode`) en el `<li>` o en su
   * botón. Si app.js no lo pone, esta función no toca nada en vez de borrar
   * por accidente la marca de otro módulo.
   */
  function syncUpNext() {
    if (!el.upNextList || !state.episode) return;
    var rows = el.upNextList.querySelectorAll('.up-item');
    for (var i = 0; i < rows.length; i += 1) {
      var id = rowEpisodeId(rows[i]);
      if (id) setClass(rows[i], 'is-current', id === state.episode.id);
    }
  }

  /**
   * @param {HTMLElement} row
   * @returns {string|null}
   */
  function rowEpisodeId(row) {
    if (!row || !row.getAttribute) return null;
    var keys = ['data-id', 'data-episode-id', 'data-episode'];
    var child = row.firstElementChild;
    for (var i = 0; i < keys.length; i += 1) {
      if (row.hasAttribute(keys[i])) return row.getAttribute(keys[i]);
      if (child && child.hasAttribute && child.hasAttribute(keys[i])) {
        return child.getAttribute(keys[i]);
      }
    }
    return null;
  }

  /** Pinta absolutamente todo (init y carga de episodio). */
  function renderAll() {
    renderMeta();
    renderPlayState();
    renderVolume();
    renderProgress();
    renderStats();
    renderRate();
    renderQuality();
    syncUpNext();
  }

  /* --- Reloj ------------------------------------------------------------- */

  /**
   * Arranca el bucle SOLO si no hay uno vivo: es la garantía de que
   * `play()` estando ya reproduciendo no acumula frames ni timers.
   */
  function startClock() {
    if (rafId) return;
    lastTs = 0; // el primer fotograma sólo sirve para calibrar el delta
    rafId = global.requestAnimationFrame(tick);
  }

  function stopClock() {
    if (rafId) global.cancelAnimationFrame(rafId);
    rafId = 0;
    lastTs = 0;
  }

  function tick() {
    // Se libera el handle ANTES de todo: cualquier `play()`/`load()` llamado
    // desde dentro de este frame puede abrir su propio bucle sin duplicar.
    rafId = 0;

    if (!state.playing) {
      lastTs = 0;
      return;
    }

    var now = nowMs();
    if (lastTs === 0) {
      lastTs = now;
      rafId = global.requestAnimationFrame(tick);
      return;
    }

    var dt = (now - lastTs) / 1000;
    lastTs = now;
    // Un frame muy largo (pestaña en segundo plano, portátil dormido) no debe
    // saltarse media hora de episodio de golpe.
    if (dt > 1) dt = 1;

    advance(dt);

    if (state.playing && !rafId) rafId = global.requestAnimationFrame(tick);
  }

  /**
   * Avanza el tiempo y mantiene la UI. A 60 fps sólo se mueve la barra;
   * stats y avisos van limitados a 4/s.
   *
   * @param {number} seconds delta ya multiplicado por el ritmo.
   */
  function advance(seconds) {
    var dur = duration();
    state.time += seconds * state.rate;

    if (state.time >= dur) {
      autoAdvance();
      return;
    }

    renderProgress();

    var now = nowMs();
    if (now - lastStatsAt >= STATS_INTERVAL) {
      lastStatsAt = now;
      renderStats();
      syncUpNext();
      notify();
    }
  }

  /** Fin de episodio: pasa al siguiente y sigue reproduciendo. */
  function autoAdvance() {
    var ep = state.episode;
    var next = ep ? getNextEpisode(ep.id) : null;

    if (next && ep && next.id !== ep.id) {
      // `load` deja time=0 en pausa y detiene el reloj; `play` lo relanza.
      load(next.id);
      play();
      return;
    }

    // Sin siguiente posible: paramos EXACTAMENTE al final, sin bucle infinito.
    state.time = duration();
    pause();
  }

  /* --- API: reproducción ------------------------------------------------- */

  function play() {
    if (!state.episode) return; // sin episodio cargado no hay nada que mover

    if (state.playing) {
      // Ya está reproduciéndose: no creamos un segundo bucle.
      if (!rafId) startClock();
      return;
    }

    state.playing = true;
    // Un play explícito cancela la reanudación pendiente de la pestaña:
    // la última decisión del usuario (aunque sea con la pestaña oculta)
    // es la que manda.
    pausedByVisibility = false;
    renderPlayState();
    startClock();
    notify();
  }

  function pause() {
    if (!state.playing) return;
    state.playing = false;
    // Una pausa explícita cancela cualquier reanudación pendiente.
    pausedByVisibility = false;
    stopClock();
    renderPlayState();
    notify();
  }

  function toggle() {
    if (state.playing) pause();
    else play();
  }

  /**
   * @param {number} seconds destino en segundos.
   * @returns {number} posición resultante, recortada y redondeada.
   */
  function seek(seconds) {
    var dur = duration();
    var value = Number(seconds);
    if (!isFinite(value)) value = 0;
    value = Math.round(clamp(value, 0, dur));
    state.time = value;

    renderProgress();
    renderStats();
    syncUpNext();
    notify();
    return value;
  }

  /**
   * @param {number} delta segundos a sumar (negativo = retroceder).
   * @returns {number}
   */
  function seekBy(delta) {
    var step = Number(delta);
    if (!isFinite(step)) step = 0;
    return seek(state.time + step);
  }

  /* --- API: volumen ------------------------------------------------------ */

  /**
   * @param {number} value 0-100.
   * @returns {number} volumen resultante.
   */
  function setVolume(value) {
    var parsed = Number(value);
    if (!isFinite(parsed)) parsed = state.volume;
    parsed = Math.round(clamp(parsed, 0, 100));

    if (parsed > 0) {
      state.lastVolume = parsed;
      // Subir el volumen con el silencio puesto lo DESACTIVA: sería absurdo
      // mover el slider y no oír nada.
      if (state.muted) state.muted = false;
    } else {
      state.muted = true; // 0 es silencio efectivo
    }

    state.volume = parsed;
    renderVolume();
    notify();
    return parsed;
  }

  function toggleMute() {
    if (state.muted) {
      state.muted = false;
      // Si se silenció bajando el slider a 0, hay que restaurar el último
      // volumen audible; si no, el "des-silencio" no cambiaría nada.
      if (state.volume <= 0) state.volume = state.lastVolume > 0 ? state.lastVolume : FALLBACK_VOLUME;
    } else {
      if (state.volume > 0) state.lastVolume = state.volume;
      state.muted = true;
    }

    renderVolume();
    notify();
  }

  /* --- API: subtítulos, velocidad, calidad ------------------------------- */

  function toggleCaptions() {
    state.captions = !state.captions;
    renderCaptions();
    notify();
  }

  /**
   * @param {number} rate ritmo (0,5 … 2).
   * @returns {number} ritmo aplicado.
   */
  function setRate(rate) {
    var value = Number(rate);
    if (!isFinite(value)) return state.rate;
    value = Math.round(clamp(value, MIN_RATE, MAX_RATE) * 100) / 100;
    state.rate = value;
    renderRate();
    notify();
    return value;
  }

  /**
   * @param {string} quality identificador del `[data-quality]`.
   */
  function setQuality(quality) {
    if (!quality) return;
    if (quality === state.quality) {
      // Aunque no cambie se repinta: `aria-checked` debe ser correcto.
      renderQuality();
      return;
    }
    state.quality = quality;
    renderQuality();
    notify();
  }

  /* --- API: pantalla completa -------------------------------------------- */

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function requestFullscreen(target) {
    var fn = target.requestFullscreen || target.webkitRequestFullscreen;
    if (!fn) return null;
    return fn.call(target);
  }

  function exitFullscreen() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn) return null;
    return fn.call(document);
  }

  function toggleFullscreen() {
    var frame = el.videoFrame;
    if (!frame) return;

    var result = null;
    try {
      result = fullscreenElement() ? exitFullscreen() : requestFullscreen(frame);
    } catch (err) {
      // NotAllowedError / SecurityError (requisito de gesto del usuario,
      // iframe sin permisos…): no cambiamos NADA; la interfaz queda como
      // estaba y sin estado inconsistente.
      return;
    }
    if (!result) return; // soporte ausente: mismo criterio, nada que reparar.

    if (typeof result.catch === 'function') {
      // La promesa de fullscreen se rechaza con el mismo NotAllowedError.
      // `fullscreenchange` es el único que manda sobre el estado.
      result.catch(function () {
        /* Permiso denegado: silencio, la UI sigue coherente. */
      });
    }
  }

  /** Sincroniza estado, clases y etiqueta con lo que diga el navegador. */
  function syncFullscreen() {
    var active = !!fullscreenElement();
    var changed = active !== state.fullscreen;
    state.fullscreen = active;

    if (el.videoFrame) setClass(el.videoFrame, 'is-fullscreen', active);
    if (el.fsBtn) {
      setClass(el.fsBtn, 'is-fullscreen', active);
      el.fsBtn.setAttribute('aria-label', active ? 'Salir de pantalla completa' : 'Pantalla completa');
    }

    if (changed) notify();
  }

  /* --- API: cargar episodio ---------------------------------------------- */

  /**
   * @param {string} episodeId
   * @returns {boolean} true si se cargó (false si el id no existe: nada cambia).
   */
  function load(episodeId) {
    var ep = getEpisode(episodeId);
    if (!ep) return false;

    stopClock();
    state.episode = ep;
    state.playing = false;
    state.time = 0;
    state.buffered = 0.06; // episodio recién abierto: casi sin cachear
    lastStatsAt = 0;

    renderAll();
    notify();
    return true;
  }

  /* --- Menú de ajustes --------------------------------------------------- */

  function settingsOpen() {
    return !!el.settingsMenu && !el.settingsMenu.hidden;
  }

  /**
   * Abre el menú avisando ANTES a los demás menús.
   *
   * El orden importa: se despacha `tema-ui:close-menus` mientras el nuestro
   * sigue oculto, porque nuestro propio listener se ejecuta en este mismo
   * tick y cerraría lo que acabamos de abrir. Después lo mostramos.
   */
  function openSettings() {
    if (!el.settingsMenu || !el.settingsBtn) return;
    dispatchCloseMenus();
    el.settingsMenu.hidden = false;
    el.settingsBtn.setAttribute('aria-expanded', 'true');
  }

  /**
   * @param {boolean} restoreFocus devuelve el foco al botón (patrón menú-button).
   */
  function closeSettings(restoreFocus) {
    if (!el.settingsMenu) return;
    el.settingsMenu.hidden = true;
    if (el.settingsBtn) {
      el.settingsBtn.setAttribute('aria-expanded', 'false');
      if (restoreFocus && typeof el.settingsBtn.focus === 'function') el.settingsBtn.focus();
    }
  }

  function dispatchCloseMenus() {
    var event;
    if (typeof global.CustomEvent === 'function') {
      event = new global.CustomEvent(CLOSE_MENUS_EVENT);
    } else {
      // Respaldo antiguo: mismo nombre, mismas características.
      event = document.createEvent('CustomEvent');
      event.initCustomEvent(CLOSE_MENUS_EVENT, false, false, undefined);
    }
    document.dispatchEvent(event);
  }

  /* --- Enlaces con el DOM ------------------------------------------------ */

  /**
   * Enlaza un evento UNA sola vez por clave. Permite que `init()` se llame
   * varias veces (app.js) sin duplicar listeners.
   *
   * @param {string} key clave única del enlace.
   * @param {EventTarget|null} target nodo ya comprobado.
   * @param {string} type tipo de evento.
   * @param {Function} handler
   */
  function once(key, target, type, handler) {
    if (!target || bound[key]) return;
    target.addEventListener(type, handler);
    bound[key] = true;
  }

  /**
   * Recoge todos los nodos con `getElementById` literal: si un id no existe
   * la variable queda `null` y el uso correspondiente sale con su guard,
   * sin abortar el resto del enlazado.
   */
  function collect() {
    el.videoFrame = document.getElementById('videoFrame');
    el.videoCanvas = document.getElementById('videoCanvas');
    el.videoArt = document.getElementById('videoArt');
    el.videoCode = document.getElementById('videoCode');
    el.videoTag = document.getElementById('videoTag');
    el.videoCaptions = document.getElementById('videoCaptions');
    el.playOverlay = document.getElementById('playOverlay');
    el.playBtn = document.getElementById('playBtn');
    el.muteBtn = document.getElementById('muteBtn');
    el.volumeInput = document.getElementById('volumeInput');
    el.timeCurrent = document.getElementById('timeCurrent');
    el.timeTotal = document.getElementById('timeTotal');
    el.rateChip = document.getElementById('rateChip');
    el.ccBtn = document.getElementById('ccBtn');
    el.settingsBtn = document.getElementById('settingsBtn');
    el.settingsMenu = document.getElementById('settingsMenu');
    el.fsBtn = document.getElementById('fsBtn');
    el.progress = document.getElementById('progress');
    el.progressInput = document.getElementById('progressInput');
    el.progressPlayed = document.getElementById('progressPlayed');
    el.progressBuffered = document.getElementById('progressBuffered');
    el.seekTooltip = document.getElementById('seekTooltip');
    el.nowPlayingTitle = document.getElementById('nowPlayingTitle');
    el.metaDesc = document.getElementById('metaDesc');
    el.metaSeries = document.getElementById('metaSeries');
    el.metaSeason = document.getElementById('metaSeason');
    el.statDuration = document.getElementById('statDuration');
    el.statRemaining = document.getElementById('statRemaining');
    el.statProgress = document.getElementById('statProgress');
    el.upNextList = document.getElementById('upNextList');
    // Contenedor del menú (existe en index.html): los clics dentro cuentan
    // como "dentro" a la hora de cerrar por clic fuera.
    el.settingsRoot = document.querySelector('.settings');
  }

  /** Estado inicial coherente con los valores por defecto de data.js. */
  function setupInitialState() {
    if (initialDone) return;
    initialDone = true;

    var first = null;
    if (typeof data.getEpisode === 'function' && typeof data.DEFAULT_ID === 'string') {
      first = data.getEpisode(data.DEFAULT_ID);
    }
    if (!first && data.EPISODES && data.EPISODES.length) first = data.EPISODES[0];

    state.episode = first || null;
    state.time = typeof data.DEFAULT_TIME === 'number' ? data.DEFAULT_TIME : 872;
    state.volume = typeof data.DEFAULT_VOLUME === 'number' ? data.DEFAULT_VOLUME : 70;
    state.lastVolume = state.volume > 0 ? state.volume : FALLBACK_VOLUME;
    state.buffered = typeof data.DEFAULT_BUFFERED === 'number' ? data.DEFAULT_BUFFERED : 0.62;
    state.muted = state.volume <= 0;
    // Sin episodio no hay duración posible: no dejamos un tiempo huérfano.
    if (!state.episode) state.time = 0;
  }

  /** Todas las acciones de la interfaz. Cada enlace con su guard. */
  function bindControls() {
    if (el.playBtn) once('playBtn', el.playBtn, 'click', toggle);
    if (el.playOverlay) once('playOverlay', el.playOverlay, 'click', toggle);
    if (el.muteBtn) once('muteBtn', el.muteBtn, 'click', toggleMute);
    if (el.ccBtn) once('ccBtn', el.ccBtn, 'click', toggleCaptions);
    if (el.fsBtn) once('fsBtn', el.fsBtn, 'click', toggleFullscreen);

    if (el.settingsBtn) {
      once('settingsBtn', el.settingsBtn, 'click', function () {
        if (settingsOpen()) closeSettings(false);
        else openSettings();
      });
    }

    if (el.volumeInput) {
      once('volumeInput', el.volumeInput, 'input', function (event) {
        if (syncingVolume) return; // escritura propia, no un gesto del usuario
        setVolume(event.target.value);
      });
    }

    if (el.progressInput) {
      once('progressInput', el.progressInput, 'input', function (event) {
        if (syncing) return; // escritura propia: no hay reentrada en el seek
        setClass(el.videoFrame, 'is-seeking', true);
        seek(event.target.value);
      });
      // `change` llega al soltar: se retira el estado de arrastre.
      once('progressChange', el.progressInput, 'change', function () {
        setClass(el.videoFrame, 'is-seeking', false);
      });
      once('progressDown', el.progressInput, 'pointerdown', function () {
        setClass(el.videoFrame, 'is-seeking', true);
      });
    }

    if (el.progress) {
      once('progressMove', el.progress, 'pointermove', showSeekTooltip);
      once('progressLeave', el.progress, 'pointerleave', hideSeekTooltip);
    }

    var menu = el.settingsMenu;
    if (menu) {
      var rates = menu.querySelectorAll('[data-rate]');
      for (var i = 0; i < rates.length; i += 1) {
        /* jshint loopfunc:true */
        (function (button) {
          once('rate:' + button.getAttribute('data-rate'), button, 'click', function () {
            setRate(parseFloat(button.getAttribute('data-rate')));
          });
        })(rates[i]);
      }

      var qualities = menu.querySelectorAll('[data-quality]');
      for (var j = 0; j < qualities.length; j += 1) {
        /* jshint loopfunc:true */
        (function (button) {
          once('quality:' + button.getAttribute('data-quality'), button, 'click', function () {
            setQuality(button.getAttribute('data-quality'));
          });
        })(qualities[j]);
      }
    }
  }

  /** Listeners globales (document): todos idempotentes vía `once`. */
  function bindDocument() {
    // Coordinación de menús: otro módulo abre SU menú y el nuestro se cierra.
    once('closeMenus', document, CLOSE_MENUS_EVENT, function () {
      closeSettings(false);
    });

    // Clic fuera. Se comprueba contra el contenedor, no contra el menú, para
    // que pulsar el propio botón no cuente como "fuera".
    once('outsideClick', document, 'click', function (event) {
      if (!settingsOpen()) return;
      if (el.settingsRoot && el.settingsRoot.contains(event.target)) return;
      // Sólo devolvemos el foco si seguía dentro del menú.
      closeSettings(el.settingsMenu.contains(document.activeElement));
    });

    // Escape cierra y devuelve el foco. Va en `document` para cubrir también
    // el caso de salir del menú con Tab. Sin stopPropagation: otros módulos
    // (temas, ayuda) escuchan Escape en el mismo nodo.
    once('escape', document, 'keydown', function (event) {
      if (event.key !== 'Escape' || !settingsOpen()) return;
      closeSettings(true);
    });

    once('pointerUp', document, 'pointerup', function () {
      setClass(el.videoFrame, 'is-seeking', false);
    });

    // El navegador es quien manda sobre pantalla completa.
    once('fullscreen', document, 'fullscreenchange', syncFullscreen);
    once('webkitFullscreen', document, 'webkitfullscreenchange', syncFullscreen);

    // Pausa al ocultar la pestaña; reanuda al volver SOLO si la pausamos
    // nosotros (ver comentario de `pausedByVisibility`).
    once('visibility', document, 'visibilitychange', function () {
      if (document.hidden) {
        if (state.playing) {
          // Se pausa PRIMERO y se marca después: `pause()` borra la marca
          // (es una pausa explícita) y aquí queremos que quede como pausa
          // de pestaña, reanudable al volver.
          pause();
          pausedByVisibility = true;
        }
      } else if (pausedByVisibility) {
        pausedByVisibility = false;
        play();
      }
    });
  }

  /* --- Tooltip de la barra ----------------------------------------------- */

  /**
   * Posición del tooltip calculada con el rectángulo del `input` y NO con
   * `event.offsetX`: el área de clic del range es MAYOR que la pista visible
   * (los márgenes laterales siguen siendo clicables), así que `offsetX`
   * desplazaría el tooltip fuera de sitio.
   *
   * @param {MouseEvent} event
   */
  function showSeekTooltip(event) {
    if (!el.progressInput) return;

    var rect = el.progressInput.getBoundingClientRect();
    if (!rect.width) return;

    var ratio = (event.clientX - rect.left) / rect.width;
    ratio = clamp(ratio, 0, 1);

    // Se refresca `max`/`value` ANTES de pintar por si hubiera cambiado el
    // episodio (carga, fin automático): el tooltip debe usar la duración nueva.
    var dur = duration();
    syncing = true;
    el.progressInput.max = String(dur);
    el.progressInput.value = String(Math.round(clamp(state.time, 0, dur)));
    syncing = false;

    if (!el.seekTooltip) return;
    el.seekTooltip.textContent = fmt(ratio * dur);
    // `.progress` es el posicionado (position: relative), por eso el porcentaje.
    el.seekTooltip.style.left = ratio * 100 + '%';
    el.seekTooltip.hidden = false;
  }

  function hideSeekTooltip() {
    if (el.seekTooltip) el.seekTooltip.hidden = true;
  }

  /* --- API ---------------------------------------------------------------- */

  /**
   * Enlaza la interfaz. Idempotente: puede llamarse dos veces sin duplicar
   * listeners, y si el DOM llegara tarde se reintenta en la siguiente llamada.
   */
  function init() {
    collect();
    setupInitialState();
    renderAll();
    syncFullscreen();

    bindControls();

    // Con el DOM a medio montar no cerramos la puerta: otro `init()` posterior
    // (con los nodos ya presentes) podrá enlazar lo que falte.
    if (!el.playBtn || !el.progressInput) return;

    bindDocument();
  }

  TemaUI.player = {
    init: init,
    play: play,
    pause: pause,
    toggle: toggle,
    seek: seek,
    seekBy: seekBy,
    setVolume: setVolume,
    toggleMute: toggleMute,
    toggleCaptions: toggleCaptions,
    setRate: setRate,
    toggleFullscreen: toggleFullscreen,
    load: load,
    getState: getState,
    onChange: onChange,
  };
})(window);
