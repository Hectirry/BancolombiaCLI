import { expect, test, describe, afterEach } from "bun:test";
import {
  OFFICIAL_SOURCE,
  OfficialPageError,
  fetchLatestOfficial,
  fetchOfficialDetail,
  parseDrawDetail,
  parseOfficialDetail,
  parseOfficialIndexPage,
  parseSecondaryYearPage,
  parseSpanishLongDate,
  parseYearPage,
  setHttpGet,
} from "../src/baloto/source.ts";
import {
  appendConflicts,
  breakdownIsConsistent,
  cleanDraws,
  datasetAnomalies,
  isDrawDay,
  isValidDraw,
  mergeDraws,
  reconcileDraws,
  type Dataset,
  type Draw,
} from "../src/baloto/dataset.ts";

const yearPage = `
<table><thead><tr><th>Fecha del sorteo</th><th>Resultados</th></tr></thead><tbody>
<tr><td><a href="/baloto/resultados/12-08-2026"><strong>miércoles</strong><br>12 ago. 2026</a></td>
<td><ul class="balls"><li>Baloto</li><li class="ball">11</li><li class="ball">13</li>
<li class="ball">15</li><li class="ball">16</li><li class="ball">42</li><li class="ball">8</li></ul>
<ul class="balls"><li>Revancha</li><li class="ball">16</li><li class="ball">23</li>
<li class="ball">33</li><li class="ball">36</li><li class="ball">42</li><li class="ball">1</li></ul></td></tr>
<tr><td><a href="/baloto/resultados/10-08-2026"><strong>lunes</strong><br>10 ago. 2026</a></td>
<td><ul class="balls"><li>Baloto</li><li class="ball">4</li><li class="ball">14</li>
<li class="ball">19</li><li class="ball">27</li><li class="ball">35</li><li class="ball">14</li></ul>
<ul class="balls"><li>Revancha</li><li class="ball">9</li><li class="ball">13</li>
<li class="ball">21</li><li class="ball">31</li><li class="ball">36</li><li class="ball">3</li></ul></td></tr>
</tbody></table>`;

describe("parseYearPage", () => {
  const draws = parseYearPage(yearPage);

  test("reads both games from every row", () => {
    expect(draws).toHaveLength(4);
    expect(draws[0]).toEqual({
      date: "2026-08-12",
      game: "baloto",
      main: [11, 13, 15, 16, 42],
      super: 8,
    });
    expect(draws[1]!.game).toBe("revancha");
    expect(draws[1]!.super).toBe(1);
  });

  test("keeps a Súper Balota that repeats a main number", () => {
    // The two machines are independent, so this really happens.
    const draw = draws.find((d) => d.date === "2026-08-10" && d.game === "baloto")!;
    expect(draw.main).toEqual([4, 14, 19, 27, 35]);
    expect(draw.super).toBe(14);
  });
});

const detailPage = `
<table><tr><th>Categoría</th><th>Premio por ganador</th><th>Total ganado</th><th>Ganadores</th></tr>
<tr><td>5 Aciertos + Súper Balota</td><td>52.000.000.000 $</td><td>0 $</td><td>Acumulado 0</td></tr>
<tr><td>5 Aciertos</td><td>0 $</td><td>0 $</td><td>0</td></tr>
<tr><td>4 Aciertos + Súper Balota</td><td>1.936.350 $</td><td>11.618.100 $</td><td>6</td></tr>
<tr><td>4 Aciertos</td><td>117.650 $</td><td>12.706.200 $</td><td>108</td></tr>
<tr><td>3 Aciertos + Súper Balota</td><td>45.900 $</td><td>11.016.000 $</td><td>240</td></tr>
<tr><td>3 Aciertos</td><td>8.650 $</td><td>35.880.200 $</td><td>4.148</td></tr>
<tr><td>2 Aciertos + Súper Balota</td><td>9.850 $</td><td>28.702.900 $</td><td>2.914</td></tr>
<tr><td>1 Aciertos + Súper Balota y 0 + Súper Balota</td><td>6.000 $</td><td>141.276.000 $</td><td>23.546</td></tr>
</table>`;

