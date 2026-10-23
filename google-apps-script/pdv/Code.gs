/**
 * Registro de visitas a PDV (punto de venta) — Google Apps Script.
 *
 * Qué registra por cada PDV y marca:
 *   - Marca (Savital, Dove, Sedal, Nutribella, Alma de Romero)
 *   - Unidades
 *   - Si le vendió la oferta o no
 *   - Cuál oferta fue
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
    'Unidades',
    'Vendió oferta',
    'Oferta',
    'Observaciones',
    'Registrado por',
    'Marca de tiempo',
    'ID envío'
  ],

  // Índices de columna (1 = A) en la hoja Registros.
  COL: {
    FECHA: 1,
    PDV: 2,
    MARCA: 3,
    UNIDADES: 4,
    VENDIO: 5,
    OFERTA: 6,
    OBS: 7,
    USUARIO: 8,
    TIMESTAMP: 9,
    ID: 10
  },

  SIN_OFERTA: '—'
};

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

  // Hoja Registros: una fila por PDV + marca + visita.
  var registros = ss.getSheetByName(CONFIG.HOJA_REGISTROS);
  if (!registros) {
    registros = ss.insertSheet(CONFIG.HOJA_REGISTROS);
  }
  if (registros.getLastRow() === 0) {
    registros.getRange(1, 1, 1, CONFIG.ENCABEZADOS.length)
      .setValues([CONFIG.ENCABEZADOS])
      .setFontWeight('bold')
      .setBackground('#efefef');
    registros.setFrozenRows(1);
    registros.setColumnWidth(CONFIG.COL.PDV, 200);
    registros.setColumnWidth(CONFIG.COL.OFERTA, 240);
    registros.setColumnWidth(CONFIG.COL.OBS, 300);
    registros.getRange(2, CONFIG.COL.FECHA, registros.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
    registros.getRange(2, CONFIG.COL.TIMESTAMP, registros.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
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
 * Listas desplegables en Registros: Marca, Vendió oferta y Oferta.
 * Se vuelve a ejecutar cada vez que se guarda una visita, para que los cambios
 * en la hoja Config se reflejen sin hacer nada más.
 */
function aplicarValidaciones() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var registros = ss.getSheetByName(CONFIG.HOJA_REGISTROS);
  if (!registros) return;

  var filas = Math.max(registros.getMaxRows() - 1, 1);
  var marcas = leerLista('marcas');
  var ofertas = leerLista('ofertas').concat([CONFIG.SIN_OFERTA]);

  registros.getRange(2, CONFIG.COL.MARCA, filas, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(marcas, true).setAllowInvalid(false).build()
  );
  registros.getRange(2, CONFIG.COL.VENDIO, filas, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Sí', 'No'], true).setAllowInvalid(false).build()
  );
  registros.getRange(2, CONFIG.COL.OFERTA, filas, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(ofertas, true).setAllowInvalid(true).build()
  );
  registros.getRange(2, CONFIG.COL.UNIDADES, filas, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).build()
  );
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
 * @param {{fecha: string, pdv: string, observaciones: string, vendedor: string, idEnvio: string,
 *          marcas: {marca: string, unidades: number|string, vendioOferta: boolean, oferta: string, nota: string}[]}} datos
 * @return {{pdv: string, filas: number, conOferta: number, duplicado: boolean}}
 */
