function GetAssistantCurrent {
    $current = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $PSScriptRoot 'current.json') | ConvertFrom-Json
    if ($current.repository -ne 'arthurhpabreu/poe-assistant') { throw 'Unexpected addon installation.' }
    if ($current.direct) {
        if ($current.releaseName -notmatch '^[\w.-]+$') { throw 'Invalid release directory.' }
        $current.release = Join-Path $PSScriptRoot ('releases/' + $current.releaseName)
        $current.session = Join-Path $PSScriptRoot 'data/session.json'
        if ($current.previousName -and $current.previousName -match '^[\w.-]+$') { $current.previous = Join-Path $PSScriptRoot ('releases/' + $current.previousName) }
        $session = Get-Content -Encoding UTF8 -Raw -LiteralPath $current.session | ConvertFrom-Json
        $session.destination = $PSScriptRoot; $session.root = $current.release
        $session.state = Join-Path $PSScriptRoot 'data'; $session.runtime = Join-Path $session.state ('sessions/' + $session.id)
        $session.install = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $session.installRelative))
        $session.node = Join-Path $current.release 'runtime/node.exe'; $session.launcher = Join-Path $session.install 'PoEAssistant.lua'
        [IO.File]::WriteAllText($current.session, ($session | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
    }
    return $current
}
