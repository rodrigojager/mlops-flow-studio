# Domínio MLOps

## Purpose

Linguagem ubíqua para a nova plataforma. Use estes termos para evitar herdar nomes do Agent Flow Studio quando o conceito já mudou de domínio.

---

## Termos Centrais

| Termo | Significado |
| --- | --- |
| Projeto MLOps | Unidade principal de trabalho: objetivo, dados, pipelines, modelos, políticas e artefatos. |
| Autoria visual | Forma principal de montar um projeto no Studio, usando canvas, palette e inspector para produzir specs e manifestos versionáveis. |
| Autoria manual canvas-first | Caminho em que o usuário constrói o projeto arrastando blocos, conectando etapas e configurando no inspector. |
| Autoria assistida | Caminho em que wizard ou IA cria uma primeira versão do projeto/pipeline para posterior edição visual. |
| Copiloto de autoria | Uso de IA para propor ou editar projeto, pipeline, contratos, código e políticas, sempre materializando o resultado em artefatos visíveis e editáveis. |
| Agente externo | Ferramenta fora do Studio, como CLI, que gera arquivos compatíveis para o Studio abrir, validar e renderizar visualmente. |
| Estado do projeto | Status visível que informa se o projeto está em edição, válido, testado, aprovado, gerado, rodando ou com aprovação desatualizada. |
| Aprovação desatualizada | Estado em que o projeto foi aprovado anteriormente, mas mudanças posteriores invalidaram o hash aprovado. |
| Modelo ativo pendente | Situação em que existe candidato recomendado ou pendente de aprovação, mas o modelo ativo ainda não foi substituído. |
| Pipeline | Grafo de etapas de ingestão, validação, features, treino, avaliação, backtest, empacotamento e monitoramento. |
| Pipeline multi-etapa | Pipeline em que a predição final resulta da composição de modelos, transformações, regras condicionais e código determinístico. |
| DAG de inferência | Grafo acíclico direcionado que representa a execução de predição, incluindo sequência, ramificações paralelas, junções, operadores e decisão final. |
| Fan-out | Padrão em que uma mesma entrada alimenta duas ou mais etapas em paralelo. |
| Fan-in | Padrão em que saídas de várias etapas são combinadas por um operador ou decisor. |
| Etapa | Nó operacional do pipeline. |
| Execução | Rodada de pipeline, ingestão, feature build, experimento, backtest ou simulação. |
| Dataset versionado | Snapshot rastreável nas camadas raw, clean, features, training, validation, test ou predictions. |
| Fonte CSV | Fonte de dados baseada em arquivo CSV local ou upload manual. |
| Fonte SQL | Fonte de dados baseada em consulta a banco SQL configurado por referência de conexão. |
| Fonte API externa | Fonte de dados baseada em requisição HTTP configurável, com autenticação por referência segura. |
| Feature set | Contrato versionado de features reproduzíveis no treino e na inferência. |
| Experimento | Rodada de treino/avaliação com algoritmo, parâmetros, dados, métricas e artefatos. |
| Classificação multiclasse | Problema supervisionado em que o target pode assumir três ou mais classes. |
| Regressão supervisionada | Problema supervisionado em que o target é numérico contínuo. |
| Etapa determinística | Etapa implementada por regra ou código controlado, sem treinamento estatístico, usada para decisão, roteamento ou composição. |
| Bloco de função Python | Etapa visual cujo comportamento é definido por uma função Python editável, com contrato explícito de entrada e saída. |
| Contrato de bloco | Declaração dos inputs, outputs, tipos e exemplos usados para validar e executar um bloco de função Python. |
| Bloco composto | Etapa visual que encapsula um subgrafo de etapas menores e expõe um contrato próprio de entrada e saída. |
| Bloco composto aninhado | Bloco composto dentro de outro bloco composto, permitindo organizar pipelines complexos em múltiplos níveis. |
| Subgrafo | Conjunto interno de etapas e arestas dentro de um bloco composto. |
| Operador de predição | Etapa que recebe saídas de uma ou mais etapas anteriores e calcula uma saída intermediária para decisão ou composição. |
| Composição de predição | Combinação rastreável de saídas de modelos e etapas determinísticas para formar a resposta final da API. |
| Estado visual de execução | Indicação no canvas do status de cada nó e aresta durante ou após uma execução. |
| Timeline hierárquica | Painel complementar que lista execuções de etapas e subetapas em ordem temporal, incluindo blocos compostos. |
| Preview seguro | Visualização resumida de dados, entradas e saídas que evita carregar volumes grandes ou expor dados sensíveis por padrão. |
| Campo sensível | Campo marcado no schema como sensível, exigindo mascaramento em previews, logs e prediction logs por padrão. |
| Payload mascarado | Representação de um payload em que campos sensíveis são ocultados ou substituídos por valores seguros. |
| Digest de input | Hash do input usado para rastreabilidade sem persistir necessariamente o payload completo. |
| Referência de segredo | Identificador versionável que aponta para um segredo fora dos manifests, como `env:API_TOKEN`, sem incluir o valor real. |
| `.env.example` | Arquivo gerado com nomes esperados de variáveis, sem valores reais de segredo. |
| Postgres gerenciado | Banco PostgreSQL incluído no Docker Compose gerado como serviço separado da aplicação. |
| Postgres externo | Banco PostgreSQL acessado por `DATABASE_URL`, hospedado fora do compose gerado. |
| SQLite de desenvolvimento | Banco local usado apenas como fallback de baixo atrito quando o projeto permite execução sem Postgres. |
| Leaderboard | Comparação de candidatos por métrica, latência, custo e restrições de produção. |
| Modelo candidato | Modelo treinado ainda não aprovado para staging ou production. |
| Model card | Documento de uso pretendido, limitações, métricas, risco e monitoramento. |
| Contrato MLOps mínimo | Conjunto obrigatório de endpoints e metadados que torna uma aplicação gerada observável, versionável e comparável. |
| API de inferência | Runtime FastAPI exportado para predição. |
| Aplicação MLOps gerada | Aplicação FastAPI containerizável que pode incluir ingestão, treino, predição, comparação de modelos, monitoramento, dashboard e persistência operacional. |
| Runtime autônomo | Aplicação gerada que roda sem depender do Studio, usando seus próprios arquivos, dependências, manifests e configuração. |
| Runtime remoto | Runtime autônomo já executando fora do ambiente local do Studio, consultável por endpoints MLOps. |
| Observabilidade remota | Capacidade futura do Studio de se conectar a runtimes remotos para ler metadata, métricas, eventos, logs, drift e status de promoção. |
| Dashboard gerado | Interface operacional embarcada no runtime autônomo, criada a partir dos blocos, métricas, contratos e artefatos do projeto. |
| MLflow integrado | Uso opcional do MLflow para tracking de experimentos, registro de modelos e artefatos, sem substituir o Studio nem o runtime autônomo. |
| Tracking de experimento | Registro de parâmetros, métricas, tags, artefatos e modelos produzidos por uma execução de treino ou avaliação. |
| Model registry externo | Registry de modelos mantido por ferramenta externa, como MLflow, usado para versionamento e consulta sem ser a única fonte operacional do runtime. |
| Gate de aceite do MVP | Fluxo ponta a ponta mínimo que prova que o produto é utilizável, do canvas à reimportação. |
| Container reimportável | Container com manifestos e endpoints mínimos para inspeção, smoke test, comparação e evolução futura. |
| Modelo candidato selecionável | Modelo treinado e persistido que pode ser usado explicitamente por id em uma predição ou comparação, mesmo quando não é o modelo padrão. |
| Modelo ativo | Modelo atualmente usado por padrão pelo endpoint de predição da aplicação gerada. |
| Política de promoção | Regra declarativa que decide se um modelo candidato pode substituir o modelo ativo com base em qualidade, regressões, latência, schema, drift, smoke e aprovação. |
| Regra de promoção | Condição tipada dentro da política de promoção, com métrica, operador, threshold, comparação e severidade. |
| Rule builder visual | Editor visual de regras tipadas que combina variáveis, operadores, thresholds e grupos `AND`/`OR`. |
| Regra Python avançada | Bloco de função Python usado como escape hatch quando o rule builder visual não expressa a condição necessária. |
| Política de rede do bloco | Configuração que define se um bloco Python pode acessar rede, quais destinos são permitidos e se há exceção aberta. |
| Mock de API externa | Resposta simulada baseada em contrato usada para testar blocos que dependem de chamadas externas. |
| Dependência Python | Pacote Python requerido por um projeto, etapa ou bloco para executar treino, inferência ou lógica customizada. |
| Dependências consolidadas | Lista final de pacotes gerada a partir das dependências declaradas pelo projeto e pelos blocos. |
| Perfil de execução | Configuração que define se uma etapa ou runtime usa CPU, GPU/CUDA ou detecção automática com fallback. |
| Smoke CUDA | Verificação de que o runtime/container consegue detectar e usar CUDA quando o perfil exige GPU. |
| Grupo de regras | Conjunto de regras combinadas por `AND` ou `OR` para expressar condições aditivas ou alternativas. |
| Severidade de regra | Efeito de uma regra na promoção: bloquear, exigir revisão ou apenas alertar. |
| Evidência de promoção | Comparação objetiva que explica por que um candidato deve ou não substituir o modelo ativo. |
| Threshold neutro | Margem configurada em que uma diferença não deve ser tratada como melhoria nem regressão relevante. |
| Métrica offline | Métrica calculada em treino, validação, teste, avaliação ou backtest antes da operação real. |
| Métrica operacional | Métrica coletada durante uso da aplicação, como volume de predições, latência, erros, drift e desempenho quando labels reais chegam. |
| Schema operacional | Conjunto de tabelas que permite rastrear ingestão, datasets, features, treino, modelos, promoção, predições, avaliações, métricas, drift e eventos. |
| Pacote de reimportação | Pasta embarcada na saída gerada com specs, manifests, contratos, código permitido, dependências e metadados necessários para o Studio reabrir o projeto. |
| Reconfiguração | Capacidade de reabrir uma saída gerada, alterar visualmente o projeto e gerar uma nova versão. |
| Decisão de promoção | Registro persistido da recomendação e aprovação/rejeição de um modelo candidato, com evidências e thresholds. |
| Snapshot de métrica | Registro pontual de métricas offline ou operacionais para comparação e observabilidade. |
| Prediction log | Registro rastreável de input, features, modelo, output, latência, erro e label real quando disponível. |