describe("parseDrawDetail", () => {
  test("reads all eight categories, including the grouped last one", () => {
    const { baloto } = parseDrawDetail(detailPage);
    expect(baloto).toHaveLength(8);
    expect(baloto[7]).toEqual({
      tier: "1+S",
      prizePerWinner: 6_000,
      totalPaid: 141_276_000,
      winners: 23_546,
    });
    expect(baloto[2]!.winners).toBe(6);
  });

  test("rejects a breakdown whose columns do not multiply out", () => {
    // The archive occasionally shifts the columns, turning a single winner of
    // $37 521 175 into 37 million winners.
    const corrupted = detailPage.replace(
      "<td>1.936.350 $</td><td>11.618.100 $</td><td>6</td>",
      "<td>0 $</td><td>1 $</td><td>37.521.175</td>",
    );
    expect(parseDrawDetail(corrupted).baloto).toHaveLength(0);
  });

  test("separates the Baloto and Revancha tables", () => {
    const both = `${detailPage}<h2>Premios de Revancha</h2>${detailPage}`;
    const parsed = parseDrawDetail(both);
    expect(parsed.baloto).toHaveLength(8);
    expect(parsed.revancha).toHaveLength(8);
  });
});

describe("parseSecondaryYearPage", () => {
  test("reads the twelve numbers of a row, ignoring the jackpot label", () => {
    const html = `<p>Resultado 30 Diciembre</p>
      <span>Premios: $</span><span>8,000,000,000</span>
      <span> 08</span><span> 13</span><span> 21</span><span> 32</span><span> 33</span><span> 08</span>
      <span> 24</span><span> 28</span><span> 32</span><span> 35</span><span> 39</span><span> 08</span>`;
    const draws = parseSecondaryYearPage(html, 2023);
    expect(draws).toHaveLength(2);
    expect(draws[0]).toEqual({
      date: "2023-12-30",
      game: "baloto",
      main: [8, 13, 21, 32, 33],
      super: 8,
    });
    expect(draws[1]!.main).toEqual([24, 28, 32, 35, 39]);
  });
});

describe("breakdownIsConsistent", () => {
  test("accepts rows where prize × winners equals the total", () => {
    expect(
      breakdownIsConsistent([
        { tier: "3", prizePerWinner: 8_650, winners: 4_148, totalPaid: 35_880_200 },
      ]),
    ).toBe(true);
  });

  test("accepts an unclaimed category", () => {
    expect(
      breakdownIsConsistent([
        { tier: "5+S", prizePerWinner: 52_000_000_000, winners: 0, totalPaid: 0 },
      ]),
    ).toBe(true);
  });

  test("rejects rows that do not multiply out", () => {
    expect(
      breakdownIsConsistent([
        { tier: "5", prizePerWinner: 0, winners: 37_521_175, totalPaid: 1 },
      ]),
    ).toBe(false);
  });
});

// --- baloto.com (tertiary, official) -----------------------------------------

