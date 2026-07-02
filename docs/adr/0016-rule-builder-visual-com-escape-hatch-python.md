# Rule builder visual com escape hatch Python

Decidimos que regras de promoção, validação e roteamento devem ser construídas visualmente sempre que possível, mas o Studio deve oferecer um escape hatch por bloco Python tipado para casos extremos. O bloco Python deve declarar input/output, retornar valores simples consumíveis pelo rule builder, respeitar segredos por referência, rodar com timeout/sandbox e entrar no hash do runtime.
