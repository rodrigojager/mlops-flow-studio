# 0062 - Smoke Operacional de Embeddings SentenceTransformers

## Status

Aceita

## Contexto

O plano inclui embeddings/BERT como capacidade opcional do MVP quando necessário, e o worker já consegue treinar artefatos SentenceTransformers com estimador scikit-learn quando as dependências opcionais estão instaladas. Os testes automatizados usam encoder fake para manter a suíte rápida e determinística, mas isso não prova que o ambiente local consegue carregar um modelo real, escolher CPU/GPU ou executar `encode`.

Instalar e baixar modelos automaticamente durante a inicialização do Studio seria pesado, sujeito a rede e inadequado para máquinas com pouca VRAM. Ao mesmo tempo, o operador precisa de uma superfície clara para diferenciar pacote ausente, modelo não disponível no cache, falha de device e smoke real aprovado.

## Decisão

A Control API passa a expor `GET /environment/embedding` como diagnóstico operacional de embeddings. Por padrão, o endpoint apenas checa Python, pacotes (`sentence-transformers`, `transformers`, `torch` e `scikit-learn`), CUDA visível pelo Torch, modelo configurado e recomendação.

Quando chamado com `smoke=true`, o endpoint tenta carregar o modelo informado e executar `encode` em duas frases curtas. O parâmetro `localFilesOnly=true` é o padrão para não baixar modelos implicitamente; o operador pode desativar esse modo de forma explícita. O retorno informa dimensões, shape, device usado, duração ou mensagem de erro.

A UI passa a mostrar um painel Embeddings/BERT na aba Runtime com:

- modelo a validar;
- opção de usar apenas cache local;
- botão de checagem leve;
- botão de smoke real;
- status de pacotes, Torch/CUDA, recomendação e resultado do encode.

## Consequências

- O Studio passa a ter um caminho operacional claro para validar embeddings reais quando as dependências e o modelo estiverem disponíveis.
- A suíte continua determinística: testes cobrem o contrato do endpoint e o caminho de falha controlada sem exigir download.
- A validação real com modelo baixado/GPU continua dependendo do ambiente ter `torch`, `sentence-transformers` e cache/modelo acessível.
- O endpoint evita vazar segredos e não altera arquivos de projeto ou runtime.
