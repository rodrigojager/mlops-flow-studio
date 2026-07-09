namespace LegalAi.Domain;

public enum DecisionStatus
{
    Accepted,
    Review,
    Blocked
}

public sealed record LegalCategory(
    string Code,
    string Name,
    string Description,
    IReadOnlySet<string> WorkflowStepCodes,
    bool Critical = false,
    bool RequiresHumanReview = false);

public sealed record WorkflowStep(
    string Code,
    string Name,
    string Rite,
    int Order);

public sealed record WorkflowTransition(
    string From,
    string To,
    string Rite,
    string Severity,
    string? Condition = null,
    bool Active = true);

public sealed record EmbeddingProfile(
    string Id,
    string Provider,
    string ModelName,
    string? ModelVersion,
    int Dimension,
    string SimilarityMetric,
    string PreprocessingVersion,
    string ChunkingVersion,
    IReadOnlyDictionary<string, string> VectorCollections,
    string Status);

public sealed record DecisionPolicy(
    string Version,
    double LowConfidenceThreshold,
    double TopMarginThreshold,
    double ClassifierProbabilityWeight,
    double SemanticSimilarityWeight,
    double WorkflowRulesWeight,
    double LlmReviewWeight)
{
    public static DecisionPolicy Default { get; } = new(
        "legal-decision-policy-v1",
        LowConfidenceThreshold: 0.62,
        TopMarginThreshold: 0.08,
        ClassifierProbabilityWeight: 0.55,
        SemanticSimilarityWeight: 0.30,
        WorkflowRulesWeight: 0.15,
        LlmReviewWeight: 0);
}

public sealed class LegalCatalog
{
    private readonly Dictionary<string, LegalCategory> _categories;
    private readonly Dictionary<string, WorkflowStep> _workflowSteps;
    private readonly IReadOnlyList<WorkflowTransition> _workflowTransitions;

    public LegalCatalog(
        IEnumerable<LegalCategory> categories,
        IEnumerable<WorkflowStep> workflowSteps,
        IEnumerable<WorkflowTransition> workflowTransitions,
        EmbeddingProfile embeddingProfile,
        DecisionPolicy decisionPolicy)
    {
        _categories = categories.ToDictionary(item => item.Code, StringComparer.OrdinalIgnoreCase);
        _workflowSteps = workflowSteps.ToDictionary(item => item.Code, StringComparer.OrdinalIgnoreCase);
        _workflowTransitions = workflowTransitions.ToList();
        ActiveEmbeddingProfile = embeddingProfile;
        DecisionPolicy = decisionPolicy;
    }

    public EmbeddingProfile ActiveEmbeddingProfile { get; }

    public DecisionPolicy DecisionPolicy { get; }

    public LegalCategory RequireCategory(string code)
    {
        if (!_categories.TryGetValue(code, out var category))
        {
            throw new DomainRuleException($"Categoria jurídica desconhecida: {code}.");
        }

        return category;
    }

