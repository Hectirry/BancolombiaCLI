/**
 * Registro de visitas a PDV (punto de venta) — Google Apps Script.
 *
 * Qué registra por cada PDV y marca:
 *   - Marca (Savital, Dove, Sedal, Nutribella, Alma de Romero)
 *   - Si hay presencia de la marca o no
 *   - Si hay presencia: qué ofertas se negociaron (varias posibles; "Ninguna" si no
 *     se negoció ninguna). Se guardan juntas en una celda, separadas por coma.
 *   - Las marcas sin promo (columna "Con promo" = No en Config) solo registran presencia;
 *     si están presentes, la oferta queda en "No aplica".
 *
 * Instalación: abre una hoja de cálculo de Google → Extensiones → Apps Script,
 * pega este archivo como Code.gs y Sidebar.html como archivo HTML, guarda y
 * recarga la hoja. Aparecerá el menú "PDV".
 */

var CONFIG = {
  HOJA_CONFIG: 'Config',
  HOJA_REGISTROS: 'Registros',
  HOJA_RESUMEN: 'Resumen',
  HOJA_RESPUESTAS_FORM: 'Respuestas Form',

  MARCAS_INICIALES: ['Savital', 'Dove', 'Sedal', 'Nutribella', 'Alma de Romero'],
  // Marcas que no manejan promociones. Valor inicial de la columna "Con promo" de Config.
  MARCAS_SIN_PROMO_INICIALES: ['Nutribella', 'Alma de Romero'],
  // Columna de Config con "Sí"/"No" por marca (A = marca, B = ofertas, C = con promo).
  COL_CONFIG_PROMO: 3,
  OFERTAS_INICIALES: [
    '2x1',
    'Pague 2 lleve 3',
    'Descuento 20%',
    'Combo shampoo + acondicionador',
    'Regalo por compra'
  ],

  ENCABEZADOS: [
    'Fecha',
    'Código PDV',
    'Marca',
    'Presencia',
    'Oferta negociada',
    'Registrado por',
    'Marca de tiempo',
    'ID envío'
  ],

  // Índices de columna (1 = A) en la hoja Registros.
  COL: {
    FECHA: 1,
    PDV: 2,
    MARCA: 3,
    PRESENCIA: 4,
    OFERTA: 5,
    USUARIO: 6,
    TIMESTAMP: 7,
    ID: 8
  },

  // Oferta cuando la marca no tiene presencia.
  SIN_OFERTA: '—',
  // Oferta cuando hay presencia pero no se negoció ninguna.
  NINGUNA: 'Ninguna',
  // Separador cuando una marca tiene varias ofertas en la misma celda.
  SEPARADOR_OFERTAS: ', ',
  // Oferta de una marca presente que no maneja promociones.
  NO_APLICA: 'No aplica'
};

function esMismaMarca(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Marcas sin promo según la columna "Con promo" de Config ("No" = sin promo).
 * Si la celda de una marca está vacía se usa CONFIG.MARCAS_SIN_PROMO_INICIALES.
 * @return {string[]}
 */
function marcasSinPromo() {
  var config = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.HOJA_CONFIG);
  var porDefecto = function (m) {
    return CONFIG.MARCAS_SIN_PROMO_INICIALES.some(function (x) { return esMismaMarca(x, m); });
  };
  if (!config || config.getLastRow() < 2) return leerLista('marcas').filter(porDefecto);
  var lista = [];
  config.getRange(2, 1, config.getLastRow() - 1, CONFIG.COL_CONFIG_PROMO).getValues().forEach(function (f) {
    var marca = String(f[0]).trim();
    if (!marca) return;
    var valor = String(f[CONFIG.COL_CONFIG_PROMO - 1]).trim();
    if (valor ? !esSi(valor) : porDefecto(marca)) lista.push(marca);
  });
  return lista;
}

/** true si la marca maneja promociones. */
function tienePromo(marca, sinPromo) {
  return !(sinPromo || marcasSinPromo()).some(function (x) { return esMismaMarca(x, marca); });
}

/**
 * Si Config todavía no tiene la columna "Con promo", la crea con Sí/No por marca.
 * @return {boolean} true si la acaba de crear.
 */