/** A trimmed copy of /resultados-baloto/2716 as served on 2026-10-04. */
function officialPage(opts: {
  index?: string;
  weekday?: string;
  date?: string;
  balls?: number[];
  jackpot?: string;
  table?: string;
} = {}): string {
  const {
    index = "2.716",
    weekday = "Miércoles",
    date = "30 de Septiembre de 2026",
    balls = [11, 18, 22, 30, 32, 10],
    jackpot = "$61.200",
    table = officialTable(),
  } = opts;
  const ballDivs = balls
    .map(
      (n, i) =>
        `<div class="col-md-2 col-2"><div class="text-center"><div class="${i < 5 ? "yellow-ball" : "red-ball"} gotham-medium">
          ${String(n).padStart(2, "0")}
        </div></div></div>`,
    )
    .join("\n");
  return `<html><head><title>Baloto</title></head><body>
<nav>Resultados Baloto Resultados MiLoto Resultados ColorLOTO</nav>
<div class="gotham-medium dark-blue fs-5"><strong>SORTEO ${index}</strong></div>
<div class="gotham-medium dark-blue fs-5 text-uppercase"><strong>${weekday}</strong></div>
<div class="gotham-medium dark-blue">${date}</div>
<div class="text-center my-3 gotham-medium dark-blue fs-6">ACUMULADO DEL SORTEO: ${jackpot} MILLONES</div>
<div class="container-balls-results"><div class="row">${ballDivs}</div></div>
<div>TOTAL<br />GANADORES</div><div class="total-results">28.388</div>
${table}
<p>SB Super balota</p>
<p>PRÓXIMO SORTEO Sábado 03 de Octubre</p>
</body></html>`;
}

function officialTable(
  rows: [string, string, string, string][] = [
    ["5 + SB", "$0", "0", "$0"],
    ["5", "$0", "0", "$0"],
    ["4 + SB", "$9.909.000", "6", "$1.651.500"],
    ["4", "$10.834.200", "156", "$69.450"],
    ["3 + SB", "$9.387.800", "292", "$32.150"],
    ["3", "$30.689.750", "4.615", "$6.650"],
    ["2 + SB", "$24.444.000", "2.716", "$9.000"],
    ["0 + SB", "$123.618.000", "20.603", "$6.000"],
  ],
): string {
  const label = (text: string): string => {
    const [n, , sb] = text.split(" ");
    return (
      `<div class="row m-0"><div class="col-md-4"><div class="yellow-ball-results">${n}</div></div>` +
      (sb
        ? `<div class="col-md-4"><div class="sign dark-blue">+</div></div><div class="col-md-4"><div class="pink-ball-results">SB</div></div>`
        : `<div class="col-md-4"></div><div class="col-md-4"></div>`) +
      `</div>`
    );
  };
  return (
    `<table><thead><tr><th>ACIERTOS</th><th>PREMIO TOTAL</th><th>GANADORES</th><th>PREMIO POR GANADOR</th></tr></thead></table>
<table><tbody>` +
    rows
      .map(
        ([cat, total, winners, each]) =>
          `<tr><td>${label(cat)}</td><td class="dark-blue">${total}</td><td class="dark-blue">${winners}</td><td class="dark-blue">${each}</td></tr>`,
      )
      .join("\n") +
    `</tbody></table>`
  );
}

/** What baloto.com serves (after a 302) for a draw number that does not exist yet. */
const officialIndexPage = `<html><head><title>Resultados | Baloto</title></head><body>
<div id="container-banner-results"><h2>Resultado sorteo #2717</h2><h3>Sábado 3 de Octubre de 2026</h3></div>
<h2>VIDEO DEL ÚLTIMO SORTEO</h2><p>Sábado 3 de Octubre de 2026</p>
<h2>HISTÓRICO DE RESULTADOS</h2>
<table id="results-table"><thead><tr><th>Sorteo</th><th>Fecha</th><th>Resultado</th><th></th></tr></thead><tbody>
<tr><td><img src="/baloto-kind.png" /></td><td class="creation-date-results">3 de Octubre de 2026</td>
<td>03 - 10 - 14 - 26 - 31 - <span class="balota-red-results">10</span></td>
<td><a class="detail-button-results" href="/resultados-baloto/2717">Ver detalle</a></td></tr>
<tr><td><img src="/revancha-kind.png" /></td><td class="creation-date-results">3 de Octubre de 2026</td>
<td>19 - 23 - 27 - 38 - 40 - <span class="balota-red-results">14</span></td>
<td><a class="detail-button-results" href="/resultados-revancha/2717">Ver detalle</a></td></tr>
<tr><td><img src="/baloto-kind.png" /></td><td class="creation-date-results">30 de Septiembre de 2026</td>
<td>11 - 18 - 22 - 30 - 32 - <span class="balota-red-results">10</span></td>
<td><a class="detail-button-results" href="/resultados-baloto/2716">Ver detalle</a></td></tr>
</tbody></table></body></html>`;

