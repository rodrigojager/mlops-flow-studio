# 0061 - Observabilidade Operacional de Fila e Snapshots no Studio

## Status

Aceita

## Contexto

A Control API já suportava fila FIFO local, fila filesystem compartilhada, claims, slots, workers identificados, snapshots replayáveis, archive/restore em filesystem ou S3/MinIO e criptografia opcional. Esses recursos eram verificáveis por API e testes, mas a operação diária ainda exigia inspeção indireta de jobs individuais ou arquivos.

O plano do Studio define debug visual e observabilidade como superfície primária. Para operação distribuída, o usuário precisa saber se a fila está local ou compartilhada, qual worker está ativo, quantos slots estão livres e se os snapshots estão disponíveis localmente, arquivados, ausentes ou vencidos.

## Decisão

A Control API expõe `GET /projects/:projectId/dataset-snapshots/status` como endpoint somente-leitura de observabilidade de snapshots. O payload informa:

- contagens locais de manifestos, snapshots disponíveis, ausentes, expurgados, vencidos e arquivados;
- modo dos snapshots, incluindo `masked_rows`, `full_rows` e somente manifesto;
- storage externo configurado sem expor segredos;
- criptografia por referência de chave e fingerprint;
- quantidade de metadados remotos de archive;
- amostra limitada dos artefatos de dataset versionado.

A UI passa a mostrar, na aba Studio:

- painel agregado da fila do worker com backend, worker, concorrência, slots livres, jobs em fila, recoverable e diretório compartilhado;
- painel de snapshots de dataset com storage, criptografia, contagens locais/remotas e ações explícitas de atualizar, arquivar, restaurar e expurgar vencidos;
- detalhes de backend, claim e slot nos jobs individuais quando a fila compartilhada estiver em uso.

## Consequências

- O operador consegue verificar a saúde da execução distribuída e do storage de snapshots sem abrir arquivos internos.
- Ações de archive/restore/purge permanecem explícitas e confirmadas pela UI; consulta de status não altera estado.
- Segredos de storage e criptografia continuam fora dos payloads e da UI; apenas referências e fingerprints são exibidos.
- A superfície ainda é operacional local do Studio. Ela não substitui monitoramento centralizado, alertas ou uma fila transacional futura.