function prepararConfig() {
  var config = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.HOJA_CONFIG);
  if (!config) return false;
  var col = CONFIG.COL_CONFIG_PROMO;
  if (String(config.getRange(1, col).getValue()).trim() !== '') return false;
  config.getRange(1, col).setValue('Con promo').setFontWeight('bold');
  var n = config.getLastRow() - 1;
  if (n > 0) {
    config.getRange(2, col, n, 1).setValues(config.getRange(2, 1, n, 1).getValues().map(function (f) {
      var marca = String(f[0]).trim();
      if (!marca) return [''];
      var sin = CONFIG.MARCAS_SIN_PROMO_INICIALES.some(function (x) { return esMismaMarca(x, marca); });
      return [sin ? 'No' : 'Sí'];
    }));
  }
  config.getRange(2, col, Math.max(config.getMaxRows() - 1, 1), 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Sí', 'No'], true).setAllowInvalid(false).build()
  );
  return true;
}

/**
 * Ofertas negociadas de una marca, limpias y sin repetir. Acepta una lista o el
 * texto de una celda ("2x1, Descuento 20%"). "Ninguna" solo queda si es la única.
 * @param {string[]|string} valor
 * @return {string[]}
 */
function normalizarOfertas(valor) {
  var lista = Array.isArray(valor) ? valor : String(valor == null ? '' : valor).split(',');
  var vistas = {};
  var limpias = [];
  lista.forEach(function (o) {
    // La coma separa ofertas en la celda, así que no puede ir dentro de una.
    var t = String(o == null ? '' : o).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t === CONFIG.SIN_OFERTA || vistas[t.toLowerCase()]) return;
    vistas[t.toLowerCase()] = true;
    limpias.push(t);
  });
  var reales = limpias.filter(function (o) { return o !== CONFIG.NINGUNA; });
  return reales.length ? reales : limpias;
}

/** true si el texto es "Sí"/"Si" (sin importar mayúsculas). */
function esSi(v) {
  var t = String(v == null ? '' : v).trim().toLowerCase();
  return t === 'sí' || t === 'si' || v === true;
}

// Se pone en true cuando prepararRegistros() crea o limpia la hoja.
var REGISTROS_RECREADOS = false;

/**
 * Deja la hoja Registros con los encabezados actuales. Si tiene el formato
 * anterior (con Unidades) y ya tiene datos, la renombra para no perderlos y
 * crea una hoja Registros nueva.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function prepararRegistros() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName(CONFIG.HOJA_REGISTROS);
  var n = CONFIG.ENCABEZADOS.length;

  if (hoja && hoja.getLastRow() > 0) {
    var actuales = hoja.getRange(1, 1, 1, Math.max(hoja.getLastColumn(), n)).getValues()[0]
      .map(function (v) { return String(v).trim(); });
    var iguales = CONFIG.ENCABEZADOS.every(function (h, i) { return actuales[i] === h; }) &&
      actuales.slice(n).every(function (v) { return v === ''; });
    if (iguales) return hoja;

    if (hoja.getLastRow() > 1) {
      // Formato anterior con datos: se conserva aparte.
      var nombre = CONFIG.HOJA_REGISTROS + ' (formato anterior)';
      var k = 2;
      while (ss.getSheetByName(nombre)) nombre = CONFIG.HOJA_REGISTROS + ' (formato anterior ' + (k++) + ')';
      hoja.setName(nombre);
      hoja = null;
    } else {
      // Solo encabezados viejos: se limpia la hoja.
      hoja.clear();
      hoja.getRange(1, 1, hoja.getMaxRows(), hoja.getMaxColumns()).clearDataValidations();
    }
  }

  if (!hoja) hoja = ss.insertSheet(CONFIG.HOJA_REGISTROS);
  REGISTROS_RECREADOS = true;
  hoja.getRange(1, 1, 1, n)
    .setValues([CONFIG.ENCABEZADOS])
    .setFontWeight('bold')
    .setBackground('#efefef');
  hoja.setFrozenRows(1);
  hoja.setColumnWidth(CONFIG.COL.PDV, 160);
  hoja.setColumnWidth(CONFIG.COL.OFERTA, 240);
  return hoja;
}

// ---------------------------------------------------------------------------
// Menú
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('PDV')
    .addItem('Registrar visita', 'mostrarFormulario')
    .addItem('Actualizar resumen', 'generarResumen')
    .addItem('Consultar un PDV', 'consultarPDV')
    .addSeparator()
    .addItem('Configurar hojas (primera vez)', 'configurarHojas')
    .addItem('Crear formulario de Google (celular)', 'crearFormularioGoogle')
    .addToUi();
}

// ---------------------------------------------------------------------------
// Configuración inicial
// ---------------------------------------------------------------------------

function configurarHojas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Hoja Config: columna A marcas, columna B ofertas. Se puede editar a mano.
  var config = ss.getSheetByName(CONFIG.HOJA_CONFIG);
  if (!config) {
    config = ss.insertSheet(CONFIG.HOJA_CONFIG);
    config.getRange(1, 1, 1, 2).setValues([['Marcas', 'Ofertas']]).setFontWeight('bold');
    config.getRange(2, 1, CONFIG.MARCAS_INICIALES.length, 1)
      .setValues(CONFIG.MARCAS_INICIALES.map(function (m) { return [m]; }));
    config.getRange(2, 2, CONFIG.OFERTAS_INICIALES.length, 1)
      .setValues(CONFIG.OFERTAS_INICIALES.map(function (o) { return [o]; }));
    config.setColumnWidth(1, 180);
    config.setColumnWidth(2, 260);
    config.setFrozenRows(1);
  }
  prepararConfig();

  // Hoja Registros: una fila por PDV + marca + visita.
  var registros = prepararRegistros();
  aplicarValidaciones();

  // Hoja Resumen.
  if (!ss.getSheetByName(CONFIG.HOJA_RESUMEN)) {
    ss.insertSheet(CONFIG.HOJA_RESUMEN);
  }
  generarResumen();

  // Dejar la hoja de registros al frente.
  ss.setActiveSheet(registros);
  SpreadsheetApp.getUi().alert('Hojas listas. Usa el menú PDV → Registrar visita.');
}

/**
 * Listas desplegables en Registros: Marca y Presencia.
 * Se vuelve a ejecutar cada vez que se guarda una visita, para que los cambios
 * en la hoja Config se reflejen sin hacer nada más.
 */