describe("parseSpanishLongDate", () => {
  test("reads 'DD de Mes de YYYY' with or without accents", () => {
    expect(parseSpanishLongDate("30 de Septiembre de 2026")).toBe("2026-09-30");
    expect(parseSpanishLongDate("3 de Octubre de 2026")).toBe("2026-10-03");
    expect(parseSpanishLongDate("1 de marzo de 2024")).toBe("2024-03-01");
  });

  test("refuses malformed, unknown-month and impossible dates", () => {
    expect(() => parseSpanishLongDate("Septiembre 30, 2026")).toThrow(OfficialPageError);
    expect(() => parseSpanishLongDate("30 de Septembre de 2026")).toThrow(/Unknown month/);
    expect(() => parseSpanishLongDate("31 de Febrero de 2026")).toThrow(/Impossible calendar date/);
    expect(() => parseSpanishLongDate("")).toThrow(/Unreadable date/);
  });

  test("isDrawDay accepts Monday, Wednesday and Saturday only", () => {
    expect(isDrawDay("2026-09-30")).toBe(true); // Wednesday
    expect(isDrawDay("2026-10-03")).toBe(true); // Saturday
    expect(isDrawDay("2026-10-05")).toBe(true); // Monday
    expect(isDrawDay("2026-10-04")).toBe(false); // Sunday
    expect(isDrawDay("2026-10-02")).toBe(false); // Friday
  });
});

