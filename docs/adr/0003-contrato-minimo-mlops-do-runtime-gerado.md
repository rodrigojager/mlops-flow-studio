# Contrato mínimo MLOps do runtime gerado

Decidimos que todo runtime gerado pelo MVP deve expor metadata, modelo ativo, métricas offline, métricas operacionais e status de promoção, além de saúde e predição. Sem esse contrato, a ferramenta geraria apenas APIs úteis, mas não fecharia o ciclo MLOps de versionamento, comparação objetiva, observabilidade e substituição controlada de modelos. O status de promoção deve explicar a recomendação com evidências: ganhos relevantes em verde, regressões em vermelho e mudanças dentro do threshold em estado neutro, sempre com texto/delta além da cor.