function aplicarValidaciones() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var registros = ss.getSheetByName(CONFIG.HOJA_REGISTROS);
  if (!registros) return;

  var filas = Math.max(registros.getMaxRows() - 1, 1);
  var marcas = leerLista('marcas');

  registros.getRange(2, CONFIG.COL.MARCA, filas, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(marcas, true).setAllowInvalid(false).build()
  );
  registros.getRange(2, CONFIG.COL.PRESENCIA, filas, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Sí', 'No'], true).setAllowInvalid(false).build()
  );
  // Oferta negociada puede tener varias ofertas separadas por coma: sin lista desplegable.
  registros.getRange(2, CONFIG.COL.OFERTA, filas, 1).clearDataValidations();
}

/**
 * Lee la lista de marcas u ofertas desde la hoja Config.
 * @param {'marcas'|'ofertas'} tipo
 * @return {string[]}
 */
function leerLista(tipo) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var config = ss.getSheetByName(CONFIG.HOJA_CONFIG);
  var porDefecto = tipo === 'marcas' ? CONFIG.MARCAS_INICIALES : CONFIG.OFERTAS_INICIALES;
  if (!config || config.getLastRow() < 2) return porDefecto.slice();

  var col = tipo === 'marcas' ? 1 : 2;
  var valores = config.getRange(2, col, config.getLastRow() - 1, 1).getValues()
    .map(function (fila) { return String(fila[0]).trim(); })
    .filter(function (v) { return v !== ''; });
  return valores.length ? valores : porDefecto.slice();
}

// ---------------------------------------------------------------------------
// Formulario lateral (Sidebar.html)
// ---------------------------------------------------------------------------

function mostrarFormulario() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(CONFIG.HOJA_REGISTROS)) {
    configurarHojas();
  }
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Registrar visita a PDV')
    .setWidth(380);
  SpreadsheetApp.getUi().showSidebar(html);
}

/** Datos que necesita la barra lateral para armar el formulario. */
function obtenerDatosFormulario() {
  return {
    marcas: leerLista('marcas'),
    ofertas: leerLista('ofertas'),
    sinPromo: marcasSinPromo(),
    pdvs: listarPDVs(),
    hoy: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  };
}