describe("parseOfficialDetail", () => {
  test("reads draw number, date, balls and the prize table", () => {
    const detail = parseOfficialDetail(officialPage(), "baloto", 2716);
    expect(detail.index).toBe(2716);
    expect(detail.date).toBe("2026-09-30");
    expect(detail.main).toEqual([11, 18, 22, 30, 32]);
    expect(detail.super).toBe(10);
    expect(detail.jackpot).toBe(61_200_000_000);
    expect(detail.warnings).toEqual([]);
    expect(detail.tiers).toHaveLength(8);
    // Columns on baloto.com are total, winners, per winner — not the archive's order.
    expect(detail.tiers[2]).toEqual({ tier: "4+S", totalPaid: 9_909_000, winners: 6, prizePerWinner: 1_651_500 });
    // "0 + SB" is the operator's label for the grouped "1 or 0 + SB" category.
    expect(detail.tiers[7]).toEqual({ tier: "1+S", totalPaid: 123_618_000, winners: 20_603, prizePerWinner: 6_000 });
    // An unclaimed jackpot is recorded as the pot at stake, like the archives do.
    expect(detail.tiers[0]).toEqual({ tier: "5+S", totalPaid: 0, winners: 0, prizePerWinner: 61_200_000_000 });
  });

  test("the result is a valid draw and the breakdown multiplies out", () => {
    const detail = parseOfficialDetail(officialPage(), "revancha");
    expect(isValidDraw({ date: detail.date, game: "revancha", main: detail.main, super: detail.super })).toBe(true);
    expect(breakdownIsConsistent(detail.tiers)).toBe(true);
  });

  test("recognises the results index served for a draw that does not exist", () => {
    let caught: unknown;
    try {
      parseOfficialDetail(officialIndexPage, "baloto", 2718);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OfficialPageError);
    expect((caught as OfficialPageError).kind).toBe("not-found");
  });

  test("fails loudly when the header is gone instead of guessing", () => {
    const broken = officialPage().replace("SORTEO 2.716", "Sorteo número dos mil");
    expect(() => parseOfficialDetail(broken, "baloto", 2716)).toThrow(/layout may have changed/);
  });

  test("refuses a page that reports a different draw number", () => {
    expect(() => parseOfficialDetail(officialPage({ index: "2.715" }), "baloto", 2716)).toThrow(
      /Requested baloto draw 2716 but the page reports draw 2715/,
    );
  });

  test("refuses malformed dates", () => {
    expect(() => parseOfficialDetail(officialPage({ date: "31 de Febrero de 2026" }), "baloto")).toThrow(/Impossible/);
    expect(() => parseOfficialDetail(officialPage({ date: "30 de Septembre de 2026" }), "baloto")).toThrow(/Unknown month/);
    expect(() => parseOfficialDetail(officialPage({ date: "2026-09-30" }), "baloto")).toThrow(OfficialPageError);
  });

  test("refuses a date that is not a draw night, or whose weekday contradicts it", () => {
    // 2026-10-02 is a Friday.
    expect(() =>
      parseOfficialDetail(officialPage({ weekday: "Viernes", date: "02 de Octubre de 2026" }), "baloto"),
    ).toThrow(/not a Monday, Wednesday or Saturday/);
    // 2026-09-30 is a Wednesday, not a Saturday: the page contradicts itself.
    expect(() => parseOfficialDetail(officialPage({ weekday: "Sábado" }), "baloto")).toThrow(/is not that weekday/);
  });

  test("refuses balls out of range, repeated or missing", () => {
    expect(() => parseOfficialDetail(officialPage({ balls: [11, 18, 22, 30, 44, 10] }), "baloto")).toThrow(/not a valid/);
    expect(() => parseOfficialDetail(officialPage({ balls: [11, 18, 22, 30, 32, 17] }), "baloto")).toThrow(/not a valid/);
    expect(() => parseOfficialDetail(officialPage({ balls: [11, 11, 22, 30, 32, 10] }), "baloto")).toThrow(/not a valid/);
    expect(() => parseOfficialDetail(officialPage({ balls: [11, 18, 22, 30, 32] }), "baloto")).toThrow(/six balls/);
  });

  test("falls back to the 'NN - NN - NN - NN - NN - NN' sequence when the ball elements change", () => {
    const html = officialPage().replace(/<div class="container-balls-results">[\s\S]*?<\/div><\/div>\s*<div>TOTAL/, "<p>11 - 18 - 22 - 30 - 32 - 10</p><div>TOTAL");
    expect(html).not.toContain("yellow-ball gotham");
    const detail = parseOfficialDetail(html, "baloto", 2716);
    expect(detail.main).toEqual([11, 18, 22, 30, 32]);
    expect(detail.super).toBe(10);
  });

  test("keeps the numbers but drops a prize table that does not multiply out", () => {
    const rows = officialTable([
      ["5 + SB", "$0", "0", "$0"],
      ["5", "$0", "0", "$0"],
      ["4 + SB", "$9.909.000", "37.521.175", "$1.651.500"],
      ["4", "$10.834.200", "156", "$69.450"],
      ["3 + SB", "$9.387.800", "292", "$32.150"],
      ["3", "$30.689.750", "4.615", "$6.650"],
      ["2 + SB", "$24.444.000", "2.716", "$9.000"],
      ["0 + SB", "$123.618.000", "20.603", "$6.000"],
    ]);
    const detail = parseOfficialDetail(officialPage({ table: rows }), "baloto", 2716);
    expect(detail.main).toEqual([11, 18, 22, 30, 32]);
    expect(detail.tiers).toEqual([]);
    expect(detail.warnings).toEqual(["prize table does not multiply out"]);
  });

  test("drops a prize table whose columns were reordered rather than misreading it", () => {
    const reordered = officialTable().replace(
      "<th>ACIERTOS</th><th>PREMIO TOTAL</th><th>GANADORES</th><th>PREMIO POR GANADOR</th>",
      "<th>ACIERTOS</th><th>GANADORES</th><th>PREMIO TOTAL</th><th>PREMIO POR GANADOR</th>",
    );
    const detail = parseOfficialDetail(officialPage({ table: reordered }), "baloto", 2716);
    expect(detail.tiers).toEqual([]);
    expect(detail.warnings).toEqual(["prize table not found"]);
  });
});

