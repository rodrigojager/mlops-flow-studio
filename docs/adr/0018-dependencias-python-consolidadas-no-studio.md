# Dependências Python consolidadas no Studio

Decidimos que dependências Python devem ser declaradas por projeto ou bloco, exibidas no Studio e consolidadas no runtime gerado como `requirements.txt` ou `pyproject.toml`. Dependências entram no hash, invalidam aprovação/build quando mudam e devem mostrar origem, conflitos simples e impacto de pacotes pesados.
