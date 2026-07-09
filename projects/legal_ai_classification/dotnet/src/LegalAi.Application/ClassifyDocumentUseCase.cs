using System.Security.Cryptography;
using System.Text;
using LegalAi.Domain;

namespace LegalAi.Application;

public sealed record ClassifyDocumentCommand(
    string ProcessIdentifier,
    string Text,
    string CurrentWorkflowStep,
    IReadOnlyDictionary<string, object?> Metadata);

public sealed record ClassifyDocumentResult(
    string CategoryCode,
    string ModelVersionId,
    string EmbeddingProfileId,
    DecisionStatus Status,
    bool RequiresHumanReview,
    IReadOnlyList<string> ReviewReasons,
    double? Confidence,
    double? FinalScore);

public sealed class ClassifyDocumentUseCase(
    LegalCatalog catalog,
    IInferenceRuntimeClient inferenceRuntime,
    IClassificationAuditPort auditPort)
{
    public async Task<ClassifyDocumentResult> ExecuteAsync(
        ClassifyDocumentCommand command,
        CancellationToken cancellationToken = default)
    {
        var runtimeResult = await inferenceRuntime.ClassifyAsync(command, cancellationToken).ConfigureAwait(false);
        var decision = ClassificationDecision.Create(
            command.ProcessIdentifier,
            Sha256(command.Text),
            runtimeResult.CategoryCode,
            runtimeResult.ModelVersionId,
            catalog,
            command.CurrentWorkflowStep,
            runtimeResult.Confidence,
            runtimeResult.SemanticSimilarity);

        await auditPort.RecordAsync(decision, cancellationToken).ConfigureAwait(false);

        return new ClassifyDocumentResult(
            decision.CategoryCode,
            decision.ModelVersionId,
            decision.EmbeddingProfileId,
            decision.Status,
            decision.RequiresHumanReview,
            decision.ReviewReasons,
            decision.ClassifierProbability,
            decision.FinalScore);
    }

    private static string Sha256(string value)
    {
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    }
}

public sealed record RuntimeClassificationResult(
    string CategoryCode,
    string ModelVersionId,
    double? Confidence,
    double? SemanticSimilarity,
    IReadOnlyDictionary<string, object?> RawOutput);

public interface IInferenceRuntimeClient
{
    Task<RuntimeClassificationResult> ClassifyAsync(
        ClassifyDocumentCommand command,
        CancellationToken cancellationToken = default);
}

public interface IClassificationAuditPort
{
    Task RecordAsync(ClassificationDecision decision, CancellationToken cancellationToken = default);
}

public sealed class InMemoryClassificationAuditPort : IClassificationAuditPort
{
    private readonly List<ClassificationDecision> _items = [];

    public IReadOnlyList<ClassificationDecision> Items => _items;

    public Task RecordAsync(ClassificationDecision decision, CancellationToken cancellationToken = default)
    {
        _items.Add(decision);
        return Task.CompletedTask;
    }
}