    public WorkflowStep? WorkflowStepOrNull(string? code)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            return null;
        }

        return _workflowSteps.TryGetValue(code, out var step) ? step : null;
    }

    public WorkflowDecision EvaluateWorkflow(string categoryCode, string? currentWorkflowStep)
    {
        var category = RequireCategory(categoryCode);
        var step = WorkflowStepOrNull(currentWorkflowStep);

        if (step is null)
        {
            return new WorkflowDecision(DecisionStatus.Review, false, 0.5, ["workflow_step_missing"]);
        }

        if (category.WorkflowStepCodes.Contains(step.Code))
        {
            return new WorkflowDecision(DecisionStatus.Accepted, true, 1.0, []);
        }

        var reviewTransition = _workflowTransitions.Any(transition =>
            transition.Active &&
            string.Equals(transition.From, step.Code, StringComparison.OrdinalIgnoreCase) &&
            category.WorkflowStepCodes.Contains(transition.To) &&
            string.Equals(transition.Severity, "review", StringComparison.OrdinalIgnoreCase));

        if (reviewTransition)
        {
            return new WorkflowDecision(DecisionStatus.Review, false, 0.75, ["workflow_requires_transition_confirmation"]);
        }

        return new WorkflowDecision(
            DecisionStatus.Blocked,
            false,
            0.0,
            [$"category_{category.Code}_not_allowed_from_{step.Code}"]);
    }

    public static LegalCatalog CreateDefault()
    {
        var categories = new[]
        {
            new LegalCategory("PETICAO_INICIAL", "Petição inicial", "Peça que inaugura a demanda.", Set("pre_distribuicao")),
            new LegalCategory("CONTESTACAO", "Contestação", "Defesa do réu.", Set("citacao")),
            new LegalCategory("SENTENCA", "Sentença", "Decisão judicial final ou relevante.", Set("sentenca"), Critical: true),
            new LegalCategory("RECURSO_APELACAO", "Recurso de apelação", "Recurso contra sentença.", Set("sentenca", "pos_sentenca"), Critical: true, RequiresHumanReview: true),
            new LegalCategory("AGRAVO_INSTRUMENTO", "Agravo de instrumento", "Recurso contra decisão interlocutória.", Set("decisao_interlocutoria"), Critical: true, RequiresHumanReview: true),
            new LegalCategory("CUMPRIMENTO_SENTENCA", "Cumprimento de sentença", "Pedido executivo decorrente de sentença.", Set("pos_sentenca", "transito_julgado"), Critical: true),
            new LegalCategory("EMBARGOS_DECLARACAO", "Embargos de declaração", "Pedido de esclarecimento.", Set("sentenca")),
            new LegalCategory("ACORDO_HOMOLOGACAO", "Acordo para homologação", "Composição amigável submetida ao juízo.", Set("audiencia_conciliacao"))
        };

        var steps = new[]
        {
            new WorkflowStep("pre_distribuicao", "Pré-distribuição", "procedimento_comum", 0),
            new WorkflowStep("citacao", "Citação e defesa", "procedimento_comum", 1),
            new WorkflowStep("audiencia_conciliacao", "Audiência ou composição", "procedimento_comum", 2),
            new WorkflowStep("instrucao", "Instrução", "procedimento_comum", 3),
            new WorkflowStep("decisao_interlocutoria", "Decisão interlocutória", "procedimento_comum", 4),
            new WorkflowStep("sentenca", "Sentença", "procedimento_comum", 5),
            new WorkflowStep("pos_sentenca", "Pós-sentença", "procedimento_comum", 6),
            new WorkflowStep("transito_julgado", "Trânsito em julgado", "procedimento_comum", 7)
        };

        var transitions = new[]
        {
            new WorkflowTransition("pre_distribuicao", "citacao", "procedimento_comum", "block"),
            new WorkflowTransition("citacao", "audiencia_conciliacao", "procedimento_comum", "review"),
            new WorkflowTransition("citacao", "instrucao", "procedimento_comum", "block"),
            new WorkflowTransition("audiencia_conciliacao", "instrucao", "procedimento_comum", "review"),
            new WorkflowTransition("instrucao", "decisao_interlocutoria", "procedimento_comum", "review"),
            new WorkflowTransition("decisao_interlocutoria", "instrucao", "procedimento_comum", "review"),
            new WorkflowTransition("instrucao", "sentenca", "procedimento_comum", "block"),
            new WorkflowTransition("sentenca", "pos_sentenca", "procedimento_comum", "block"),
            new WorkflowTransition("sentenca", "transito_julgado", "procedimento_comum", "review"),
            new WorkflowTransition("pos_sentenca", "transito_julgado", "procedimento_comum", "review")
        };

        var embedding = new EmbeddingProfile(
            "bge-m3-legal-v1",
            "sentence-transformers",
            "BAAI/bge-m3",
            "2026-07",
            1024,
            "cosine",
            "legal-preprocess-v1",
            "legal-chunking-v1",
            new Dictionary<string, string>
            {
                ["documents"] = "legal_document_chunks_bge_m3_v1",
                ["categories"] = "legal_categories_bge_m3_v1",
                ["workflowSteps"] = "legal_workflow_steps_bge_m3_v1"
            },
            "active");

        return new LegalCatalog(categories, steps, transitions, embedding, DecisionPolicy.Default);
    }

    private static IReadOnlySet<string> Set(params string[] values)
    {
        return new HashSet<string>(values, StringComparer.OrdinalIgnoreCase);
    }
}

public sealed record WorkflowDecision(
    DecisionStatus Status,
    bool Allowed,
    double RuleScore,
    IReadOnlyList<string> Reasons);

public sealed class DomainRuleException(string message) : InvalidOperationException(message);
