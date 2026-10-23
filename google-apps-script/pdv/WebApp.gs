/**
 * Encuesta interactiva (web app) — se publica con Implementar → Nueva implementación → Aplicación web.
 * Sirve Index.html y expone las funciones api* que la página llama con google.script.run.
 */

function doGet() {
  var cfg = apiConfig();
  var html = HtmlService.createHtmlOutputFromFile('Index').getContent();
  // Inyecta la configuración real de la hoja en el bloque /*CFG*/ ... /*/CFG*/ de Index.html.
  html = html.replace(/\/\*CFG\*\/[\s\S]*?\/\*\/CFG\*\//, '/*CFG*/' + JSON.stringify(cfg) + '/*/CFG*/');
  return HtmlService.createHtmlOutput(html)
    .setTitle(cfg.titulo)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Marcas, ofertas y PDVs ya registrados. */
function apiConfig() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(CONFIG.HOJA_REGISTROS)) configurarHojasSilencioso();
  return {
    titulo: 'Visita PDV',
    equipo: 'Equipo de ventas',
    marcas: leerLista('marcas'),
    ofertas: leerLista('ofertas'),
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
  var porMarca = {};
  resumen.forEach(function (g) { porMarca[g.marca.toLowerCase()] = g; });

  var visitas = {};
  registros.forEach(function (r) { visitas[(r.fecha ? r.fecha.getTime() : '') + '|' + (r.id || '')] = 1; });

  return {
    pdv: String(pdv || '').trim(),
    visitas: Object.keys(visitas).length,
    marcas: leerLista('marcas').map(function (m) {
      var g = porMarca[m.toLowerCase()];
      return g
        ? { marca: g.marca, visitas: g.visitas, unidades: g.unidades, conOferta: g.conOferta, ofertas: g.ofertas }
        : { marca: m, visitas: 0, unidades: 0, conOferta: 0, ofertas: {} };
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
  var registros = ss.getSheetByName(CONFIG.HOJA_REGISTROS) || ss.insertSheet(CONFIG.HOJA_REGISTROS);
  if (registros.getLastRow() === 0) {
    registros.getRange(1, 1, 1, CONFIG.ENCABEZADOS.length).setValues([CONFIG.ENCABEZADOS]).setFontWeight('bold');
    registros.setFrozenRows(1);
  }
  if (!ss.getSheetByName(CONFIG.HOJA_RESUMEN)) ss.insertSheet(CONFIG.HOJA_RESUMEN);
}
