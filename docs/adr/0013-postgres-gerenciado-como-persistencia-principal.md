# Postgres gerenciado como persistência principal

Decidimos que o runtime gerado deve priorizar PostgreSQL no Docker Compose gerado, em container separado da aplicação FastAPI. SQLite pode existir como fallback de desenvolvimento e Postgres externo pode ser usado via `DATABASE_URL`, mas a experiência principal deve ser app + postgres no compose, porque logs de predição, treinos, métricas, eventos, drift e histórico precisam de persistência operacional confiável.