describe("parseOfficialIndexPage", () => {
  test("reads the latest draw number and the history rows with their games", () => {
    const { latestIndex, rows } = parseOfficialIndexPage(officialIndexPage);
    expect(latestIndex).toBe(2717);
    expect(rows).toEqual([
      { index: 2717, game: "baloto", date: "2026-10-03", main: [3, 10, 14, 26, 31], super: 10 },
      { index: 2717, game: "revancha", date: "2026-10-03", main: [19, 23, 27, 38, 40], super: 14 },
      { index: 2716, game: "baloto", date: "2026-09-30", main: [11, 18, 22, 30, 32], super: 10 },
    ]);
  });

  test("fails when the banner is missing", () => {
    expect(() => parseOfficialIndexPage("<html><body>nothing here</body></html>")).toThrow(OfficialPageError);
  });
});

describe("fetchOfficialDetail / fetchLatestOfficial", () => {
  afterEach(() => setHttpGet(null));

  const page2717 = (game: "baloto" | "revancha"): string =>
    officialPage({
      index: "2.717",
      weekday: "Sábado",
      date: "03 de Octubre de 2026",
      balls: game === "baloto" ? [3, 10, 14, 26, 31, 10] : [19, 23, 27, 38, 40, 14],
      jackpot: game === "baloto" ? "$61.600" : "$2.000",
    });

  function serve(pages: Record<string, string>, log: string[] = []) {
    setHttpGet(async (url) => {
      log.push(url);
      const path = url.replace(OFFICIAL_SOURCE, "");
      const html = pages[path];
      if (html === undefined) throw new Error(`HTTP 404 for ${url}`);
      return html;
    });
    return log;
  }

  const site: Record<string, string> = {
    "/resultados": officialIndexPage,
    "/resultados-baloto/2716": officialPage(),
    "/resultados-revancha/2716": officialPage({ balls: [4, 10, 14, 18, 23, 7], jackpot: "$3.400" }),
    "/resultados-baloto/2717": page2717("baloto"),
    "/resultados-revancha/2717": page2717("revancha"),
    // The operator redirects an unknown number to the index; the client sees the index HTML.
    "/resultados-baloto/2718": officialIndexPage,
    "/resultados-revancha/2718": officialIndexPage,
  };

  test("fetchOfficialDetail returns both games of one night", async () => {
    serve(site);
    const detail = await fetchOfficialDetail(2716);
    expect(detail.baloto.main).toEqual([11, 18, 22, 30, 32]);
    expect(detail.revancha.main).toEqual([4, 10, 14, 18, 23]);
    expect(detail.revancha.super).toBe(7);
    expect(detail.revancha.date).toBe("2026-09-30");
  });

  test("fetchOfficialDetail refuses a night whose two games carry different dates", async () => {
    serve({
      ...site,
      "/resultados-revancha/2716": officialPage({ weekday: "Lunes", date: "28 de Septiembre de 2026" }),
    });
    await expect(fetchOfficialDetail(2716)).rejects.toThrow(/Baloto is dated 2026-09-30 but Revancha 2026-09-28/);
  });

  test("walks forward from the last known index until the operator has no page", async () => {
    const log = serve(site);
    const result = await fetchLatestOfficial(2716);
    expect(result.indices).toEqual([2717]);
    expect(result.lastIndex).toBe(2717);
    expect(result.draws.map((d) => `${d.date}:${d.game}:${d.main.join(",")}+${d.super}`)).toEqual([
      "2026-10-03:baloto:3,10,14,26,31+10",
      "2026-10-03:revancha:19,23,27,38,40+14",
    ]);
    expect(result.draws.every((d) => d.provenance === "official" && d.tiers?.length === 8)).toBe(true);
    expect(log.some((u) => u.endsWith("/2718"))).toBe(true);
    expect(log.some((u) => u.endsWith("/2719"))).toBe(false);
  });

  test("a hard 404 ends the walk the same way", async () => {
    const { "/resultados-baloto/2718": _b, "/resultados-revancha/2718": _r, ...withoutRedirect } = site;
    serve(withoutRedirect);
    const result = await fetchLatestOfficial(2716);
    expect(result.indices).toEqual([2717]);
  });

  test("seeds from the results index when no draw number is known", async () => {
    const log = serve(site);
    const result = await fetchLatestOfficial(undefined);
    expect(log[0]).toBe(`${OFFICIAL_SOURCE}/resultados`);
    expect(result.indices).toEqual([2717]);
    expect(result.lastIndex).toBe(2717);
  });

  test("stops without storing a page whose date does not advance", async () => {
    serve({
      ...site,
      "/resultados-baloto/2718": page2717("baloto").replace("SORTEO 2.717", "SORTEO 2.718"),
      "/resultados-revancha/2718": page2717("revancha").replace("SORTEO 2.717", "SORTEO 2.718"),
    });
    const result = await fetchLatestOfficial(2716);
    expect(result.indices).toEqual([2717]);
    expect(result.draws).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/draw 2718 is dated 2026-10-03, not after 2026-10-03/);
  });

  test("a layout change stops the walk with the error instead of skipping the draw", async () => {
    serve({ ...site, "/resultados-baloto/2717": "<html><body>Nueva página sin estructura</body></html>" });
    await expect(fetchLatestOfficial(2716)).rejects.toThrow(/layout may have changed/);
  });
});

