/**
 * Salida Barranquilla — encuesta de visita (Google Apps Script).
 *
 * Instalación: en la hoja de cálculo, Extensiones → Apps Script. Pega este archivo en
 * Código.gs y crea un archivo HTML llamado exactamente "Index" con Index.html.
 * Luego Implementar → Nueva implementación → Aplicación web (ejecutar como tú,
 * acceso: cualquier usuario). Las pestañas Registros, Resumen y Config se crean solas.
 */

var SB = {
  HOJA_REGISTROS: 'Registros',
  HOJA_RESUMEN: 'Resumen',
  HOJA_CONFIG: 'Config',
  TITULO: 'Salida Barranquilla',

  // Canales por defecto. Se pueden cambiar en la columna A de la pestaña Config.
  CANALES: ['Tienda tradicional', 'Minimercado', 'Autoservicio', 'Droguería', 'Mayorista'],

  // Cuestionario. "caras: true" pide cuántas caras cuando la respuesta es Sí.
  SECCIONES: [
    {
      id: 'innov', titulo: 'Portafolio de innovaciones', columna: 'Innovación',
      pregunta: '¿Se tiene presencia del portafolio?',
      items: [
        { id: 'hera', nombre: 'Hera' },
        { id: 'yellow', nombre: 'Yellow' },
        { id: 'dalia', nombre: 'Dalia' },
        { id: 'tse', nombre: 'Tratamiento sin enjuague' },
        { id: 'bbq', nombre: 'BBQ Ahumada' },
        { id: 'milo', nombre: 'Natilla Milo' }
      ]
    },
    {
      id: 'exhib', titulo: 'Estrategias de exhibición', columna: 'Exhibición',
      pregunta: '¿Se ve la estrategia en el punto de venta?',
      items: [
        { id: 'sdse', nombre: 'SDS+E', detalle: 'Exhibición en Cabello con la estrategia SDS+E' },
        { id: 'sat1', nombre: 'SAT+1', detalle: 'Lineales de cabello' },
        { id: 'tmb1', nombre: 'TMB+1', detalle: 'Lineales de salsas' },
        { id: 'hm', nombre: 'H&M', detalle: 'Lineales de desodorantes' }
      ]
    },
    {
      id: 'hair', titulo: 'Portafolio Hair', columna: 'Hair',
      pregunta: '¿Se tiene presencia de producto de la marca?',
      items: [
        { id: 'savital', nombre: 'Savital' },
        { id: 'dove', nombre: 'Dove' },
        { id: 'sedal', nombre: 'Sedal' },
        { id: 'ego', nombre: 'Ego' },
        { id: 'nutribella', nombre: 'Nutribella', caras: true },
        { id: 'almaderomero', nombre: 'Alma de Romero', caras: true },
        { id: 'hys', nombre: 'H&S', caras: true }
      ]
    }
  ]
};

// ---------------------------------------------------------------------------
// Web app
// ---------------------------------------------------------------------------

