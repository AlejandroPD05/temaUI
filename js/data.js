/**
 * Catálogo de StreamBox.
 *
 * Fuente única de verdad para el reproductor y la lista "A continuación".
 * Se publica en el espacio de nombres global `TemaUI` porque el proyecto no
 * usa módulos ES: así se abre directamente con doble clic (file://) sin
 * romper por la política CORS de los import.
 */
(function (global) {
  'use strict';

  var TemaUI = (global.TemaUI = global.TemaUI || {});

  /**
   * @typedef {Object} Episode
   * @property {string}  id          Identificador estable, usado como clave de estado.
   * @property {string}  series      Nombre de la serie (aparece en la ficha).
   * @property {number}  season      Temporada.
   * @property {number}  episode     Episodio dentro de la temporada.
   * @property {string}  title       Título del episodio, sin el código TxEy.
   * @property {number}  duration    Duración total en segundos.
   * @property {string}  description Sinopsis de una frase.
   * @property {string}  hue         Matiz CSS (0-360) de la que deriva la
   *                                  carátula procedural: sin imágenes no hay
   *                                  que descargar nada y cada episodio tiene
   *                                  una identidad cromática propia.
   * @property {string}  tag         Etiqueta corta de sección (documental, etc.).
   */
  var EPISODES = [
    {
      id: 'rs-s2e4',
      series: 'Rutas del Sur',
      season: 2,
      episode: 4,
      title: 'T2 E4',
      duration: 2530, // 42:10
      description:
        'Un recorrido por los caminos menos transitados, con paradas en pueblos que el mapa casi olvida.',
      hue: 152,
      tag: 'Documental',
    },
    {
      id: 'rs-s2e5',
      series: 'Rutas del Sur',
      season: 2,
      episode: 5,
      title: 'T2 E5 — El cruce',
      duration: 2680, // 44:40
      description:
        'Dos senderos se separan junto al río y la elección condiciona el resto de la temporada.',
      hue: 168,
      tag: 'Documental',
    },
    {
      id: 'rs-s2e6',
      series: 'Rutas del Sur',
      season: 2,
      episode: 6,
      title: 'T2 E6 — Marea baja',
      duration: 2415, // 40:15
      description:
        'La bajamar deja a la vista un puerto que solo se entiende dos días al mes.',
      hue: 196,
      tag: 'Documental',
    },
    {
      id: 'cc-s1e1',
      series: 'Caminos Cruzados',
      season: 1,
      episode: 1,
      title: 'T1 E1 — Punto de partida',
      duration: 2740, // 45:40
      description:
        'Tres familias abandonan la misma plaza a la misma hora, hacia destinos que no comparten.',
      hue: 28,
      tag: 'Serie',
    },
    {
      id: 'cc-s1e2',
      series: 'Caminos Cruzados',
      season: 1,
      episode: 2,
      title: 'T1 E2 — Altiplano',
      duration: 2905, // 48:25
      description:
        'A tres mil metros, la distancia se mide en horas de autobús y no en kilómetros.',
      hue: 44,
      tag: 'Serie',
    },
    {
      id: 'cc-s1e3',
      series: 'Caminos Cruzados',
      season: 1,
      episode: 3,
      title: 'T1 E3 — La última parada',
      duration: 2580, // 43:00
      description:
        'El conductor que lleva veinte años en la misma línea decide bajarse delante de cámara.',
      hue: 12,
      tag: 'Serie',
    },
    {
      id: 'ca-s1e1',
      series: 'Costa Adentro',
      season: 1,
      episode: 1,
      title: 'T1 E1 — Sal en la piel',
      duration: 2290, // 38:10
      description:
        'Una temporada con las salinas del sur, donde el trabajo se mide por la marea.',
      hue: 210,
      tag: 'Documental',
    },
    {
      id: 'ca-s1e2',
      series: 'Costa Adentro',
      season: 1,
      episode: 2,
      title: 'T1 E2 — Barco de apagón',
      duration: 2465, // 41:05
      description:
        'La pesca nocturna exige apagar cada luz: la cámara también se queda a oscuras.',
      hue: 232,
      tag: 'Documental',
    },
    {
      id: 'ca-s1e3',
      series: 'Costa Adentro',
      season: 1,
      episode: 3,
      title: 'T1 E3 — Reparaciones',
      duration: 2612, // 43:32
      description:
        'Reconstruir una lonja cerrada obliga a preguntar quién debe pagar el arreglo.',
      hue: 258,
      tag: 'Serie',
    },
  ];

  /** Episodio cargado al abrir la página (el del original). */
  var DEFAULT_ID = 'rs-s2e4';

  /** Posición inicial de reproducción, en segundos (14:32). */
  var DEFAULT_TIME = 872;

  /** Estado de reproducción inicial: progreso visto hasta el 62 %. */
  var DEFAULT_BUFFERED = 0.62;

  /** Volumen inicial, 0-100. */
  var DEFAULT_VOLUME = 70;

  /**
   * @param {string} id
   * @returns {Episode|undefined}
   */
  function getEpisode(id) {
    for (var i = 0; i < EPISODES.length; i += 1) {
      if (EPISODES[i].id === id) return EPISODES[i];
    }
    return undefined;
  }

  /**
   * Devuelve el siguiente episodio de la lista, en bucle.
   * @param {string} id
   * @returns {Episode}
   */
  function getNextEpisode(id) {
    var index = EPISODES.findIndex(function (episode) {
      return episode.id === id;
    });
    if (index === -1) return EPISODES[0];
    return EPISODES[(index + 1) % EPISODES.length];
  }

  /**
   * Filtrado de la lista "A continuación": casa por serie, título o
   * descripción, sin distinguir mayúsculas ni acentos, para que "caminos",
   * "Caminos" o "marea" encuentren lo esperado.
   *
   * @param {string} query
   * @param {string} [excludeId] Episodio en reproducción, que no debe listarse.
   * @returns {Episode[]}
   */
  function search(query, excludeId) {
    var needle = normalize(query);
    return EPISODES.filter(function (episode) {
      if (episode.id === excludeId) return false;
      if (!needle) return true;
      return (
        normalize(episode.series + ' ' + episode.title + ' ' + episode.description + ' ' + episode.tag).indexOf(
          needle
        ) !== -1
      );
    });
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function normalize(value) {
    return String(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  /**
   * Segundos → `m:ss` / `h:mm:ss`.
   *
   * @param {number} seconds
   * @returns {string}
   */
  function formatTime(seconds) {
    var safe = Math.max(0, Math.floor(seconds || 0));
    var hours = Math.floor(safe / 3600);
    var minutes = Math.floor((safe % 3600) / 60);
    var secs = safe % 60;
    var pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    return hours > 0 ? hours + ':' + pad(minutes) + ':' + pad(secs) : minutes + ':' + pad(secs);
  }

  TemaUI.data = {
    EPISODES: EPISODES,
    DEFAULT_ID: DEFAULT_ID,
    DEFAULT_TIME: DEFAULT_TIME,
    DEFAULT_BUFFERED: DEFAULT_BUFFERED,
    DEFAULT_VOLUME: DEFAULT_VOLUME,
    getEpisode: getEpisode,
    getNextEpisode: getNextEpisode,
    search: search,
    normalize: normalize,
    formatTime: formatTime,
  };
})(window);
