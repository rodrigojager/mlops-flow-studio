# Pacote de reimportação embarcado na saída

Decidimos que toda saída gerada deve incluir uma pasta de reimportação/reconfiguração com specs, manifests, contratos, código permitido, mocks, dependências e metadados necessários para o Studio reabrir o projeto. Aceitamos o overhead adicional no artefato/container porque reimportação, auditoria e evolução futura são objetivos centrais da plataforma.

O Studio também pode empacotar o runtime gerado em zip e reimportar esse zip quando ele foi produzido pela própria ferramenta. O zip é uma forma de transporte do mesmo pacote white-box, não um modo black-box de importar qualquer runtime externo.