/** Nombres de PDV ya registrados (para autocompletar). */
function listarPDVs() {
  var registros = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.HOJA_REGISTROS);
  if (!registros || registros.getLastRow() < 2) return [];
  var valores = registros.getRange(2, CONFIG.COL.PDV, registros.getLastRow() - 1, 1).getValues();
  var vistos = {};
  var lista = [];
  valores.forEach(function (fila) {
    var nombre = String(fila[0]).trim();
    if (nombre && !vistos[nombre.toLowerCase()]) {
      vistos[nombre.toLowerCase()] = true;
      lista.push(nombre);
    }
  });
  return lista.sort(function (a, b) { return a.localeCompare(b, 'es'); });
}

/**
 * Guarda una visita completa (varias marcas) como filas en Registros.
 * La usan la barra lateral (guardarVisita) y la web app (apiSubmit).
 *
 * Se guarda una fila por cada marca, tenga presencia o no.
 *
 * @param {{fecha: string, pdv: string, vendedor: string, idEnvio: string,
 *          marcas: {marca: string, presencia: boolean|string, ofertas: string[], oferta: string}[]}} datos
 *        `ofertas` es la lista de ofertas negociadas; `oferta` (una sola) se acepta por compatibilidad.
 * @return {{pdv: string, filas: number, conPresencia: number, conOferta: number, duplicado: boolean}}
 */
