import { expect, test, describe } from "bun:test";
import { parseDrawDetail, parseSecondaryYearPage, parseYearPage } from "../src/baloto/source.ts";
import {
  breakdownIsConsistent,
  cleanDraws,
  isValidDraw,
  mergeDraws,
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

const draw = (over: Partial<Draw>): Draw => ({
  date: "2024-05-01",
  game: "baloto",
  main: [1, 2, 3, 4, 5],
  super: 6,
  ...over,
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
