#!/usr/bin/env python3
"""Tabula las respuestas de la encuesta Salida Barranquilla.

Entrada: la pestaña Registros como JSON (la lista de filas que devuelve la API de
Google Sheets, encabezado incluido, o el objeto completo con la clave "values") o
como CSV exportado de la hoja.

Uso:
    python3 tabular.py registros.json
    python3 tabular.py registros.csv --canal "Tienda tradicional" --desde 2026-11-01
    python3 tabular.py registros.json --por-canal

Salida: tablas en Markdown, listas para pegar en un chat, un correo o un documento.
Las columnas se reconocen por su prefijo (Innovación:, Exhibición:, Hair:, Caras ...),
así que preguntas nuevas en Code.gs aparecen solas.
"""
import argparse
import csv
import json
import statistics
import sys
from collections import Counter, OrderedDict

SECCIONES = OrderedDict([
    ("Innovación", "Portafolio de innovaciones"),
    ("Exhibición", "Estrategias de exhibición"),
    ("Hair", "Portafolio Hair"),
])


def leer(ruta):
    with open(ruta, encoding="utf-8-sig") as f:
        texto = f.read()
    if ruta.lower().endswith(".csv"):
        return [fila for fila in csv.reader(texto.splitlines())]
    datos = json.loads(texto)
    if isinstance(datos, dict):
        # Respuesta de la API: {"values": [...]} o anidada en "data".
        for clave in ("values", "data"):
            if clave in datos:
                datos = datos[clave]
                if isinstance(datos, dict) and "values" in datos:
                    datos = datos["values"]
                break
    return datos


def a_registros(filas):
    if not filas:
        return [], []
    enc = [str(c).strip() for c in filas[0]]
    regs = []
    for f in filas[1:]:
        if not any(str(x).strip() for x in f):
            continue
        f = list(f) + [""] * (len(enc) - len(f))
        regs.append({enc[i]: str(f[i]).strip() for i in range(len(enc))})
    return enc, regs


def si(v):
    return str(v).strip().lower() in ("sí", "si")


def pct(a, b):
    return f"{round(100 * a / b)}%" if b else "—"


def es_numero(v):
    t = str(v).replace("%", "").replace(",", ".").strip()
    try:
        float(t)
        return True
    except ValueError:
        return t in ("—", "")


def tabla(encabezado, filas):
    # Columnas numéricas a la derecha, texto a la izquierda.
    num = [i > 0 and all(es_numero(f[i]) for f in filas) for i in range(len(encabezado))]
    out = ["| " + " | ".join(encabezado) + " |",
           "|" + "|".join("---:" if num[i] else "---" for i in range(len(encabezado))) + "|"]
    out += ["| " + " | ".join(str(c) for c in f) + " |" for f in filas]
    return "\n".join(out)


def preguntas(enc, prefijo):
    return [c for c in enc if c.startswith(prefijo + ": ")]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("archivo")
    ap.add_argument("--canal", help="Solo este canal")
    ap.add_argument("--desde", help="Fecha mínima AAAA-MM-DD")
    ap.add_argument("--hasta", help="Fecha máxima AAAA-MM-DD")
    ap.add_argument("--cliente", help="Solo clientes que contengan este texto")
    ap.add_argument("--por-canal", action="store_true", help="Agregar el % Sí de cada pregunta por canal")
    a = ap.parse_args()

    enc, regs = a_registros(leer(a.archivo))
    col_fecha = "Fecha"
    col_cli = next((c for c in enc if c.startswith("Cliente")), "Cliente")
    if a.canal:
        regs = [r for r in regs if r.get("Canal", "").lower() == a.canal.lower()]
    if a.desde:
        regs = [r for r in regs if r.get(col_fecha, "")[:10] >= a.desde]
    if a.hasta:
        regs = [r for r in regs if r.get(col_fecha, "")[:10] <= a.hasta]
    if a.cliente:
        regs = [r for r in regs if a.cliente.lower() in r.get(col_cli, "").lower()]

    n = len(regs)
    filtros = [f"{k}: {v}" for k, v in (("canal", a.canal), ("desde", a.desde), ("hasta", a.hasta), ("cliente", a.cliente)) if v]
    print("# Salida Barranquilla: resumen de visitas\n")
    if filtros:
        print("Filtros: " + ", ".join(filtros) + "\n")
    if not n:
        print("No hay visitas con esos filtros.")
        return

    fechas = sorted(r.get(col_fecha, "")[:10] for r in regs if r.get(col_fecha))
    clientes = len({r.get(col_cli, "").lower() for r in regs})
    print(f"**{n} visita{'s' if n != 1 else ''}** a **{clientes} cliente{'s' if clientes != 1 else ''}**" + (f", del {fechas[0]} al {fechas[-1]}." if fechas else ".") + "\n")

    canales = Counter(r.get("Canal", "") or "(sin canal)" for r in regs)
    print("## Visitas por canal\n")
    print(tabla(["Canal", "Visitas", "%"], [[c, k, pct(k, n)] for c, k in canales.most_common()]) + "\n")

    orden_canales = [c for c, _ in canales.most_common()]
    for pref, titulo in SECCIONES.items():
        cols = preguntas(enc, pref)
        if not cols:
            continue
        print(f"## {titulo}\n")
        enc_t = ["Pregunta", "Sí", "% Sí"] + (orden_canales if a.por_canal else [])
        filas = []
        for c in sorted(cols, key=lambda c: -sum(si(r.get(c)) for r in regs)):
            k = sum(si(r.get(c)) for r in regs)
            fila = [c.split(": ", 1)[1], k, pct(k, n)]
            if a.por_canal:
                for can in orden_canales:
                    sub = [r for r in regs if (r.get("Canal") or "(sin canal)") == can]
                    fila.append(pct(sum(si(r.get(c)) for r in sub), len(sub)))
            filas.append(fila)
        print(tabla(enc_t, filas) + "\n")

    cols_caras = [c for c in enc if c.startswith("Caras ")]
    if cols_caras:
        print("## Caras en góndola (cuando hay presencia)\n")
        filas = []
        for c in cols_caras:
            vals = []
            for r in regs:
                try:
                    vals.append(float(str(r.get(c, "")).replace(",", ".")))
                except ValueError:
                    pass
            marca = c[len("Caras "):]
            if vals:
                filas.append([marca, len(vals), f"{statistics.mean(vals):.1f}".replace(".", ","),
                              f"{statistics.median(vals):g}".replace(".", ","), f"{min(vals):g}", f"{max(vals):g}"])
            else:
                filas.append([marca, 0, "—", "—", "—", "—"])
        print(tabla(["Marca", "Visitas con presencia", "Promedio", "Mediana", "Mín", "Máx"], filas) + "\n")

    if "POP" in enc:
        con_pop = [r for r in regs if si(r.get("POP"))]
        print("## Material POP\n")
        print(f"POP presente en **{len(con_pop)} de {n}** visitas ({pct(len(con_pop), n)}).\n")
        col_det = next((c for c in enc if c.startswith("POP:")), None)
        if col_det and con_pop:
            det = Counter(r.get(col_det, "").strip().capitalize() for r in con_pop if r.get(col_det, "").strip())
            print(tabla(["Dónde se encontró POP", "Visitas"], [[d, k] for d, k in det.most_common()]) + "\n")

    print("## Visitas incluidas\n")
    print(tabla(["Fecha", "Cliente", "Canal"], [[r.get(col_fecha, "")[:10], r.get(col_cli, ""), r.get("Canal", "")] for r in sorted(regs, key=lambda r: r.get(col_fecha, ""))]))


if __name__ == "__main__":
    sys.exit(main())
