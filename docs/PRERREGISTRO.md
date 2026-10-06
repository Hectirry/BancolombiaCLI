# Prerregistro: la regla "fría" de la Súper Balota

Escrito el 2026-10-06, con 975 sorteos de Baloto en el dataset (2018-01-03 a
2026-10-05), **antes** de que ningún sorteo posterior exista. El propósito es
que el futuro juzgue la hipótesis sin dragado: la regla, el n, el criterio de
éxito y el tamaño de muestra quedan fijados aquí y no se tocan después.

## 1. La pista

En el torneo walk-forward (`baloto super`, warmup 400, n = 3) la regla
"lowest posterior (cold)" — las tres balotas con menos apariciones en toda la
historia — lidera con **123/575 = 21,4 %** contra 18,75 % exacto (z = +1,62).
El umbral de Bonferroni para las 13 reglas del torneo es 2,89; no lo supera.
Trece reglas honestas en una máquina justa producen un máximo de z ≈ +1,7
por puro azar, así que +1,62 es la forma exacta que tiene el ruido.

Todo lo que sigue se midió el 2026-10-06 sobre los mismos 975 sorteos para
decidir si hay algo detrás de ese máximo. **No cambia la recomendación**:
sigue siendo N balotas distintas (N/16), orden por media posterior, con la
advertencia de que el orden es un desempate dentro del ruido (CLAUDE.md,
reglas 2 y 4).

## 2. Robustez de "cold" (medido 2026-10-06)

Un hecho previo: un prior Dirichlet uniforme **nunca** cambia el orden frío —
la media posterior (c + α)/(N + 16α) es monótona en el conteo c para
cualquier α. Verificado paso a paso: con prior 1, 10 y 100 la regla juega
exactamente lo mismo en los 975 sorteos. La rejilla de prior es, por
construcción, una sola columna.

| n \ warmup | 200 | 300 | 400 | 500 |
| --- | --- | --- | --- | --- |
| 1 | 51/775 6,6 % z +0,38 | 41/675 6,1 % z −0,19 | 34/575 5,9 % z −0,33 | 28/475 5,9 % z −0,32 |
| 2 | 102/775 13,2 % z +0,56 | 88/675 13,0 % z +0,42 | 77/575 13,4 % z +0,65 | 64/475 13,5 % z +0,64 |
| **3** | 155/775 20,0 % z +0,89 | 138/675 20,4 % z +1,13 | **123/575 21,4 % z +1,62** | 98/475 20,6 % z +1,05 |
| 4 | 198/775 25,5 % z +0,35 | 175/675 25,9 % z +0,56 | 156/575 27,1 % z +1,18 | 119/475 25,1 % z +0,03 |

La celda que se reportó (n = 3, warmup 400) es el máximo de las dieciséis.
Con una sola balota la regla está **por debajo** de 1/16 en tres de cuatro
cortes: la balota "más fría" no acierta más que cualquier otra.

Tercios temporales (warmup 400, n = 3, 575 sorteos):

| Tramo | Fechas | Aciertos | Tasa | z | p binomial |
| --- | --- | --- | --- | --- | --- |
| 1 | 2021-12-08 … 2023-10-04 | 36/191 | 18,8 % | +0,03 | 1,000 |
| 2 | 2023-10-07 … 2025-07-14 | 49/192 | 25,5 % | +2,40 | 0,025 |
| 3 | 2025-07-16 … 2026-10-05 | 38/192 | 19,8 % | +0,37 | 0,768 |

El exceso completo vive en el tercio central; el primero y el último están
en 18,75 %. Un z de +2,40 como el mayor de tres tramos de la regla que ya era
la mayor de trece no es evidencia. ¿Cambio de régimen? `regimeEvidence`
(HMM de 2 estados contra i.i.d.): ΔBIC = −112,0 nats en los 975 sorteos y
−103,8 en los 575 evaluados; i.i.d. gana en ambos. No hay régimen que
explique el tramo.

Null exacto por Monte Carlo (400 historias justas de 975 sorteos, la misma
regla, el mismo corte): mediana z +0,13, desviación 1,02,
**P(z ≥ +1,62) = 0,058** para una regla sola. Entre trece, esperado.

## 3. Mecanismo: qué juega "cold"

En los 575 sorteos evaluados la regla jugó sólo **11 ternas distintas** y
cambió de terna 40 veces. Frecuencia por balota: 8 (69 %), 15 (68 %),
6 (45 %), 9 (44 %), 1 (28 %), 10 (19 %), 4 (14 %), 5 (11 %). Ternas modales:
6-9-15 (164 sorteos), 8-10-15 (92), 1-4-8 (80), 6-8-15 (53). Hoy juega
8-1-4 (conteos 49, 54, 54 de 975).

Comparación con las 560 ternas fijas sobre los mismos 575 sorteos:

| Terna | Aciertos | z | Puesto /560 |
| --- | --- | --- | --- |
| mejor fija (9-10-14) | 132 | +2,58 | 1 |
| 6-9-15 (modal de cold; también la terna fija al sorteo 400) | 119 | +1,20 | 75 |
| 8-10-15 | 112 | +0,45 | 201 |
| 1-4-8 (la de hoy) | 93 | −1,58 | 535 |
| **cold (dinámica)** | **123** | **+1,62** | percentil 96,4: 20 ternas fijas la superan |

