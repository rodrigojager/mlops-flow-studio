# Legal AI Classification .NET reference

Referência compilável para a camada transacional .NET proposta no plano.

Ela mantém o domínio jurídico separado do runtime MLOps/Python:

- `LegalAi.Domain`: entidades, value objects, catálogo jurídico, políticas e invariantes.
- `LegalAi.Application`: casos de uso e portas.
- `LegalAi.Infrastructure`: cliente HTTP para o runtime FastAPI gerado e adapters.
- `LegalAi.Api`: API minimal para integração corporativa.
- `LegalAi.Contract.Tests`: console de contrato sem dependências externas.

Comandos:

```powershell
dotnet build .\LegalAi.Reference.csproj
dotnet run --project .\tests\LegalAi.Contract.Tests\LegalAi.Contract.Tests.csproj
```

O projeto não usa EF Core, Redis, Qdrant, MLflow ou LLM no domínio. Essas dependências entram por portas na Application e adapters na Infrastructure.
