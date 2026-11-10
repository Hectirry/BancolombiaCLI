# Notas para Claude

## Encuestas de Google Apps Script (`google-apps-script/`)

El dueño del repositorio tiene dos encuestas de visita publicadas como aplicaciones web de
Apps Script. Las respuestas viven en hojas de Google de su cuenta. Se leen con la conexión de
Google Sheets (Composio: `GOOGLESHEETS_VALUES_GET`), nunca se piden por chat.

| Encuesta | Carpeta | Hoja de cálculo (ID) | Link de la encuesta |
|---|---|---|---|
| Salida Barranquilla | `google-apps-script/salida-barranquilla` | `1RG7WcovuIGTa-wBexEXbct7aLvMB4vEOY1mokqz9ndI` | https://script.google.com/macros/s/AKfycbwMspVRf_6n4ua5RBAxZbBc4WCq5fXw1mNZNhRObj6LxeWmEZrGODgrkdBZj4S7G3sc/exec |
| Visita PDV | `google-apps-script/pdv` | `1T-98ZsUhPHNVr2CRIHAEQegADa70zpsSEgXjSyT_JR0` | https://script.google.com/macros/s/AKfycbwo81LMKNTDkd6M5Dm5lzcf6n5Bxzbd1y_ojMCa0fvJaTJXhd_pbkg-MNg9MA0Tjv5r/exec |

### Cuando el usuario pida un resumen, análisis o tabulación de Salida Barranquilla

1. Lee la pestaña `Registros` completa con `GOOGLESHEETS_VALUES_GET`
   (`spreadsheet_id` de la tabla, `range` `Registros!A1:AB`). Si la respuesta es grande,
   guárdala con `sync_response_to_workbench` y llévala a un archivo local.
2. Guarda el resultado como JSON en el scratchpad (el objeto con `values`, o la lista de filas).
3. Ejecuta `python3 -I google-apps-script/salida-barranquilla/analisis/tabular.py <archivo.json>`.
   Opciones: `--por-canal` (agrega el % Sí por canal), `--canal`, `--desde AAAA-MM-DD`,
   `--hasta AAAA-MM-DD`, `--cliente <texto>`.
4. Responde con las tablas y una lectura corta de lo que muestran (lo más alto, lo más bajo,
   diferencias por canal). Di cuántas visitas incluye y con qué filtros.
5. Si el usuario quiere el resumen para otras personas, publícalo como página y da el link.

La pestaña `Resumen` de la hoja ya tiene el % Sí por pregunta; `tabular.py` agrega canales,
caras, POP, filtros por fecha y la lista de visitas.

### Cambios al código de las encuestas

El usuario los instala pegando `Code.gs` e `Index.html` en el editor de Apps Script y publica con
"Administrar implementaciones → Nueva versión" (así el link no cambia). Antes de pedirle que
pegue algo, verifica sintaxis con Node y, si el cambio toca el flujo, pruébalo en Chromium
(`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) abriendo `Index.html` como archivo: fuera
de Apps Script la página funciona en modo de vista previa.