---

## Mapeamento a Partir do Agent Flow Studio

| Agent Flow Studio | MLOps Flow Studio |
| --- | --- |
| Flow | Pipeline ou projeto |
| Nó | Etapa |
| Aresta | Dependência entre etapas |
| Sessão | Execução, experimento, backtest ou simulação |
| Turno | Step, lote, amostra ou predição |
| Transcript | Relatório, resultado, leaderboard ou prediction log |
| Runtime | Aplicação MLOps gerada, API de inferência ou container gerado |
| Studio run | Pipeline run, experiment run ou simulation run |
| Canvas | Superfície de autoria visual do pipeline |
| Inspector | Painel contextual para editar a configuração da etapa, aresta, projeto ou artefato selecionado |

---

## Termos a Preservar

Preserve quando continuarem corretos: `Studio`, `Runtime`, `Artefatos`, `Runs`, `Logs`, `Eventos`, `Aprovação`, `Manifesto`, `Schema`, `Sandbox`, `Smoke`, `API Docker`.

## Termos a Evitar no Código Novo

Evite `agent`, `turn`, `transcript`, `prompt` e `LangGraph` como nomes centrais, exceto em integrações ou migrações explicitamente justificadas.

Evite tratar specs e manifestos como interface primária do usuário. Eles são contratos versionáveis e auditáveis; a autoria principal deve ser visual.

Evite aceitar saída de IA como bloco opaco. Saída de IA deve virar grafo, contrato, código ou artefato inspecionável.

Evite tratar `Kubernetes`, `multiusuário`, `tenant`, `RBAC` e `SaaS` como parte implícita do MVP. Esses termos só entram quando houver requisito concreto.
