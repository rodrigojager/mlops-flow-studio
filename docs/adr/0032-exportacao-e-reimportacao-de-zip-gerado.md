# 0032 - Exportação e Reimportação de Zip Gerado

## Status

Aceita

## Contexto

O gate de aceite do MVP exige exportar e reimportar pasta ou zip gerado no Studio. A reimportação por pasta `.mlops` já existia, mas faltava o fluxo zip produzido pela própria ferramenta.

## Decisão

A Control API passa a expor `POST /artifacts/export-zip`, que empacota um runtime dentro de `generated/` em um `.zip` também dentro de `generated/`. O zip usa a mesma lista segura de artefatos exibida na UI, excluindo `.env`, bancos locais, caches, bytecode Python, `node_modules` e ambientes virtuais.

`POST /projects/import-runtime` passa a aceitar exatamente uma origem: `sourceDir` ou `sourceZip`. Quando `sourceZip` é usado, a API extrai o zip em diretório temporário, bloqueia entradas inseguras com caminho absoluto ou `..`, localiza a pasta com `.mlops`, reusa o fluxo de reimportação existente e remove o temporário ao final.

A UI da aba Artefatos passa a oferecer:

- gerar zip do runtime atual;
- editar o caminho do zip salvo;
- reimportar pela pasta `.mlops`;
- reimportar pelo zip salvo.

## Consequências

- O MVP avança no requisito de exportar e reimportar zip gerado pela própria ferramenta.
- O zip gerado continua sendo white-box e usa pacote `.mlops`; a importação white-box por `app/metadata` foi tratada depois na ADR 0052. Imagem Docker, repo Git ou modo black-box continuam fora deste incremento.
- A validação contra zip slip é parte do contrato de segurança da importação.
