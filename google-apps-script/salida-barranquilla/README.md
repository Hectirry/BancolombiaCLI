# Salida Barranquilla (Google Apps Script)

Encuesta de visita para el celular. Registra, por cliente:

1. **Cliente**: nombre o código, y canal para visitar.
2. **Portafolio de innovaciones** (Sí/No): Hera, Yellow, Dalia, Tratamiento sin enjuague,
   BBQ Ahumada, Natilla Milo.
3. **Estrategias de exhibición** (Sí/No): SDS+E en Cabello, SAT+1 en lineales de cabello,
   TMB+1 en lineales de salsas, H&M en lineales de desodorantes.
4. **Portafolio Hair** (Sí/No): Savital, Dove, Sedal, Ego, Nutribella, Alma de Romero, H&S.
   Para Nutribella, Alma de Romero y H&S, si hay presencia, pregunta cuántas caras.
5. **Material POP** (Sí/No) y, si hay, de qué categoría, marca o producto.

La fecha se toma automáticamente. El avance queda guardado en el celular y un mismo envío
nunca se guarda dos veces.

## Instalación

1. En la hoja de cálculo: **Extensiones → Apps Script**.
2. Borra el contenido de `Código.gs` y pega [`Code.gs`](Code.gs).
3. **+ → HTML**, nombre exacto `Index`, y pega [`Index.html`](Index.html).
4. Guarda. **Implementar → Nueva implementación → Aplicación web**. Ejecutar como: tú.
   Quién tiene acceso: cualquier usuario. Implementar y autorizar.
5. El link que termina en `/exec` es la encuesta.

Para publicar cambios después: **Implementar → Administrar implementaciones → lápiz →
Versión: Nueva versión → Implementar**. El link no cambia.

## Hojas

| Hoja | Contenido |
|------|-----------|
| `Registros` | Una fila por visita: fecha, cliente, canal, una columna por pregunta, caras de Nutribella, Alma de Romero y H&S, POP y su detalle, quién registró, marca de tiempo e ID de envío. |
| `Resumen` | Por pregunta: visitas, cuántas dijeron Sí, % Sí y promedio de caras. Se recalcula con cada visita. |
| `Config` | Columna A: canales que muestra la encuesta. Se editan sin volver a publicar. |

Las preguntas están en `SB.SECCIONES` al inicio de `Code.gs`. Si cambias una pregunta
cuando ya hay visitas, renombra a mano la columna correspondiente en `Registros`.

## Tabular las respuestas

[`analisis/tabular.py`](analisis/tabular.py) convierte la pestaña `Registros` (exportada como
CSV, o como JSON de la API de Google Sheets) en tablas: visitas por canal, % Sí por pregunta
de cada bloque, caras de Nutribella, Alma de Romero y H&S, POP y la lista de visitas.

```
python3 analisis/tabular.py registros.csv --por-canal
python3 analisis/tabular.py registros.csv --canal "Tienda tradicional" --desde 2026-11-01
```

Para exportar a CSV: en la hoja, pestaña Registros, **Archivo → Descargar → Valores separados
por comas (.csv)**.
