$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$apiUrl = "http://127.0.0.1:3333"
$uiUrl = "http://127.0.0.1:5173"

function Get-PowerShellHost {
  $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
  if ($pwsh) {
    return $pwsh.Source
  }

  $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($powershell) {
    return $powershell.Source
  }

  throw "PowerShell não encontrado."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm não encontrado no PATH. Instale Node.js ou abra um terminal com Node configurado."
}

if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
  Write-Host "Dependências não encontradas. Rode primeiro: npm install" -ForegroundColor Yellow
  Read-Host "Pressione Enter para sair"
  exit 1
}

$shell = Get-PowerShellHost

$apiCommand = "Set-Location -LiteralPath '$root'; npm run dev:control-api"
$uiCommand = "Set-Location -LiteralPath '$root'; npm run dev:mlops-ui"

Start-Process -FilePath $shell -ArgumentList @("-NoProfile", "-NoExit", "-Command", $apiCommand) -WindowStyle Normal
Start-Sleep -Seconds 2
Start-Process -FilePath $shell -ArgumentList @("-NoProfile", "-NoExit", "-Command", $uiCommand) -WindowStyle Normal
Start-Sleep -Seconds 3

Start-Process $uiUrl

Write-Host "MLOps Flow Studio iniciado." -ForegroundColor Green
Write-Host "Control API: $apiUrl"
Write-Host "UI:          $uiUrl"
Write-Host ""
Write-Host "Feche as duas janelas PowerShell abertas para parar a aplicação."
