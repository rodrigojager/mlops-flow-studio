using System.Net.Http.Json;
using System.Text.Json;
using LegalAi.Application;

namespace LegalAi.Infrastructure;

public sealed class FastApiInferenceRuntimeClient(HttpClient httpClient) : IInferenceRuntimeClient
{
    public async Task<RuntimeClassificationResult> ClassifyAsync(
        ClassifyDocumentCommand command,
        CancellationToken cancellationToken = default)
    {
        var input = new Dictionary<string, object?>(command.Metadata)
        {
            ["numero_unico"] = command.ProcessIdentifier,
            ["texto"] = command.Text,
            ["workflow_step_atual"] = command.CurrentWorkflowStep
        };

        var response = await httpClient.PostAsJsonAsync(
            "/predict",
            new { input },
            cancellationToken).ConfigureAwait(false);

        response.EnsureSuccessStatusCode();

        using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
        var root = document.RootElement;

        var prediction = root.GetProperty("prediction").GetString() ?? throw new InvalidOperationException("Runtime não retornou prediction.");
        var modelVersionId = root.GetProperty("model_version_id").GetString() ?? "unknown";
        var confidence = root.TryGetProperty("confidence", out var confidenceElement) && confidenceElement.ValueKind == JsonValueKind.Number
            ? confidenceElement.GetDouble()
            : (double?)null;
        var semanticSimilarity = TryReadSemanticSimilarity(root);
        var raw = JsonSerializer.Deserialize<Dictionary<string, object?>>(root.GetRawText()) ?? [];

        return new RuntimeClassificationResult(
            prediction,
            modelVersionId,
            confidence,
            semanticSimilarity,
            raw);
    }

    private static double? TryReadSemanticSimilarity(JsonElement root)
    {
        if (!root.TryGetProperty("explanation", out var explanation) ||
            !explanation.TryGetProperty("scores", out var scores) ||
            !scores.TryGetProperty("semanticSimilarity", out var semantic) ||
            semantic.ValueKind != JsonValueKind.Number)
        {
            return null;
        }

        return semantic.GetDouble();
    }
}
