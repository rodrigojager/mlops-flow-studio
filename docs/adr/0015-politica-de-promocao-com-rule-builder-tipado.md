# Política de promoção com rule builder tipado

Decidimos que a política de promoção deve ser configurada por um construtor visual de regras tipadas, não por um único select de métrica. Regras podem usar métricas contínuas, discretas, booleanas e categóricas, operadores apropriados ao tipo, thresholds diferentes, comparações contra modelo ativo/baseline/valor absoluto e grupos `AND`/`OR`, com severidade para bloquear, exigir revisão ou alertar. Para casos que o editor visual não cobre, uma regra pode chamar um bloco Python tipado que retorna valores simples consumidos pelo mesmo rule builder.