function registrarVisita(datos) {
  if (!datos || !datos.pdv || !String(datos.pdv).trim()) {
    throw new Error('Debes indicar el código del PDV.');
  }
  var pdv = String(datos.pdv).trim();
  var fecha = datos.fecha ? new Date(datos.fecha + 'T00:00:00') : new Date();
  if (isNaN(fecha.getTime())) throw new Error('La fecha no es válida.');

  var registros = prepararRegistros();

  // Reintentos desde el celular: si este envío ya está guardado, no se duplica.
  var idEnvio = String(datos.idEnvio || '').trim();
  if (idEnvio && registros.getLastRow() > 1) {
    var ids = registros.getRange(2, CONFIG.COL.ID, registros.getLastRow() - 1, 1).getValues();
    var yaExiste = ids.some(function (f) { return String(f[0]) === idEnvio; });
    if (yaExiste) return { pdv: pdv, filas: 0, conPresencia: 0, conOferta: 0, duplicado: true };
  }

  var filas = [];
  var usuario = String(datos.vendedor || '').trim() || Session.getActiveUser().getEmail() || '';
  var ahora = new Date();
  var conPresencia = 0;
  var conOferta = 0;
  var sinPromo = marcasSinPromo();

  (datos.marcas || []).forEach(function (m) {
    if (!m || !m.marca) return;
    var presencia = esSi(m.presencia);
    // Las marcas sin promo solo registran presencia: lo que llegue como oferta se ignora.
    var promo = tienePromo(m.marca, sinPromo);
    var ofertas = presencia && promo ? normalizarOfertas(Array.isArray(m.ofertas) ? m.ofertas : (m.oferta || '')) : [];
    if (presencia && promo && !ofertas.length) {
      throw new Error('Indica las ofertas negociadas para ' + m.marca + ' (o "' + CONFIG.NINGUNA + '").');
    }
    if (presencia) conPresencia++;
    if (presencia && promo && ofertas[0] !== CONFIG.NINGUNA) conOferta++;
    var celda = !presencia ? CONFIG.SIN_OFERTA : (promo ? ofertas.join(CONFIG.SEPARADOR_OFERTAS) : CONFIG.NO_APLICA);
    filas.push([fecha, pdv, m.marca, presencia ? 'Sí' : 'No', celda, usuario, ahora, idEnvio]);
  });

  if (!filas.length) {
    throw new Error('No hay marcas para guardar.');
  }

  var inicio = registros.getLastRow() + 1;
  // El código del PDV va como texto: así "0042" no pierde los ceros ni "1" se vuelve número.
  registros.getRange(inicio, CONFIG.COL.PDV, filas.length, 1).setNumberFormat('@');
  registros.getRange(inicio, 1, filas.length, filas[0].length).setValues(filas);
  registros.getRange(inicio, CONFIG.COL.FECHA, filas.length, 1).setNumberFormat('yyyy-mm-dd');
  registros.getRange(inicio, CONFIG.COL.TIMESTAMP, filas.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  aplicarValidaciones();
  generarResumen();

  return { pdv: pdv, filas: filas.length, conPresencia: conPresencia, conOferta: conOferta, duplicado: false };
}

/** Versión para la barra lateral: devuelve un mensaje de texto. */
function guardarVisita(datos) {
  var r = registrarVisita(datos);
  if (r.duplicado) return 'Esta visita ya estaba guardada.';
  return 'Guardado PDV "' + r.pdv + '": presencia en ' + r.conPresencia + ' de ' + r.filas +
    ' marca(s), oferta negociada en ' + r.conOferta + '.';
}

// ---------------------------------------------------------------------------
// Edición manual en la hoja Registros
// ---------------------------------------------------------------------------

/**
 * Mantiene coherencia entre "Presencia" y "Oferta negociada" cuando se edita a mano.
 * Trigger simple: se ejecuta solo con este archivo instalado en la hoja.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  var hoja = e.range.getSheet();
  if (hoja.getName() !== CONFIG.HOJA_REGISTROS || e.range.getRow() < 2) return;

  var col = e.range.getColumn();
  var fila = e.range.getRow();

  if (col === CONFIG.COL.PRESENCIA) {
    var valor = String(e.value || '').trim();
    var oferta = hoja.getRange(fila, CONFIG.COL.OFERTA);
    if (valor === 'No') {
      oferta.setValue(CONFIG.SIN_OFERTA);
    } else if (valor === 'Sí' && String(oferta.getValue()) === CONFIG.SIN_OFERTA) {
      var marca = hoja.getRange(fila, CONFIG.COL.MARCA).getValue();
      oferta.setValue(tienePromo(marca) ? CONFIG.NINGUNA : CONFIG.NO_APLICA);
    }
  } else if (col === CONFIG.COL.OFERTA) {
    var ofertaValor = String(e.value || '').trim();
    var celdaPresencia = hoja.getRange(fila, CONFIG.COL.PRESENCIA);
    if (ofertaValor && ofertaValor !== CONFIG.SIN_OFERTA && celdaPresencia.getValue() !== 'Sí') {
      celdaPresencia.setValue('Sí');
    }
  }

  if (col === CONFIG.COL.PRESENCIA || col === CONFIG.COL.OFERTA) {
    // Marca de tiempo de la última modificación de la fila.
    hoja.getRange(fila, CONFIG.COL.TIMESTAMP).setValue(new Date()).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
}

// ---------------------------------------------------------------------------
// Lectura y resumen
// ---------------------------------------------------------------------------

/**
 * Devuelve los registros como objetos.
 * @return {{fecha: Date, pdv: string, marca: string, presencia: boolean, oferta: string, id: string}[]}
 */
function leerRegistros() {
  var registros = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.HOJA_REGISTROS);
  if (!registros || registros.getLastRow() < 2) return [];
  var valores = registros.getRange(2, 1, registros.getLastRow() - 1, CONFIG.ENCABEZADOS.length).getValues();
  var C = CONFIG.COL;
  return valores
    .filter(function (f) { return String(f[C.PDV - 1]).trim() !== '' && String(f[C.MARCA - 1]).trim() !== ''; })
    .map(function (f) {
      var fecha = f[C.FECHA - 1];
      return {
        fecha: fecha instanceof Date ? fecha : (fecha ? new Date(fecha) : null),
        pdv: String(f[C.PDV - 1]).trim(),
        marca: String(f[C.MARCA - 1]).trim(),
        presencia: esSi(f[C.PRESENCIA - 1]),
        oferta: String(f[C.OFERTA - 1]).trim(),
        id: String(f[C.ID - 1] || '').trim()
      };
    });
}

/** Ofertas reales negociadas en un registro (sin "Ninguna", "No aplica" ni "—"). */
function ofertasReales(r) {
  if (!r.presencia) return [];
  return normalizarOfertas(r.oferta).filter(function (o) { return o !== CONFIG.NINGUNA && o !== CONFIG.NO_APLICA; });
}

/**
 * Agrupa por PDV + marca.
 * @return {Object[]} filas del resumen
 */
