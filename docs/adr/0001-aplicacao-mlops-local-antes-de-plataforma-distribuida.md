# Aplicação MLOps local antes de plataforma distribuída

Decidimos que a primeira saída gerada pelo MLOps Flow Studio deve ser uma aplicação FastAPI local e containerizável, inspirada no `datathon-passos-magicos`, com ingestão, treino, predição, comparação de modelos, monitoramento básico, dashboard e persistência operacional. Isso evita começar por multiusuário, Kubernetes ou orquestração distribuída antes de provar o ciclo essencial de dados -> modelos candidatos -> aprovação -> API/container -> reimportação.