function registrarVisita(datos) {
  if (!datos || !datos.pdv || !String(datos.pdv).trim()) {
    throw new Error('Debes indicar el nombre del PDV.');
  }
  var pdv = String(datos.pdv).trim();
  var fecha = datos.fecha ? new Date(datos.fecha + 'T00:00:00') : new Date();
  if (isNaN(fecha.getTime())) throw new Error('La fecha no es válida.');

  var registros = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.HOJA_REGISTROS);
  if (!registros) throw new Error('No existe la hoja Registros. Ejecuta PDV → Configurar hojas.');

  // Reintentos desde el celular: si este envío ya está guardado, no se duplica.
  var idEnvio = String(datos.idEnvio || '').trim();
  if (idEnvio && registros.getLastRow() > 1) {
    var ids = registros.getRange(2, CONFIG.COL.ID, registros.getLastRow() - 1, 1).getValues();
    var yaExiste = ids.some(function (f) { return String(f[0]) === idEnvio; });
    if (yaExiste) return { pdv: pdv, filas: 0, conOferta: 0, duplicado: true };
  }

  var filas = [];
  var usuario = String(datos.vendedor || '').trim() || Session.getActiveUser().getEmail() || '';
  var ahora = new Date();
  var observaciones = String(datos.observaciones || '').trim();

  (datos.marcas || []).forEach(function (m) {
    var unidades = Number(m.unidades);
    if (!m.marca) return;
    if (isNaN(unidades) || unidades < 0) {
      throw new Error('Unidades inválidas para ' + m.marca + '.');
    }
    var vendio = !!m.vendioOferta;
    var oferta = vendio ? String(m.oferta || '').trim() : CONFIG.SIN_OFERTA;
    if (vendio && !oferta) {
      throw new Error('Indica cuál oferta vendiste para ' + m.marca + '.');
    }
    // Solo se guardan marcas con algo que reportar.
    if (unidades === 0 && !vendio) return;

    var obs = [String(m.nota || '').trim(), observaciones].filter(Boolean).join(' | ');
    filas.push([fecha, pdv, m.marca, unidades, vendio ? 'Sí' : 'No', oferta, obs, usuario, ahora, idEnvio]);
  });

  if (!filas.length) {
    throw new Error('No hay nada que guardar: todas las marcas tienen 0 unidades y sin oferta.');
  }

  var inicio = registros.getLastRow() + 1;
  registros.getRange(inicio, 1, filas.length, filas[0].length).setValues(filas);
  registros.getRange(inicio, CONFIG.COL.FECHA, filas.length, 1).setNumberFormat('yyyy-mm-dd');
  registros.getRange(inicio, CONFIG.COL.TIMESTAMP, filas.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  aplicarValidaciones();
  generarResumen();

  var conOferta = filas.filter(function (f) { return f[CONFIG.COL.VENDIO - 1] === 'Sí'; }).length;
  return { pdv: pdv, filas: filas.length, conOferta: conOferta, duplicado: false };
}

/** Versión para la barra lateral: devuelve un mensaje de texto. */
function guardarVisita(datos) {
  var r = registrarVisita(datos);
  if (r.duplicado) return 'Esta visita ya estaba guardada.';
  return 'Guardado: ' + r.filas + ' marca(s) para "' + r.pdv + '" (' + r.conOferta + ' con oferta).';
}

// ---------------------------------------------------------------------------
// Edición manual en la hoja Registros
// ---------------------------------------------------------------------------

/**
 * Mantiene coherencia entre "Vendió oferta" y "Oferta" cuando se edita a mano.
 * Trigger simple: se ejecuta solo con este archivo instalado en la hoja.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  var hoja = e.range.getSheet();
  if (hoja.getName() !== CONFIG.HOJA_REGISTROS || e.range.getRow() < 2) return;

  var col = e.range.getColumn();
  var fila = e.range.getRow();

  if (col === CONFIG.COL.VENDIO) {
    var valor = String(e.value || '').trim();
    if (valor === 'No') {
      hoja.getRange(fila, CONFIG.COL.OFERTA).setValue(CONFIG.SIN_OFERTA);
    } else if (valor === 'Sí') {
      var oferta = hoja.getRange(fila, CONFIG.COL.OFERTA);
      if (String(oferta.getValue()) === CONFIG.SIN_OFERTA) oferta.clearContent();
    }
  } else if (col === CONFIG.COL.OFERTA) {
    var ofertaValor = String(e.value || '').trim();
    var celdaVendio = hoja.getRange(fila, CONFIG.COL.VENDIO);
    if (ofertaValor && ofertaValor !== CONFIG.SIN_OFERTA && celdaVendio.getValue() !== 'Sí') {
      celdaVendio.setValue('Sí');
    }
  }

  if (col === CONFIG.COL.VENDIO || col === CONFIG.COL.OFERTA || col === CONFIG.COL.UNIDADES) {
    // Marca de tiempo de la última modificación de la fila.
    hoja.getRange(fila, CONFIG.COL.TIMESTAMP).setValue(new Date()).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
}

// ---------------------------------------------------------------------------
// Lectura y resumen
// ---------------------------------------------------------------------------

/**
 * Devuelve los registros como objetos.
 * @return {{fecha: Date, pdv: string, marca: string, unidades: number, vendio: boolean, oferta: string, obs: string, id: string}[]}
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
        unidades: Number(f[C.UNIDADES - 1]) || 0,
        vendio: String(f[C.VENDIO - 1]).trim().toLowerCase() === 'sí' || String(f[C.VENDIO - 1]).trim().toLowerCase() === 'si',
        oferta: String(f[C.OFERTA - 1]).trim(),
        obs: String(f[C.OBS - 1]).trim(),
        id: String(f[C.ID - 1] || '').trim()
      };
    });
}

/**
 * Agrupa por PDV + marca.
 * @return {Object[]} filas del resumen
 */
