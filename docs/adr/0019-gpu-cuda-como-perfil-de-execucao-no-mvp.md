# GPU/CUDA como perfil de execução no MVP

Decidimos habilitar GPU/CUDA desde o MVP como perfil opcional de execução, com CPU como fallback. O notebook atual tem NVIDIA GeForce RTX 2050, driver CUDA funcional e Docker com runtime `nvidia`, então pipelines com embeddings/BERT podem aproveitar GPU quando configurados, desde que o Studio mostre dependências, uso de VRAM, smoke CUDA e impacto no container.

Implementação atual: a Control API expõe `GET /environment/gpu`, que verifica `nvidia-smi`, runtime Docker NVIDIA e disponibilidade de Torch/CUDA no Python do worker. A UI mostra esse status na aba Runtime e deixa explícito quando a máquina tem driver/GPU, mas a execução ainda deve cair para CPU porque Torch/CUDA ou o runtime do container não estão prontos.

O runtime gerado também expõe `GET /environment/gpu` e inclui `docker-compose.gpu.yml` como overlay. O compose principal continua funcional em CPU; quando o perfil do projeto é `gpu_cuda`, a API gerada já declara GPU no serviço principal, e quando o perfil é `auto` o overlay permite subir explicitamente com runtime NVIDIA sem impedir execução em máquinas CPU.
