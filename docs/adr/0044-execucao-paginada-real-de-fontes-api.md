# 0044 - Execução Paginada Real de Fontes API

## Status

Aceita

## Contexto

As fontes API externas já expõem contrato visual com método, URL, headers por referência de segredo, `bodyTemplate`, timeout, mocks e política de paginação simples. Antes desta decisão, a execução real do worker chamava apenas uma resposta HTTP, então contratos `pagination.mode: page` ou `pagination.mode: cursor` eram documentados e editáveis, mas não guiavam preview ou treino reais.

O plano exige conectores de API com paginação simples, preview de schema/resposta e uso seguro de mocks quando a execução real não foi confirmada.

## Decisão

O worker passa a executar paginação real para fontes API em preview e treino quando a chamada externa foi explicitamente permitida:

- `mode: none` preserva a chamada única anterior.
- `mode: page` usa `pageParam` como parâmetro de página começando em `1`.
- `mode: cursor` usa `cursorPath` para extrair o próximo cursor da resposta e `pageParam` como nome do parâmetro enviado na próxima chamada.
- Métodos com corpo JSON (`POST`, `PUT`, `PATCH` e `DELETE` com body) recebem o parâmetro de paginação no corpo quando o body é objeto; nos demais casos, o parâmetro vai para a query string.
- A execução para ao atingir o limite solicitado, resposta vazia, ausência de cursor, cursor repetido ou limite interno de páginas.
- O resultado de preview expõe metadados de execução como `paginationMode`, `pageParam`, `pagesFetched`, `paginationStopReason` e `cursorPath`, sem expor valores de segredo ou cursor.

Mocks persistidos continuam sendo usados para preview/treino seguro sem rede externa e não tentam simular paginação automaticamente.

## Consequências

Contratos API versionados agora produzem preview e treino reais coerentes com a paginação declarada no Studio.

APIs com paginação mais complexa, paginação por offset/tamanho de página ou cursores em headers ainda exigem edição futura do contrato.

O worker mantém um limite interno de páginas para evitar loops longos em APIs que nunca retornam página vazia, cursor terminal ou linhas suficientes para alcançar o limite solicitado.
