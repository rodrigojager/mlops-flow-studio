# Estados explícitos de projeto, runtime e modelo

Decidimos que o Studio deve separar estados de edição, validação, teste, aprovação, geração, container, smoke e modelo ativo. Estados como `draft`, `dirty`, `valid`, `approved`, `approval_outdated`, `generated`, `built`, `running`, `smoke_passed` e `promotion_pending` orientam o usuário e controlam ações disponíveis sem misturar conceitos diferentes.