function calcularResumen(registros) {
  var ordenMarcas = leerLista('marcas');
  var sinPromo = marcasSinPromo();
  var grupos = {};

  registros.forEach(function (r) {
    var clave = r.pdv.toLowerCase() + '||' + r.marca.toLowerCase();
    if (!grupos[clave]) {
      grupos[clave] = {
        pdv: r.pdv,
        marca: r.marca,
        visitas: 0,
        presencia: 0,
        conOferta: 0,
        ofertas: {},
        sinPromo: !tienePromo(r.marca, sinPromo),
        ultimaVisita: null,
        ultimoResultado: ''
      };
    }
    var g = grupos[clave];
    g.visitas += 1;
    if (r.presencia) g.presencia += 1;
    var reales = ofertasReales(r);
    if (reales.length) {
      g.conOferta += 1;
      reales.forEach(function (o) { g.ofertas[o] = (g.ofertas[o] || 0) + 1; });
    }
    if (r.fecha && (!g.ultimaVisita || r.fecha >= g.ultimaVisita)) {
      g.ultimaVisita = r.fecha;
      g.ultimoResultado = !r.presencia ? 'Sin presencia'
        : (g.sinPromo ? 'Presente'
          : (reales.length ? 'Presente · ' + reales.join(CONFIG.SEPARADOR_OFERTAS) : 'Presente · sin oferta'));
    }
  });

  var indiceMarca = function (m) {
    var i = ordenMarcas.map(function (x) { return x.toLowerCase(); }).indexOf(m.toLowerCase());
    return i === -1 ? ordenMarcas.length : i;
  };

  return Object.keys(grupos).map(function (k) { return grupos[k]; }).sort(function (a, b) {
    var p = a.pdv.localeCompare(b.pdv, 'es');
    if (p !== 0) return p;
    return indiceMarca(a.marca) - indiceMarca(b.marca);
  });
}

function formatearOfertas(mapa) {
  return Object.keys(mapa)
    .sort(function (a, b) { return mapa[b] - mapa[a]; })
    .map(function (nombre) { return nombre + ' (' + mapa[nombre] + ')'; })
    .join(', ');
}

/** Reescribe la hoja Resumen: una fila por PDV y marca. */
function generarResumen() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName(CONFIG.HOJA_RESUMEN) || ss.insertSheet(CONFIG.HOJA_RESUMEN);
  hoja.clear();

  var encabezados = [
    'PDV', 'Marca', 'Visitas', 'Visitas con presencia', '% presencia',
    'Veces con oferta negociada', 'Ofertas negociadas (veces)', 'Última visita', 'Resultado última visita'
  ];
  hoja.getRange(1, 1, 1, encabezados.length).setValues([encabezados]).setFontWeight('bold').setBackground('#efefef');
  hoja.setFrozenRows(1);

  var resumen = calcularResumen(leerRegistros());
  if (!resumen.length) {
    hoja.getRange(2, 1).setValue('Aún no hay registros.');
    return;
  }

  var filas = resumen.map(function (g) {
    return [
      g.pdv,
      g.marca,
      g.visitas,
      g.presencia,
      g.visitas ? g.presencia / g.visitas : 0,
      g.sinPromo ? CONFIG.NO_APLICA : g.conOferta,
      g.sinPromo ? CONFIG.NO_APLICA : (formatearOfertas(g.ofertas) || '—'),
      g.ultimaVisita || '',
      g.ultimoResultado
    ];
  });
  hoja.getRange(2, 1, filas.length, encabezados.length).setValues(filas);
  // Formatos explícitos: la hoja puede traer formatos de una versión anterior.
  hoja.getRange(2, 3, filas.length, 2).setNumberFormat('0');
  hoja.getRange(2, 5, filas.length, 1).setNumberFormat('0%');
  hoja.getRange(2, 6, filas.length, 1).setNumberFormat('0');
  hoja.getRange(2, 8, filas.length, 1).setNumberFormat('yyyy-mm-dd');
  hoja.setColumnWidth(1, 200);
  hoja.setColumnWidth(7, 320);
  hoja.setColumnWidth(9, 220);
}

