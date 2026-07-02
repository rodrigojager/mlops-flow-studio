# Blocos compostos expansíveis

Decidimos que o Studio deve suportar blocos compostos expansíveis: uma etapa de alto nível pode encapsular um subgrafo interno de etapas menores, mantendo contrato próprio de entrada e saída. No MVP, a UI pode limitar a edição a um nível de profundidade, mas o modelo de dados, execução, hashing e navegação devem ser pensados para blocos compostos aninhados em N níveis. Isso permite lidar com lógicas complexas sem poluir o canvas principal, preservando a capacidade de abrir, executar, depurar e auditar os blocos internos.
