# Inferência com DAG visual flexível

Decidimos que a inferência gerada pelo Studio deve ser modelada como um DAG visual, não apenas como uma sequência linear. Isso permite tanto fluxos simples, com entrada -> tratamento -> modelo -> regra -> saída, quanto fluxos com fan-out para múltiplos modelos, fan-in em operadores, decisão determinística e composição final da resposta.