const draw = (over: Partial<Draw>): Draw => ({
  date: "2024-05-01",
  game: "baloto",
  main: [1, 2, 3, 4, 5],
  super: 6,
  ...over,
});

describe("reconcileDraws", () => {
  const tiers = [{ tier: "3", prizePerWinner: 8_650, winners: 4_148, totalPaid: 35_880_200 }];
  const press = draw({ date: "2026-10-03", main: [3, 10, 14, 26, 31], super: 10, provenance: "press" });

  test("a press row is replaced when the version with a prize breakdown arrives", () => {
    const official = draw({ ...press, provenance: "official", tiers });
    const { draws, conflicts, confirmed } = reconcileDraws([press], [official]);
    expect(conflicts).toEqual([]);
    expect(confirmed).toBe(1);
    expect(draws[0]!.provenance).toBe("official");
    expect(draws[0]!.tiers).toEqual(tiers);
  });

  test("agreeing archive numbers upgrade a press row without inventing a breakdown", () => {
    const archive = draw({ ...press, provenance: undefined });
    const { draws, confirmed } = reconcileDraws([press], [archive]);
    expect(draws[0]!.provenance).toBeUndefined();
    expect(draws[0]!.tiers).toBeUndefined();
    expect(confirmed).toBe(0);
  });

  test("a disagreement is recorded and the version with the breakdown is kept", () => {
    const other = draw({ ...press, main: [3, 10, 14, 26, 32], provenance: "official", tiers });
    const { draws, conflicts } = reconcileDraws([press], [other], "2026-10-04T12:00:00.000Z");
    expect(draws[0]!.main).toEqual([3, 10, 14, 26, 32]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      date: "2026-10-03",
      game: "baloto",
      kept: [3, 10, 14, 26, 32, 10],
      keptProvenance: "official",
      rejected: [3, 10, 14, 26, 31, 10],
      rejectedProvenance: "press",
      reason: "the kept version carries a consistent prize breakdown",
      detectedAt: "2026-10-04T12:00:00.000Z",
    });
  });

  test("an archive refetch that contradicts a stored breakdown never overwrites it", () => {
    const stored = draw({ tiers });
    const refetch = draw({ super: 7 });
    const { draws, conflicts } = reconcileDraws([stored], [refetch]);
    expect(draws[0]!.super).toBe(6);
    expect(draws[0]!.tiers).toEqual(tiers);
    expect(conflicts[0]!.rejected).toEqual([1, 2, 3, 4, 5, 7]);
  });

  test("on equal evidence the stored version stays and the disagreement is still recorded", () => {
    const { draws, conflicts } = reconcileDraws([draw({})], [draw({ super: 7 })]);
    expect(draws[0]!.super).toBe(6);
    expect(conflicts[0]!.reason).toMatch(/equal evidence/);
  });

  test("an official breakdown replaces an archive one for the same numbers", () => {
    const officialTiers = [{ tier: "3", prizePerWinner: 8_650, winners: 4_149, totalPaid: 35_888_850 }];
    const { draws } = reconcileDraws([draw({ tiers })], [draw({ provenance: "official", tiers: officialTiers })]);
    expect(draws[0]!.tiers).toEqual(officialTiers);
    expect(draws[0]!.provenance).toBe("official");
  });

  test("conflicts surface through datasetAnomalies and are not recorded twice", () => {
    const conflict = reconcileDraws([draw({})], [draw({ super: 7 })]).conflicts;
    const twice = appendConflicts(appendConflicts(undefined, conflict), conflict);
    expect(twice).toHaveLength(1);
    const dataset: Dataset = { updatedAt: "", sources: [], draws: [draw({})], conflicts: twice };
    const anomalies = datasetAnomalies(dataset);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.kind).toBe("conflict");
    expect(anomalies[0]!.reason).toMatch(/kept 1 2 3 4 5 6 \(archive\), rejected 1 2 3 4 5 7 \(archive\)/);
  });
});

