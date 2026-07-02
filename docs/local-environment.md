# Ambiente Local Verificado

Verificação feita em 2026-06-30 no notebook atual.

## GPU/CUDA

- GPU dedicada: NVIDIA GeForce RTX 2050.
- VRAM reportada: 4096 MiB.
- Driver NVIDIA: 595.97.
- `nvidia-smi`: funcional.
- CUDA reportado pelo driver: 13.2.
- GPU integrada adicional: Intel UHD Graphics.

## Ferramentas

- Docker Desktop: 4.74.0.
- Docker Engine: 29.4.3.
- Contexto Docker: `desktop-linux`.
- Runtime Docker `nvidia`: presente.
- WSL2: Ubuntu 24.04 e docker-desktop em execução.
- `nvcc`: não instalado no PATH.
- Python local: 3.13.
- PyTorch no Python local: não instalado no momento da verificação.
- `sentence-transformers` no Python local: instalado em 2026-07-01 (`3.4.1`) após instalação opcional para validação real de smoke.
- `transformers` no Python local: instalado em 2026-07-01 (`4.57.6`) após validação real de smoke.
- Dependências opcionais do worker na checagem de 2026-07-01: `scikit-learn` 1.8.0, `xgboost` 3.2.0, `sentence-transformers` 3.4.1, `transformers` 4.57.6, `torch` 2.12.1, `mlflow` 3.14.0 e `psycopg` 3.3.3.

## Implicação Para o Projeto

O notebook tem hardware e driver para CUDA, e Docker já expõe runtime NVIDIA. O plano deve habilitar GPU/CUDA desde o MVP como perfil opcional, mas o ambiente Python/runtime ainda precisa instalar dependências compatíveis, como PyTorch com CUDA, quando uma etapa exigir GPU.

Como a GPU tem 4 GB de VRAM, o Studio deve favorecer modelos leves, batch pequeno, cache de embeddings e fallback CPU.

O Studio expõe esse diagnóstico dinamicamente em `GET /environment/gpu` e na aba Runtime, separando driver NVIDIA, runtime Docker NVIDIA, disponibilidade de Torch/CUDA no Python do worker e fallback CPU recomendado.

O Studio também expõe `GET /environment/embedding` e o painel Embeddings/BERT na aba Runtime para checar pacotes, cache local de modelo e smoke real de `SentenceTransformer.encode`. O smoke pode ser executado com `localFilesOnly=false` para forçar download do modelo conforme necessidade.

Runtimes gerados incluem `docker-compose.gpu.yml`. Para subir um runtime exportado com GPU, usar:

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

## Dependências Opcionais do Worker

O worker roda com fallback stdlib sem dependências externas. Para habilitar treino scikit-learn, XGBoost, preview PostgreSQL real e integração MLflow localmente, instalar:

```powershell
python -m pip install -r apps\worker\requirements-optional.txt
```

Depois disso, nós de modelo com `framework: scikit-learn` ou `algorithm: logistic_regression` podem gerar artefatos `sklearn_text_classifier`/`sklearn_regressor`, nós XGBoost podem usar o backend opcional e fontes PostgreSQL podem executar preview real. O runtime exportado consegue carregar os modelos quando as mesmas dependências estiverem instaladas no container.

Para validar embeddings reais com download explícito do modelo configurado:

```powershell
Invoke-RestMethod "http://127.0.0.1:3333/environment/embedding?smoke=true&localFilesOnly=false&model=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
```
