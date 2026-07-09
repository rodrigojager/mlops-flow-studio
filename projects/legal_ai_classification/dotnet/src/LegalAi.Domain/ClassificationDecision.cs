namespace LegalAi.Domain;

public sealed record ClassificationDecision(
    string ProcessIdentifier,
    string DocumentTextHash,
    string CategoryCode,
    string ModelVersionId,
    string EmbeddingProfileId,
    string DecisionPolicyVersion,
    double? ClassifierProbability,
    double? SemanticSimilarity,
    double WorkflowRuleScore,
    double? FinalScore,
    DecisionStatus Status,
    IReadOnlyList<string> ReviewReasons)
{
    public bool RequiresHumanReview => Status != DecisionStatus.Accepted || ReviewReasons.Count > 0;

    public static ClassificationDecision Create(
        string processIdentifier,
        string documentTextHash,
        string categoryCode,
        string modelVersionId,
        LegalCatalog catalog,
        string? currentWorkflowStep,
        double? classifierProbability,
        double? semanticSimilarity)
    {
        var category = catalog.RequireCategory(categoryCode);
        var workflow = catalog.EvaluateWorkflow(categoryCode, currentWorkflowStep);
        var policy = catalog.DecisionPolicy;
        var finalScore = WeightedScore(classifierProbability, semanticSimilarity, workflow.RuleScore, policy);
        var reasons = new List<string>(workflow.Reasons);

        if (classifierProbability is not null && classifierProbability < policy.LowConfidenceThreshold)
        {
            reasons.Add("low_confidence");
        }

        if (category.Critical)
        {
            reasons.Add("critical_category");
        }

        if (category.RequiresHumanReview)
        {
            reasons.Add("category_requires_human_review");
        }

        var status = workflow.Status == DecisionStatus.Blocked
            ? DecisionStatus.Blocked
            : reasons.Count > 0 ? DecisionStatus.Review : DecisionStatus.Accepted;

        return new ClassificationDecision(
            processIdentifier,
            documentTextHash,
            categoryCode,
            modelVersionId,
            catalog.ActiveEmbeddingProfile.Id,
            policy.Version,
            classifierProbability,
            semanticSimilarity,
            workflow.RuleScore,
            finalScore,
            status,
            reasons.Distinct(StringComparer.OrdinalIgnoreCase).ToArray());
    }

    private static double? WeightedScore(
        double? classifierProbability,
        double? semanticSimilarity,
        double workflowRuleScore,
        DecisionPolicy policy)
    {
        var weighted = new List<(double Value, double Weight)>
        {
            (workflowRuleScore, policy.WorkflowRulesWeight)
        };

        if (classifierProbability is not null)
        {
            weighted.Add((classifierProbability.Value, policy.ClassifierProbabilityWeight));
        }

        if (semanticSimilarity is not null)
        {
            weighted.Add((semanticSimilarity.Value, policy.SemanticSimilarityWeight));
        }

        var totalWeight = weighted.Where(item => item.Weight > 0).Sum(item => item.Weight);
        if (totalWeight <= 0)
        {
            return classifierProbability;
        }

        return Math.Round(weighted.Where(item => item.Weight > 0).Sum(item => item.Value * item.Weight) / totalWeight, 6);
    }
}