function calcularResumen(registros) {
  var ordenMarcas = leerLista('marcas');
  var grupos = {};

  registros.forEach(function (r) {
    var clave = r.pdv.toLowerCase() + '||' + r.marca.toLowerCase();
    if (!grupos[clave]) {
      grupos[clave] = {
        pdv: r.pdv,
        marca: r.marca,
        visitas: 0,
        unidades: 0,
        conOferta: 0,
        ofertas: {},
        ultimaVisita: null,
        ultimaOferta: ''
      };
    }
    var g = grupos[clave];
    g.visitas += 1;
    g.unidades += r.unidades;
    if (r.vendio) {
      g.conOferta += 1;
      var nombre = r.oferta && r.oferta !== CONFIG.SIN_OFERTA ? r.oferta : '(sin especificar)';
      g.ofertas[nombre] = (g.ofertas[nombre] || 0) + 1;
    }
    if (r.fecha && (!g.ultimaVisita || r.fecha > g.ultimaVisita)) {
      g.ultimaVisita = r.fecha;
      g.ultimaOferta = r.vendio ? (r.oferta || '(sin especificar)') : 'No vendió';
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
    'PDV', 'Marca', 'Visitas', 'Unidades totales', 'Veces vendió oferta',
    '% visitas con oferta', 'Ofertas vendidas (veces)', 'Última visita', 'Resultado última visita'
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
      g.unidades,
      g.conOferta,
      g.visitas ? g.conOferta / g.visitas : 0,
      formatearOfertas(g.ofertas) || '—',
      g.ultimaVisita || '',
      g.ultimaOferta
    ];
  });
  hoja.getRange(2, 1, filas.length, encabezados.length).setValues(filas);
  hoja.getRange(2, 6, filas.length, 1).setNumberFormat('0%');
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
    return g.pdv + ' · ' + g.marca + ': ' + g.unidades + ' unidades en ' + g.visitas + ' visita(s); ' +
      'vendió oferta ' + g.conOferta + ' vez/veces' +
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

  var form = FormApp.create('Visita PDV — ' + ss.getName());
  form.setDescription('Registra por cada marca las unidades, si vendiste la oferta y cuál fue.');
  form.setCollectEmail(false);

  form.addDateItem().setTitle('Fecha de la visita').setRequired(true);
  form.addTextItem().setTitle('PDV').setHelpText('Nombre del punto de venta').setRequired(true);

  marcas.forEach(function (marca) {
    form.addSectionHeaderItem().setTitle(marca);
    form.addTextItem()
      .setTitle(marca + ' - Unidades')
      .setValidation(FormApp.createTextValidation().requireNumberGreaterThanOrEqualTo(0).build());
    form.addMultipleChoiceItem()
      .setTitle(marca + ' - ¿Vendió oferta?')
      .setChoiceValues(['Sí', 'No']);
    form.addListItem()
      .setTitle(marca + ' - ¿Cuál oferta?')
      .setChoiceValues(ofertas);
  });

  form.addParagraphTextItem().setTitle('Observaciones');

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

  var marcasVisita = leerLista('marcas').map(function (marca) {
    var vendioTexto = primero(marca + ' - ¿Vendió oferta?').toLowerCase();
    return {
      marca: marca,
      unidades: Number(primero(marca + ' - Unidades')) || 0,
      vendioOferta: vendioTexto === 'sí' || vendioTexto === 'si',
      oferta: primero(marca + ' - ¿Cuál oferta?')
    };
  }).filter(function (m) { return m.unidades > 0 || m.vendioOferta; });

  if (!marcasVisita.length) return;

  var filas = marcasVisita.map(function (m) {
    return [
      fecha,
      pdv,
      m.marca,
      m.unidades,
      m.vendioOferta ? 'Sí' : 'No',
      m.vendioOferta ? (m.oferta || '(sin especificar)') : CONFIG.SIN_OFERTA,
      primero('Observaciones'),
      primero('Dirección de correo electrónico') || 'Formulario',
      new Date()
    ];
  });

  var registros = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.HOJA_REGISTROS);
  var inicio = registros.getLastRow() + 1;
  registros.getRange(inicio, 1, filas.length, filas[0].length).setValues(filas);
  registros.getRange(inicio, CONFIG.COL.FECHA, filas.length, 1).setNumberFormat('yyyy-mm-dd');
  registros.getRange(inicio, CONFIG.COL.TIMESTAMP, filas.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  generarResumen();
}
