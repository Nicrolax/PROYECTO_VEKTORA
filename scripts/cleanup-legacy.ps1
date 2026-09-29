# =====================================================================================
# VEKTORA — Limpieza de los archivos huérfanos de la refactorización
# =====================================================================================
# Ejecutar UNA vez desde la raíz del repositorio:
#
#     powershell -ExecutionPolicy Bypass -File .\scripts\cleanup-legacy.ps1
#
# Qué borra y por qué:
#
#  · Los 8 archivos de la RAÍZ eran la capa de IA de la FASE 2 aplanada fuera de `lib/`.
#    Su contenido se movió íntegro a `lib/ai/` y `lib/ai/providers/`; dejarlos ahí hace
#    que `tsc` compile dos copias del mismo módulo y que los imports relativos apunten a
#    la equivocada.
#
#  · Los 3 archivos de `lib/ai/` eran adaptadores de proveedor que ahora viven en
#    `lib/ai/providers/`. Sus imports (`../config`, `./http`) solo resuelven desde la
#    nueva ubicación.
#
# El script NO toca nada más: ni .env.local, ni node_modules, ni db/.
# Antes de borrar comprueba que el reemplazo existe; si falta, aborta.
# =====================================================================================

$ErrorActionPreference = 'Stop'

$legacy = @(
    @{ Path = 'ai-client.ts';                 ReplacedBy = 'lib/ai/ai-client.ts' },
    @{ Path = 'config.ts';                    ReplacedBy = 'lib/ai/config.ts' },
    @{ Path = 'embedding-models.ts';          ReplacedBy = 'lib/ai/embedding-models.ts' },
    @{ Path = 'embeddings.ts';                ReplacedBy = 'lib/ai/embeddings.ts' },
    @{ Path = 'telemetry.ts';                 ReplacedBy = 'lib/ai/telemetry.ts' },
    @{ Path = 'groq.ts';                      ReplacedBy = 'lib/ai/providers/groq.ts' },
    @{ Path = 'gemini.ts';                    ReplacedBy = 'lib/ai/providers/gemini.ts' },
    @{ Path = 'gemini-embeddings.ts';         ReplacedBy = 'lib/ai/providers/gemini-embeddings.ts' },
    @{ Path = 'lib/ai/groq.ts';               ReplacedBy = 'lib/ai/providers/groq.ts' },
    @{ Path = 'lib/ai/gemini.ts';             ReplacedBy = 'lib/ai/providers/gemini.ts' },
    @{ Path = 'lib/ai/gemini-embeddings.ts';  ReplacedBy = 'lib/ai/providers/gemini-embeddings.ts' }
)

Write-Host ''
Write-Host '=== VEKTORA - limpieza de archivos huerfanos ===' -ForegroundColor Cyan
Write-Host ''

$removed = 0
$missing = 0

foreach ($entry in $legacy) {
    $path = $entry.Path
    $replacement = $entry.ReplacedBy

    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host ("  - {0,-32} ya no existe" -f $path) -ForegroundColor DarkGray
        $missing++
        continue
    }

    if (-not (Test-Path -LiteralPath $replacement)) {
        Write-Host ("  ! {0,-32} NO se borra: falta {1}" -f $path, $replacement) -ForegroundColor Yellow
        continue
    }

    Remove-Item -LiteralPath $path -Force
    Write-Host ("  x {0,-32} -> {1}" -f $path, $replacement) -ForegroundColor Green
    $removed++
}

Write-Host ''
Write-Host ("Borrados: {0}   Ya limpios: {1}" -f $removed, $missing)
Write-Host ''
Write-Host 'Siguiente paso:' -ForegroundColor Cyan
Write-Host '  npm install'
Write-Host '  npm run verify        # typecheck + pruebas'
Write-Host '  npm run db:check      # comprueba el despliegue de Supabase'
Write-Host ''
