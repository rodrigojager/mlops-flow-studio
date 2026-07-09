using LegalAi.Application;
using LegalAi.Domain;

var catalog = LegalCatalog.CreateDefault();
var audit = new InMemoryClassificationAuditPort();
var inference = new FakeInferenceRuntimeClient("RECURSO_APELACAO", 0.91);
var useCase = new ClassifyDocumentUseCase(catalog, inference, audit);

var validAppeal = await useCase.ExecuteAsync(new ClassifyDocumentCommand(
    "0000001-00.2026.8.26.0001",
    "Recurso de apelação contra sentença.",
    "sentenca",
    new Dictionary<string, object?>()));

AssertEqual("RECURSO_APELACAO", validAppeal.CategoryCode, "categoria prevista");
AssertEqual(DecisionStatus.Review, validAppeal.Status, "recurso crítico exige revisão humana");
AssertTrue(validAppeal.RequiresHumanReview, "categoria crítica marcada para revisão");
AssertTrue(validAppeal.ReviewReasons.Contains("category_requires_human_review"), "motivo de revisão preservado");

var blockedAppeal = await useCase.ExecuteAsync(new ClassifyDocumentCommand(
    "0000002-00.2026.8.26.0001",
    "Recurso de apelação antes da sentença.",
    "citacao",
    new Dictionary<string, object?>()));

AssertEqual(DecisionStatus.Blocked, blockedAppeal.Status, "workflow inválido deve bloquear");
AssertTrue(blockedAppeal.ReviewReasons.Any(reason => reason.Contains("not_allowed", StringComparison.OrdinalIgnoreCase)), "regra bloqueadora preservada");
AssertEqual(2, audit.Items.Count, "auditoria recebeu as duas decisões");

Console.WriteLine("LegalAi.Contract.Tests: ok");

static void AssertEqual<T>(T expected, T actual, string label)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
    {
        throw new InvalidOperationException($"{label}: esperado {expected}, recebido {actual}.");
    }
}

static void AssertTrue(bool condition, string label)
{
    if (!condition)
    {
        throw new InvalidOperationException(label);
    }
}

internal sealed class FakeInferenceRuntimeClient(string categoryCode, double confidence) : IInferenceRuntimeClient
{
    public Task<RuntimeClassificationResult> ClassifyAsync(
        ClassifyDocumentCommand command,
        CancellationToken cancellationToken = default)
    {
        return Task.FromResult(new RuntimeClassificationResult(
            categoryCode,
            "legal_text_baseline",
            confidence,
            null,
            new Dictionary<string, object?>()));
    }
}
