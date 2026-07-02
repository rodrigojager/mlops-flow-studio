# UI/UX reaproveitável

O Agent Flow Studio já validou uma direção de interface que combina canvas, inspector, artefatos, runtime e studio local. A plataforma MLOps deve reaproveitar esse modelo visual para reduzir curva de aprendizado e fazer o usuário sentir que está na mesma família de ferramentas.

## Estrutura de navegação sugerida

Preserve a lógica de shell operacional:

```text
Topbar
Left panel | Canvas ou superfície principal | Inspector
Statusbar
```

Para MLOps, as abas principais podem ser:

```text
Projeto | Dados | Pipeline | Experimentos | Modelos | Containers | Monitoramento | Settings
```

Ou uma versão mais enxuta para MVP:

```text
Projeto | Pipeline | Studio | Artefatos | Runtime | Settings
```

## O que copiar da UI atual

Arquivos de referência:

- `../apps/builder-ui/src/App.tsx`
- `../apps/builder-ui/src/styles.css`
- `../apps/builder-ui/src/types.ts`
- `../apps/builder-ui/src/api.ts`
- `../docs/ux/design-system.md`
- `../docs/ux/local-studio-interface-spec.md`
- `../docs/ux/local-studio-interaction-model.md`
- `../docs/ux/visual-behavior-reference-rules.md`

Componentes e padrões:

- Topbar compacta com objeto atual, ações primárias e status.
- Seletor de projeto/flow.
- Botões com ícones de `lucide-react`.
- Tema claro/escuro persistente em `localStorage`.
- Canvas com React Flow, minimap, zoom e fit view.
- Palette lateral de etapas.
- Inspector por seleção de nó/aresta/objeto.
- Aba de arquivos para editar specs e manifests.
- Aba de validação com diagnósticos clicáveis.
- Aba de artefatos com lista de arquivos, preview e zip.
- Aba de runtime com build, up, down, smoke, logs e links.
- Aba de studio com runs, timeline, state inspector e node IO.
- Status visual por nó e por aresta.
- Comparação de runs.
- Cadeia causal de falhas.
- Histórico operacional com filtros.
- Progresso de build Docker.

## Adaptação da palette

Palette atual:

- Start
- Safety
- LLM
- Code
- Switch
- HTTP
- Transform
- DB Query
- DB Save
- Arquivo
- RAG
- Approval
- Scoring
- Analytics
- End

Palette MLOps recomendada:

- Fonte de dados
- Upload/CSV
- API externa
- Scraping Playwright
- Ingestão
- Validação de dados
- Limpeza
- Feature set
- Split treino/validação/teste
- Treino Random Forest
- Treino XGBoost
- Treino Logistic Regression
- Treino BERT/embeddings
- Avaliação
- Leaderboard
- Backtest
- Aprovação
- Build container
- Smoke inferência
- Importar container
- Monitorar drift
- Código customizado
- Fim

## Adaptação do Studio Local

O Studio atual mostra sessão, transcript, eventos e nós executados. Na plataforma MLOps, use o mesmo espaço para:

- execução de ingestão;
- execução de feature build;
- execução de treino;
- execução de avaliação;
- execução de backtest;
- simulação de container;
- comparação entre modelos;
- execução de lote de predições;
- inspeção de logs, métricas e artefatos.

### Painéis equivalentes

| Studio atual | Studio MLOps |
| --- | --- |
| Run atual | Job atual, experiment run ou backtest run |
| Timeline | Timeline de etapas do pipeline |
| Node IO | Input/output de cada etapa |
| State inspector | Estado do job, datasets, features, métricas e artefatos |
| Transcript | Relatório visível, amostras de predição, leaderboard ou resumo |
| Eventos brutos | Eventos operacionais de pipeline |
| Contexto do nó | Contexto da etapa |
| Cadeia causal | Causa de falha ou impacto em etapas downstream |
| Cenários | Cenários de treino, validação, backtest ou inferência |

## Estados globais que devem existir

Copiar a disciplina de estados do Agent Flow Studio:

- `salvo`
- `sujo`
- `válido`
- `inválido`
- `gerado`
- `sandbox ativo`
- `testado`
- `aprovado`
- `aprovação desatualizada`
- `runtime buildado`
- `runtime rodando`
- `erro`
- `bloqueado`

Para MLOps, adicionar:

- `dados ingeridos`
- `qualidade aprovada`
- `features geradas`
- `experimento concluído`
- `modelo candidato`
- `staging`
- `production`
- `shadow`
- `canary`
- `archived`
- `rollback disponível`
- `drift detectado`
- `retreino sugerido`

## Telas MLOps recomendadas

### Projeto

Mostra definição do projeto, problema, target, métrica primária, fontes, políticas de aprovação e deploy.

Reaproveitar:

- editor de campos do flow;
- painel de arquivos;
- validação com diagnósticos;
- status salvo/sujo/válido.

### Dados

Mostra fontes, ingestion runs, datasets raw/clean/features, qualidade e lineage.

Reaproveitar:

- listas compactas;
- badges de status;
- links para artefatos;
- timeline de execução;
- detalhes por item no inspector.

### Pipeline

Canvas central com etapas conectadas.

Reaproveitar:

- React Flow;
- status por nó;
- arestas condicionais;
- defaults por tipo de nó;
- `applyNodeTypeDefaults`;
- validação por etapa.

### Experimentos

Leaderboard e comparação.

Reaproveitar:

- comparação de runs;
- filtros por status/fase/nó/duração;
- diffs semânticos;
- cards de métricas compactos.

### Modelos

Registry de versões.

Reaproveitar:

- aprovação por hash;
- badges;
- histórico;
- artefatos e manifests.

### Containers

Build, up, down, smoke, importação e exportação.

Reaproveitar:

- `GeneratedArtifactPanel`;
- `DockerRuntimeManager`;
- progresso de build;
- links `/docs` e `/openapi.json`;
- status de serviços.

### Monitoramento

Drift, performance, logs, alertas e gatilhos de retreino.

Reaproveitar:

- timeline;
- filtros;
- eventos;
- status por severidade;
- painéis densos, sem estética de landing page.

## Regras visuais que devem ser mantidas

- A UI deve parecer ferramenta operacional, não página de marketing.
- Canvas é superfície principal quando houver pipeline.
- Inspector contextual evita páginas soltas.
- Cards devem ser usados para itens repetidos, não como decoração.
- Estados vazios precisam indicar próxima ação.
- Botões com ícone devem ter tooltip.
- Textos devem caber em viewport desktop e compacta.
- Tema claro e escuro devem cobrir canvas, JSON, logs, tabelas e badges.
- Status não deve depender só de cor.
- Segredos devem ficar mascarados.

## Experiência para usuário das duas ferramentas

Para criar sensação de continuidade, mantenha:

- mesma densidade visual;
- mesmo padrão de topbar;
- mesma posição de canvas e inspector;
- mesmas cores semânticas de erro, sucesso, aviso e execução;
- mesmos termos para artefatos, runtime, studio, runs, logs, eventos e aprovação;
- mesmo caminho de artefato gerado e testado antes do Docker final.

O que muda é o objeto de trabalho: em vez de desenhar agente, o usuário desenha e opera uma fábrica de modelos.