/** Pregunta un PDV y muestra su detalle por marca en un cuadro de diálogo. */
function consultarPDV() {
  var ui = SpreadsheetApp.getUi();
  var respuesta = ui.prompt('Consultar PDV', 'Nombre del PDV:', ui.ButtonSet.OK_CANCEL);
  if (respuesta.getSelectedButton() !== ui.Button.OK) return;
  var nombre = respuesta.getResponseText().trim().toLowerCase();
  if (!nombre) return;

  var registros = leerRegistros().filter(function (r) { return r.pdv.toLowerCase().indexOf(nombre) !== -1; });
  if (!registros.length) {
    ui.alert('No hay registros para un PDV que contenga "' + respuesta.getResponseText() + '".');
    return;
  }

  var resumen = calcularResumen(registros);
  var lineas = resumen.map(function (g) {
    var base = g.pdv + ' · ' + g.marca + ': presencia en ' + g.presencia + ' de ' + g.visitas + ' visita(s)';
    if (g.sinPromo) return base + ' (sin promo).';
    return base + '; oferta negociada ' + g.conOferta + ' vez/veces' +
      (g.conOferta ? ' [' + formatearOfertas(g.ofertas) + ']' : '') + '.';
  });
  ui.alert('Detalle del PDV', lineas.join('\n'), ui.ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// Formulario de Google (para registrar desde el celular)
// ---------------------------------------------------------------------------

/**
 * Crea un Google Form con una sección por marca, lo enlaza a esta hoja y
 * deja un trigger que copia cada respuesta a la hoja Registros.
 */
function crearFormularioGoogle() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(CONFIG.HOJA_REGISTROS)) configurarHojas();

  var marcas = leerLista('marcas');
  var ofertas = leerLista('ofertas');
  var sinPromo = marcasSinPromo();

  var form = FormApp.create('Visita PDV — ' + ss.getName());
  form.setDescription('Registra por cada marca si hay presencia y, si la hay, qué ofertas negociaste.');
  form.setCollectEmail(false);

  form.addDateItem().setTitle('Fecha de la visita').setRequired(true);
  form.addTextItem().setTitle('PDV').setHelpText('Código del punto de venta').setRequired(true);

  marcas.forEach(function (marca) {
    form.addSectionHeaderItem().setTitle(marca);
    form.addMultipleChoiceItem()
      .setTitle(marca + ' - ¿Hay presencia?')
      .setChoiceValues(['Sí', 'No'])
      .setRequired(true);
    if (!tienePromo(marca, sinPromo)) return;   // sin promo: solo presencia
    form.addCheckboxItem()
      .setTitle(marca + ' - ¿Qué ofertas negociaste?')
      .setHelpText('Solo si hay presencia. Puedes marcar varias.')
      .setChoiceValues(ofertas.concat([CONFIG.NINGUNA]));
  });

  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  // Trigger instalable: procesa cada envío del formulario.
  var yaExiste = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'procesarRespuestaFormulario';
  });
  if (!yaExiste) {
    ScriptApp.newTrigger('procesarRespuestaFormulario').forSpreadsheet(ss).onFormSubmit().create();
  }

  var ui = SpreadsheetApp.getUi();
  var html = HtmlService.createHtmlOutput(
    '<p>Formulario creado.</p>' +
    '<p>Enlace para responder (compártelo con el vendedor):<br>' +
    '<a href="' + form.getPublishedUrl() + '" target="_blank">' + form.getPublishedUrl() + '</a></p>' +
    '<p>Enlace para editar:<br><a href="' + form.getEditUrl() + '" target="_blank">' + form.getEditUrl() + '</a></p>'
  ).setWidth(520).setHeight(220);
  ui.showModalDialog(html, 'Formulario de Google listo');
}

/**
 * Trigger onFormSubmit (hoja de cálculo): convierte una respuesta del
 * formulario en filas de la hoja Registros, una por marca con datos.
 */