function doGet() {
  prepararHojas();
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(SB.TITULO)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Cuestionario y canales (la página los pide al cargar). */
function apiConfig() {
  prepararHojas();
  return { titulo: SB.TITULO, canales: leerCanales(), secciones: SB.SECCIONES };
}

/**
 * Guarda una visita: una fila por visita en Registros.
 * @param {{idEnvio:string, fecha:string, cliente:string, canal:string,
 *          respuestas:Object<string,string>, caras:Object<string,number>,
 *          pop:string, popDetalle:string}} p
 */
function apiSubmit(p) {
  if (!p || !String(p.cliente || '').trim()) throw new Error('Debes indicar el nombre o código del cliente.');
  if (!String(p.canal || '').trim()) throw new Error('Debes indicar el canal.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var hoja = prepararHojas().registros;
    var idEnvio = String(p.idEnvio || '').trim();
    var cols = columnas();
    var colId = cols.length;

    // Reintentos desde el celular: si este envío ya está, no se duplica.
    if (idEnvio && hoja.getLastRow() > 1) {
      var ids = hoja.getRange(2, colId, hoja.getLastRow() - 1, 1).getValues();
      if (ids.some(function (f) { return String(f[0]) === idEnvio; })) return { duplicado: true };
    }

    var fecha = p.fecha ? new Date(p.fecha + 'T00:00:00') : new Date();
    if (isNaN(fecha.getTime())) fecha = new Date();
    var resp = p.respuestas || {};
    var caras = p.caras || {};

    var fila = [fecha, String(p.cliente).trim(), String(p.canal).trim()];
    SB.SECCIONES.forEach(function (s) {
      s.items.forEach(function (it) {
        var v = siNo(resp[s.id + '.' + it.id]);
        if (!v) throw new Error('Falta responder ' + s.columna + ': ' + it.nombre + '.');
        fila.push(v);
        if (it.caras) {
          var c = v === 'Sí' ? Number(caras[s.id + '.' + it.id]) : '';
          if (v === 'Sí' && (!isFinite(c) || c < 1 || c % 1)) throw new Error('Indica cuántas caras de ' + it.nombre + '.');
          fila.push(c);
        }
      });
    });
    var pop = siNo(p.pop);
    if (!pop) throw new Error('Falta responder si hay POP.');
    var popDetalle = pop === 'Sí' ? String(p.popDetalle || '').trim() : '';
    if (pop === 'Sí' && !popDetalle) throw new Error('Indica de qué categoría, marca o producto es el POP.');
    fila.push(pop, popDetalle, Session.getActiveUser().getEmail() || '', new Date(), idEnvio);

    var r = hoja.getLastRow() + 1;
    hoja.getRange(r, 2).setNumberFormat('@');
    hoja.getRange(r, 1, 1, fila.length).setValues([fila]);
    hoja.getRange(r, 1).setNumberFormat('yyyy-mm-dd');
    hoja.getRange(r, cols.length - 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  } finally {
    lock.releaseLock();
  }
  generarResumen();
  return { duplicado: false };
}

// ---------------------------------------------------------------------------
// Hojas
// ---------------------------------------------------------------------------

function siNo(v) {
  var t = String(v == null ? '' : v).trim().toLowerCase();
  if (t === 'sí' || t === 'si' || v === true) return 'Sí';
  if (t === 'no' || v === false) return 'No';
  return '';
}

/** Encabezados de Registros, en orden. */
function columnas() {
  var c = ['Fecha', 'Cliente (nombre o código)', 'Canal'];
  SB.SECCIONES.forEach(function (s) {
    s.items.forEach(function (it) {
      c.push(s.columna + ': ' + it.nombre);
      if (it.caras) c.push('Caras ' + it.nombre);
    });
  });
  return c.concat(['POP', 'POP: categoría / marca / producto', 'Registrado por', 'Marca de tiempo', 'ID envío']);
}

function prepararHojas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var enc = columnas();

  var config = ss.getSheetByName(SB.HOJA_CONFIG);
  if (!config) {
    config = ss.insertSheet(SB.HOJA_CONFIG);
    config.getRange(1, 1).setValue('Canales').setFontWeight('bold');
    config.getRange(2, 1, SB.CANALES.length, 1).setValues(SB.CANALES.map(function (c) { return [c]; }));
    config.setColumnWidth(1, 220);
  }

  var reg = ss.getSheetByName(SB.HOJA_REGISTROS);
  if (!reg) {
    // Una hoja nueva trae "Hoja 1"/"Sheet1" vacía: se reutiliza como Registros.
    var hojas = ss.getSheets();
    var vacia = hojas.length && hojas[0].getLastRow() === 0 && /^(Hoja|Sheet)\s?1$/.test(hojas[0].getName()) ? hojas[0] : null;
    reg = vacia ? vacia.setName(SB.HOJA_REGISTROS) : ss.insertSheet(SB.HOJA_REGISTROS, 0);
  }
  if (reg.getLastRow() === 0) {
    reg.getRange(1, 1, 1, enc.length).setValues([enc]).setFontWeight('bold').setBackground('#E6E8FA').setWrap(true);
    reg.setFrozenRows(1);
    reg.setFrozenColumns(2);
  }

  if (!ss.getSheetByName(SB.HOJA_RESUMEN)) ss.insertSheet(SB.HOJA_RESUMEN);
  return { registros: reg, config: config };
}

function leerCanales() {
  var config = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SB.HOJA_CONFIG);
  if (!config || config.getLastRow() < 2) return SB.CANALES.slice();
  var v = config.getRange(2, 1, config.getLastRow() - 1, 1).getValues()
    .map(function (f) { return String(f[0]).trim(); })
    .filter(function (x) { return x; });
  return v.length ? v : SB.CANALES.slice();
}

/** Resumen: por pregunta, cuántas visitas dijeron Sí y el promedio de caras. */
function generarResumen() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var reg = ss.getSheetByName(SB.HOJA_REGISTROS);
  var hoja = ss.getSheetByName(SB.HOJA_RESUMEN) || ss.insertSheet(SB.HOJA_RESUMEN);
  hoja.clear();

  var enc = ['Sección', 'Pregunta', 'Visitas', 'Sí', '% Sí', 'Promedio de caras (cuando hay)'];
  hoja.getRange(1, 1, 1, enc.length).setValues([enc]).setFontWeight('bold').setBackground('#E6E8FA');
  hoja.setFrozenRows(1);

  var n = reg && reg.getLastRow() > 1 ? reg.getLastRow() - 1 : 0;
  if (!n) { hoja.getRange(2, 1).setValue('Aún no hay visitas registradas.'); return; }

  var cols = columnas();
  var datos = reg.getRange(2, 1, n, cols.length).getValues();
  var idx = {};
  cols.forEach(function (c, i) { idx[c] = i; });

  var filas = [];
  function agregar(seccion, nombre, colSi, colCaras) {
    var si = 0, sumaCaras = 0, nCaras = 0;
    datos.forEach(function (f) {
      if (siNo(f[colSi]) === 'Sí') {
        si++;
        if (colCaras != null && f[colCaras] !== '' && isFinite(Number(f[colCaras]))) { sumaCaras += Number(f[colCaras]); nCaras++; }
      }
    });
    filas.push([seccion, nombre, n, si, si / n, colCaras == null ? '' : (nCaras ? sumaCaras / nCaras : '—')]);
  }
  SB.SECCIONES.forEach(function (s) {
    s.items.forEach(function (it) {
      agregar(s.titulo, it.nombre + (it.detalle ? ' (' + it.detalle + ')' : ''),
        idx[s.columna + ': ' + it.nombre], it.caras ? idx['Caras ' + it.nombre] : null);
    });
  });
  agregar('Material POP', 'Hay POP en el punto de venta', idx['POP'], null);

  hoja.getRange(2, 1, filas.length, enc.length).setValues(filas);
  hoja.getRange(2, 3, filas.length, 2).setNumberFormat('0');
  hoja.getRange(2, 5, filas.length, 1).setNumberFormat('0%');
  hoja.getRange(2, 6, filas.length, 1).setNumberFormat('0.0');
  hoja.setColumnWidth(1, 200);
  hoja.setColumnWidth(2, 340);
  hoja.setColumnWidth(6, 200);
}