describe("dataset hygiene", () => {
  test("rejects draws from the pre-2018 game", () => {
    expect(isValidDraw(draw({ date: "2017-12-30" }))).toBe(false);
    expect(isValidDraw(draw({ date: "2018-01-03" }))).toBe(true);
  });

  test("rejects out-of-range and unsorted draws", () => {
    expect(isValidDraw(draw({ main: [1, 2, 3, 4, 44] }))).toBe(false);
    expect(isValidDraw(draw({ main: [5, 4, 3, 2, 1] }))).toBe(false);
    expect(isValidDraw(draw({ main: [1, 1, 3, 4, 5] }))).toBe(false);
    expect(isValidDraw(draw({ super: 17 }))).toBe(false);
  });

  test("drops a result repeated on the following day", () => {
    const { draws, anomalies } = cleanDraws([
      draw({ date: "2022-11-09", main: [5, 14, 17, 31, 34], super: 3 }),
      draw({ date: "2022-11-10", main: [5, 14, 17, 31, 34], super: 3 }),
      draw({ date: "2022-11-12", main: [2, 7, 12, 26, 43], super: 4 }),
    ]);
    expect(draws.map((d) => d.date)).toEqual(["2022-11-09", "2022-11-12"]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.date).toBe("2022-11-10");
  });

  test("keeps a genuine repeat that is not on consecutive days", () => {
    const { draws } = cleanDraws([
      draw({ date: "2022-11-09" }),
      draw({ date: "2022-11-12" }),
    ]);
    expect(draws).toHaveLength(2);
  });

  test("merging never loses a prize breakdown already downloaded", () => {
    const withTiers = draw({
      tiers: [{ tier: "3", prizePerWinner: 1, winners: 1, totalPaid: 1 }],
    });
    const merged = mergeDraws([withTiers], [draw({})]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.tiers).toHaveLength(1);
  });
});
