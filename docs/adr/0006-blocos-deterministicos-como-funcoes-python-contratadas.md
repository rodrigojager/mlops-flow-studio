# Blocos determinísticos como funções Python contratadas

Decidimos que operadores e etapas determinísticas devem ser representados como blocos visuais editáveis no Studio, implementados por funções Python com contrato explícito de input e output. A assinatura padrão é `run(input: dict, context: dict) -> dict`, permitindo que entradas vindas de várias etapas do DAG sejam mapeadas sem mudar a interface pública do bloco. Isso preserva a experiência visual do Agent Flow Studio, mas permite inserir lógica de negócio controlada, testável, rastreável e incluída no hash do runtime.
