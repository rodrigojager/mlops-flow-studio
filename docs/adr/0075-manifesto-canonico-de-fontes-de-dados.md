# 0075 - Manifesto canônico de fontes de dados

## Status

Aceita

## Contexto

O plano consolidado lista `data_source.yaml` como contrato versionável do MVP, separado do `dataset_manifest.yaml`. O `dataset_manifest.yaml` descreve datasets e versões observadas, mas não deixa claro quais conectores configurados alimentam o DAG visual nem quais referências de segredo precisam existir no ambiente consumidor.

## Decisão

Todo runtime gerado deve incluir `.mlops/data_source.yaml` como manifesto canônico obrigatório. O manifesto lista conectores CSV, SQL e API externa, schema, campos sensíveis, descriptor seguro, referências de segredo e vínculos com nós `data_source` do pipeline.

O manifesto não armazena linhas brutas, valores de segredo nem query SQL em texto aberto; a query é representada por hash e headers de API guardam apenas referências `env:` ou `secret:`.

## Consequências

A validação de pacote `.mlops` passa a exigir `data_source.yaml`. Runtimes antigos sem esse arquivo precisam ser regenerados ou reempacotados para passar no validador atual.

Reimportação e auditoria passam a ter um ponto estável para reconstruir conectores de dados sem depender de execução de código ou inspeção de datasets brutos.