function procesarRespuestaFormulario(e) {
  if (!e || !e.namedValues) return;
  var nv = e.namedValues;
  var primero = function (clave) {
    var v = nv[clave];
    return v && v.length ? String(v[0]).trim() : '';
  };

  var pdv = primero('PDV');
  if (!pdv) return;

  var fechaTexto = primero('Fecha de la visita');
  var fecha = fechaTexto ? new Date(fechaTexto) : new Date();
  if (isNaN(fecha.getTime())) fecha = new Date();

  var sinPromo = marcasSinPromo();
  var marcasVisita = leerLista('marcas').map(function (marca) {
    return {
      marca: marca,
      promo: tienePromo(marca, sinPromo),
      presencia: esSi(primero(marca + ' - ¿Hay presencia?')),
      ofertas: normalizarOfertas(primero(marca + ' - ¿Qué ofertas negociaste?'))
    };
  });

  if (!marcasVisita.length) return;

  var filas = marcasVisita.map(function (m) {
    return [
      fecha,
      pdv,
      m.marca,
      m.presencia ? 'Sí' : 'No',
      !m.presencia ? CONFIG.SIN_OFERTA
        : (!m.promo ? CONFIG.NO_APLICA : (m.ofertas.length ? m.ofertas.join(CONFIG.SEPARADOR_OFERTAS) : CONFIG.NINGUNA)),
      primero('Dirección de correo electrónico') || 'Formulario',
      new Date(),
      ''
    ];
  });

  var registros = prepararRegistros();
  var inicio = registros.getLastRow() + 1;
  // El código del PDV va como texto: así "0042" no pierde los ceros ni "1" se vuelve número.
  registros.getRange(inicio, CONFIG.COL.PDV, filas.length, 1).setNumberFormat('@');
  registros.getRange(inicio, 1, filas.length, filas[0].length).setValues(filas);
  registros.getRange(inicio, CONFIG.COL.FECHA, filas.length, 1).setNumberFormat('yyyy-mm-dd');
  registros.getRange(inicio, CONFIG.COL.TIMESTAMP, filas.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  generarResumen();
}

// ---------------------------------------------------------------------------
// Encuesta web (aplicación web): Implementar → Nueva implementación → Aplicación web
// ---------------------------------------------------------------------------


function doGet() {
  var cfg = apiConfig();
  var html = HtmlService.createHtmlOutputFromFile('Index').getContent();
  // Las marcas y ofertas de la hoja Config las pide la página al cargar (apiConfig).
  return HtmlService.createHtmlOutput(html)
    .setTitle(cfg.titulo)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Marcas, ofertas y PDVs ya registrados. */
function apiConfig() {
  configurarHojasSilencioso();
  return {
    titulo: 'Visita PDV',
    equipo: 'Equipo de ventas',
    marcas: leerLista('marcas'),
    ofertas: leerLista('ofertas'),
    sinPromo: marcasSinPromo(),
    pdvs: listarPDVs()
  };
}

/**
 * Recibe la visita desde la web app, la guarda en Registros y devuelve el
 * acumulado del PDV para la pantalla de resultado.
 */
function apiSubmit(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    registrarVisita(payload);
  } finally {
    lock.releaseLock();
  }
  return apiResumenPDV(payload.pdv);
}

/** Acumulado histórico de un PDV, por marca. */
function apiResumenPDV(pdv) {
  var nombre = String(pdv || '').trim().toLowerCase();
  var registros = leerRegistros().filter(function (r) { return r.pdv.toLowerCase() === nombre; });
  var resumen = calcularResumen(registros);
  var sinPromo = marcasSinPromo();
  var porMarca = {};
  resumen.forEach(function (g) { porMarca[g.marca.toLowerCase()] = g; });

  var visitas = {};
  registros.forEach(function (r) { visitas[(r.fecha ? r.fecha.getTime() : '') + '|' + (r.id || '')] = 1; });

  return {
    pdv: String(pdv || '').trim(),
    visitas: Object.keys(visitas).length,
    marcas: leerLista('marcas').map(function (m) {
      var g = porMarca[m.toLowerCase()];
      var sin = !tienePromo(m, sinPromo);
      return g
        ? { marca: g.marca, visitas: g.visitas, presencia: g.presencia, conOferta: g.conOferta, ofertas: g.ofertas, sinPromo: sin }
        : { marca: m, visitas: 0, presencia: 0, conOferta: 0, ofertas: {}, sinPromo: sin };
    })
  };
}

/** Igual que configurarHojas() pero sin cuadros de diálogo (la web app no tiene UI de hoja). */
function configurarHojasSilencioso() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(CONFIG.HOJA_CONFIG)) {
    var config = ss.insertSheet(CONFIG.HOJA_CONFIG);
    config.getRange(1, 1, 1, 2).setValues([['Marcas', 'Ofertas']]).setFontWeight('bold');
    config.getRange(2, 1, CONFIG.MARCAS_INICIALES.length, 1).setValues(CONFIG.MARCAS_INICIALES.map(function (m) { return [m]; }));
    config.getRange(2, 2, CONFIG.OFERTAS_INICIALES.length, 1).setValues(CONFIG.OFERTAS_INICIALES.map(function (o) { return [o]; }));
  }
  var promoNueva = prepararConfig();
  prepararRegistros();
  if (!ss.getSheetByName(CONFIG.HOJA_RESUMEN)) ss.insertSheet(CONFIG.HOJA_RESUMEN);
  // Si se acaba de crear o limpiar Registros, o recién apareció "Con promo", el resumen viejo ya no aplica.
  if (REGISTROS_RECREADOS || promoNueva) {
    aplicarValidaciones();
    generarResumen();
  }
}
