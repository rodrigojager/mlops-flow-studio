# Runtime gerado autônomo

Decidimos que o runtime gerado deve rodar em qualquer máquina compatível sem depender do Studio. O Studio é responsável por autoria visual, validação, debug, geração, build, smoke e reimportação; a aplicação gerada deve carregar seus próprios modelos, dashboard, banco/compose, endpoints MLOps, artefatos e pacote de reimportação. Futuramente, o Studio pode se conectar a runtimes remotos para observabilidade, mas essa conexão é opcional e não vira dependência de execução.
