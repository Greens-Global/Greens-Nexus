$jsonlPath = "C:\Users\DELL\.gemini\antigravity\brain\e2ce67ec-d36e-4d6a-b7d1-a7103081bfc8\.system_generated\logs\transcript.jsonl"
$lines = Get-Content -Path $jsonlPath
$index = 0
foreach ($line in $lines) {
    if ($line.Contains("views/asset.js") -and $line.Contains("view_file")) {
        Write-Host "Index: $index"
        try {
            $data = ConvertFrom-Json $line -ErrorAction SilentlyContinue
            if ($null -ne $data) {
                Write-Host "  Step:" $data.step_index
                foreach ($tc in $data.tool_calls) {
                    Write-Host "    Tool:" $tc.name
                    Write-Host "    Target:" $tc.args.AbsolutePath
                }
            }
        } catch {}
    }
    $index++
}
