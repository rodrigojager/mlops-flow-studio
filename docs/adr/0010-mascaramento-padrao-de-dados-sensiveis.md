# Mascaramento padrão de dados sensíveis

Decidimos que campos marcados como sensíveis devem ser mascarados por padrão em previews, logs e prediction logs. O MVP deve armazenar payload completo apenas quando o projeto permitir explicitamente; caso contrário, usa payload mascarado, metadados e digest do input para manter rastreabilidade sem exposição desnecessária.
