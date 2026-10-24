# Registro de visitas a PDV (Google Apps Script)

Encuesta interactiva para el celular (web app de Apps Script) y hoja de Google Sheets que
registran, por cada **PDV (punto de venta)** y por cada marca (**Savital, Dove, Sedal,
Nutribella, Alma de Romero**):

- cuántas **unidades**,
- si **le vendió la oferta o no**,
- **cuál oferta** fue.

La encuesta (`Index.html` + `WebApp.gs`) funciona paso a paso: código del PDV → una pantalla
por marca (unidades, ¿vendió oferta?, ¿cuál?) → revisar → enviar → acumulado del PDV. La fecha
se toma automáticamente. El avance se guarda en el celular y, al enviar, las respuestas caen en la hoja `Registros`.

> Esta carpeta es independiente del CLI de Bancolombia; solo vive aquí para tener el
> código versionado. No se instala con `bun`, se pega en Google Sheets.

## Instalación (una sola vez)

1. Crea una hoja de cálculo nueva en Google Sheets.
2. Menú **Extensiones → Apps Script**.
3. Borra el contenido de `Código.gs` y pega el de [`Code.gs`](Code.gs).
4. Botón **+ → Secuencia de comandos**, nómbralo `WebApp` y pega [`WebApp.gs`](WebApp.gs).
5. Botón **+ → HTML**, nómbralo exactamente `Index` y pega [`Index.html`](Index.html).
6. Botón **+ → HTML**, nómbralo exactamente `Sidebar` y pega [`Sidebar.html`](Sidebar.html)
   (opcional: es el formulario dentro de la hoja).
7. (Opcional) En **Configuración del proyecto** marca "Mostrar el archivo de manifiesto
   appsscript.json" y reemplázalo por [`appsscript.json`](appsscript.json) para fijar la
   zona horaria de Bogotá.
8. Guarda (Ctrl+S), vuelve a la hoja y recárgala. Aparece el menú **PDV**.
9. **PDV → Configurar hojas (primera vez)**. Acepta los permisos que pide Google.

## Publicar la encuesta (link para el celular)

1. En el editor de Apps Script: **Implementar → Nueva implementación**.
2. Tipo: **Aplicación web**. Descripción: "Encuesta PDV".
3. **Ejecutar como:** Yo (tu cuenta). **Quién tiene acceso:** Cualquier usuario
   (o "Cualquier usuario con cuenta de Google" si quieres exigir inicio de sesión).
4. **Implementar** y acepta los permisos. Copia la URL que termina en `/exec`: ese es el
   link de la encuesta para compartir con los vendedores.

Cada vez que cambies `Index.html` o `WebApp.gs`, ve a **Implementar → Administrar
implementaciones → editar (lápiz) → Versión: Nueva → Implementar** para que el link se
actualice. Las marcas y ofertas se leen de la hoja `Config` en cada carga, sin redeploy.

Para probar la encuesta sin instalarla hay una vista previa publicada (ver el PR). En esa
vista previa las respuestas se guardan solo en el navegador.

Se crean tres hojas:

| Hoja        | Para qué sirve |
|-------------|----------------|
| `Config`    | Columna A: marcas. Columna B: ofertas. Edítalas a mano y los desplegables se actualizan solos. |
| `Registros` | Una fila por PDV + marca + visita: Fecha, PDV, Marca, Unidades, Vendió oferta, Oferta, Observaciones, Registrado por, Marca de tiempo, ID envío (evita duplicados si el celular reintenta). |
| `Resumen`   | Una fila por PDV y marca: visitas, unidades totales, veces que vendió oferta, % de visitas con oferta, qué ofertas vendió (y cuántas veces), última visita y su resultado. |

## Uso diario

- **PDV → Registrar visita**: abre una barra lateral con la fecha, el nombre del PDV
  (autocompleta los ya registrados) y un bloque por marca con unidades, "¿Vendió oferta?"
  y "¿Cuál oferta?". Al guardar se agregan las filas a `Registros` y se recalcula `Resumen`.
  Las marcas con 0 unidades y sin oferta no se guardan.
- **PDV → Consultar un PDV**: escribe parte del nombre y muestra el detalle por marca.
- **PDV → Actualizar resumen**: recalcula `Resumen` si editaste `Registros` a mano.
- También puedes escribir directamente en `Registros`: las columnas Marca, Vendió oferta y
  Oferta tienen listas desplegables. Si pones "No" en Vendió oferta, la Oferta se pone en
  "—"; si eliges una oferta, Vendió oferta pasa a "Sí".

## Registrar desde el celular (Google Forms)

**PDV → Crear formulario de Google (celular)** crea un formulario con una sección por marca
(unidades, ¿vendió oferta?, ¿cuál oferta?), lo enlaza a la hoja y deja un disparador que
copia cada respuesta a `Registros` y recalcula `Resumen`. El cuadro final muestra el enlace
para compartir con el vendedor.

Si después cambias las marcas u ofertas en `Config`, vuelve a crear el formulario (o edita
las preguntas conservando el formato `Marca - Unidades`, `Marca - ¿Vendió oferta?`,
`Marca - ¿Cuál oferta?`, que es lo que usa el script para leer las respuestas).

## Personalizar

- Marcas y ofertas: hoja `Config`. Los valores iniciales están en `CONFIG.MARCAS_INICIALES`
  y `CONFIG.OFERTAS_INICIALES` dentro de `Code.gs`.
- Nombres de hojas y columnas: objeto `CONFIG` al inicio de `Code.gs`.