El máximo de las 560 ternas fijas en una máquina justa tiene mediana +2,58
(Monte Carlo, 2 000 historias) — exactamente lo observado (P = 0,56): el campo
de ternas es el de una máquina justa. La regla dinámica (+1,62) supera a cada
una de sus ternas componentes (la mejor, +1,20); bajo intercambiabilidad el
*momento* de cambiar de terna no puede aportar nada, así que esos +0,4 z
extra son el azar del cambio, no una señal. "Frío" no aporta nada más allá de
la terna que esté jugando, y la terna que juega hoy (1-4-8) quedó en el
puesto 535 de 560 en el tramo evaluado.

## 4. Familia prerregistrada (definida antes de medir, medida 2026-10-06)

Seis variantes, fijadas en `coldFamilyRules()` (`src/baloto/superball.ts`)
antes de correrlas, todas con el mismo desempate (conteo total ascendente,
luego número de balota) para que nada quede escondido en la estabilidad del
`sort`. "Frío con prior fuerte" no se entra dos veces: es idéntica a la regla
original por el argumento de monotonía de la sección 2. "Más atrasada" ya
estaba en el torneo. Criterio de éxito prefijado: |z| > Φ⁻¹(1 − 0,025/19)
= **3,01** en el torneo de 13 + 6 reglas, warmup 400, n = 3.

| Regla (n = 3, warmup 400) | Aciertos | Tasa | z | Supera 3,01 |
| --- | --- | --- | --- | --- |
| lowest posterior (cold) | 123/575 | 21,4 % | +1,62 | no |
| cold and absent from the last 10 | 114/575 | 19,8 % | +0,66 | no |
| cold over the last 50 | 110/575 | 19,1 % | +0,23 | no |
| cold over the last 200 | 108/575 | 18,8 % | +0,02 | no |
| cold ensemble: rank-sum over 50/100/200/all | 106/575 | 18,4 % | −0,19 | no |
| cold, recency-weighted (half-life 100) | 105/575 | 18,3 % | −0,30 | no |
| most overdue | 99/575 | 17,2 % | −0,94 | no |
| cold over the last 100 | 98/575 | 17,0 % | −1,05 | no |

Las otras once reglas del torneo quedaron donde estaban (persist +1,30,
ciclo dominante +1,30, repetir la última +1,20, HMM +0,98, hot +0,77,
hot-100 +0,13, Markov −0,73, logística −1,37, evitar las tres últimas −1,58,
fija 1-2-3 −1,69, menos jugada −1,69). Diecinueve reglas, ninguna sale de
±1,7. Con warmup 200/300/500 las seis variantes se mueven entre −1,8 y +0,7
sin orden estable; sólo la frío-total queda siempre positiva (+0,9 a +1,6),
que es lo que se espera de una regla casi fija cuya terna modal (6-9-15)
salió +1,20 por su cuenta.

**Veredicto 2026-10-06:** la ventaja de "cold" es el máximo de trece ruidos.
Ninguna variante se acerca al umbral. La recomendación no cambia.

## 5. Hipótesis en vivo (para juzgar sin dragado)

- **Regla:** "lowest posterior (cold)", tal como está en `standardSuperRules`,
  n = 3 balotas distintas, sorteos de Baloto (no Revancha) a partir del
  2026-10-06 inclusive, puntuada por `scoreSuperRules` con warmup = 975 (todo
  lo anterior es entrenamiento, nada de ello cuenta).
- **H0:** tasa de acierto 3/16 = 18,75 %. **H1 (la que la pista sugiere):**
  21,4 %, la tasa observada in-sample.
- **Criterio de éxito:** z > 2,89 (Bonferroni del torneo de 13; si el torneo
  tiene 19 reglas, 3,01) en una muestra del tamaño indicado abajo. Un z menor
  en el camino no se interpreta; no se mira la tabla cada semana para parar
  cuando convenga (eso es lo que convierte ruido en "hallazgo").
- **Tamaño de muestra (`nightsToDistinguish`, α = 0,05 bilateral, potencia
  80 %):** 18,75 % contra 21,39 % necesita **1 767 noches** ≈ 11,3 años a
  156 sorteos/año. Contra 25 % (una balota entera de cobertura), 327 noches;
  contra 21 %, 2 425. La hipótesis **no se resolverá en una temporada** y
  este documento lo dice de antemano.
- **Qué pasaría si se cumpliera:** aun entonces, el cambio entra por el
  torneo (CLAUDE.md regla 3), nunca por este registro ni por el ledger.

## 6. Autocrítica

- La familia la definí yo mismo el día que la medí; el prerregistro está en
  el código y en este archivo con el mismo commit, no en un tercero. Vale
  como registro de intención, no como sello externo.
- Los tercios se cortaron por conteo de sorteos; cortes por año (2022 21,9 %,
  2023 22,1 %, 2024 21,2 %, 2025 22,8 %, 2026 18,5 %) muestran un exceso
  pequeño y repartido, no un pico aislado — consistente con una terna casi
  fija ligeramente afortunada, no con un tramo anómalo.
- Bonferroni sobre 19 reglas correlacionadas (las seis variantes comparten
  balotas) es conservador; un umbral por permutación sería algo más bajo, y
  aun así +1,62 queda lejos.
- Un prior *no uniforme* (una creencia distinta por balota) sí cambiaría el
  orden, pero no hay de dónde sacarlo salvo de estos mismos datos.
