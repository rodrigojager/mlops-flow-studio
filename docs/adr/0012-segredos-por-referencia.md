# Segredos por referência

Decidimos que o Studio deve persistir apenas referências a segredos, nunca valores reais, em specs, manifests, artefatos, hashes ou exports. No MVP, os valores ficam em `.env` local e o runtime gerado recebe `.env.example`; a UI mascara referências, permite testar conexão e acusa referências não resolvidas.
