using LegalAi.Application;
using LegalAi.Domain;
using LegalAi.Infrastructure;

var builder = WebApplication.CreateBuilder(args);
var runtimeBaseUrl = builder.Configuration["RuntimeBaseUrl"] ?? "http://127.0.0.1:8080";

builder.Services.AddSingleton(LegalCatalog.CreateDefault());
builder.Services.AddSingleton<IClassificationAuditPort, InMemoryClassificationAuditPort>();
builder.Services.AddHttpClient<IInferenceRuntimeClient, FastApiInferenceRuntimeClient>(client =>
{
    client.BaseAddress = new Uri(runtimeBaseUrl);
});
builder.Services.AddScoped<ClassifyDocumentUseCase>();

var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { status = "ok", service = "LegalAi.Api" }));

app.MapPost("/classifications/documents", async (
    ClassifyDocumentRequest request,
    ClassifyDocumentUseCase useCase,
    CancellationToken cancellationToken) =>
{
    var result = await useCase.ExecuteAsync(
        new ClassifyDocumentCommand(
            request.ProcessIdentifier,
            request.Text,
            request.CurrentWorkflowStep,
            request.Metadata ?? new Dictionary<string, object?>()),
        cancellationToken);

    return Results.Ok(result);
});

app.Run();

public sealed record ClassifyDocumentRequest(
    string ProcessIdentifier,
    string Text,
    string CurrentWorkflowStep,
    Dictionary<string, object?>? Metadata);
