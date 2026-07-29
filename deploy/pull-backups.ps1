<#
.SYNOPSIS
    Pull database snapshots and git bundles off the VPS to this machine.

.DESCRIPTION
    The server's own backups protect against a bad deploy or an accidental
    delete, but not against losing the VPS. This copies them somewhere that
    fails independently.

    rsync is unavailable on both Windows and the server, so this uses scp and
    skips files already present locally. That is safe because backup filenames
    are timestamped and their contents never change once written.

    Local retention is deliberately longer than the server's: the off-site copy
    is the one that has to survive a problem noticed late.

.EXAMPLE
    .\deploy\pull-backups.ps1
    .\deploy\pull-backups.ps1 -DestDir "D:\Backups\bot" -KeepDays 180
#>
param(
    [string]$ServerHost = "148.135.184.47",
    [string]$User       = "deploy",
    [string]$RemoteDir  = "~/TelegramGroup-AI-assistant/backups",
    [string]$DestDir    = "$env:USERPROFILE\TelegramBot-Backups",
    [int]   $KeepDays   = 90
)

# Deliberately NOT "Stop": this script leans on native commands (ssh, scp, git,
# node), and Windows PowerShell 5.1 turns any native stderr output into an
# ErrorRecord — so "Stop" aborts on things like `git bundle verify`, which
# writes its SUCCESS message to stderr. Success is judged by $LASTEXITCODE
# instead, and the few cmdlets that must not fail silently say so explicitly.
$ErrorActionPreference = "Continue"
$target = "$User@$ServerHost"

if (-not (Test-Path $DestDir)) {
    New-Item -ItemType Directory -Path $DestDir -Force -ErrorAction Stop | Out-Null
    Write-Output "Created $DestDir"
}

Write-Output "==> Listing backups on $ServerHost"
$remoteFiles = & ssh -o BatchMode=yes -o ConnectTimeout=20 $target "ls -1 $RemoteDir" 2>$null |
    Where-Object { $_ -match '\.(db|bundle)$' }

if (-not $remoteFiles) {
    Write-Output "No backups found on the server (or it was unreachable)."
    exit 1
}
Write-Output ("    {0} file(s) on server" -f $remoteFiles.Count)

$downloaded = 0
$skipped    = 0
foreach ($file in $remoteFiles) {
    $localPath = Join-Path $DestDir $file
    if (Test-Path $localPath) { $skipped++; continue }

    Write-Output "    downloading $file"
    & scp -q -o BatchMode=yes -o ConnectTimeout=20 "${target}:$RemoteDir/$file" $localPath
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "    failed to download $file"
        if (Test-Path $localPath) { Remove-Item $localPath -Force }
        continue
    }
    $downloaded++
}
Write-Output ("==> Downloaded {0}, already had {1}" -f $downloaded, $skipped)

# An unverified backup is not a backup. Check what we can with tools that are
# actually present, rather than assuming the bytes arrived intact.
Write-Output "==> Verifying"
$bad = 0

# `git bundle verify` refuses to run outside a git repository ("need a
# repository to verify a bundle"), and this script must work from any working
# directory — Task Scheduler starts in C:\Windows\System32. Give git a
# throwaway repo to run in.
$verifyRepo = Join-Path ([System.IO.Path]::GetTempPath()) "bot-bundle-verify"
if (-not (Test-Path (Join-Path $verifyRepo ".git"))) {
    $null = & git init -q $verifyRepo 2>&1
}

foreach ($bundle in (Get-ChildItem $DestDir -Filter "*.bundle" -ErrorAction SilentlyContinue)) {
    # 2>&1 into a variable, not $null: it keeps stderr out of the console
    # without PowerShell reinterpreting it as a terminating error.
    $out = & git -C $verifyRepo bundle verify $bundle.FullName 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Warning ("    CORRUPT: " + $bundle.Name + " :: " + ($out -join ' ')); $bad++ }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    foreach ($db in (Get-ChildItem $DestDir -Filter "*.db" -ErrorAction SilentlyContinue)) {
        $js = "const {DatabaseSync}=require('node:sqlite');" +
              "const d=new DatabaseSync(process.argv[1],{readOnly:true});" +
              "const r=d.prepare('PRAGMA integrity_check').get().integrity_check;" +
              "d.close(); if(r!=='ok'){process.exit(1)}"
        $out = & node -e $js $db.FullName 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Warning ("    CORRUPT: " + $db.Name + " :: " + ($out -join ' ')); $bad++ }
    }
} else {
    Write-Output "    (node not on PATH; skipped database verification)"
}

if ($bad -gt 0) {
    Write-Warning ("{0} corrupt file(s) found - NOT pruning old backups." -f $bad)
    exit 1
}
Write-Output "    all files verified"

Write-Output ("==> Pruning local copies older than {0} days" -f $KeepDays)
$cutoff = (Get-Date).AddDays(-$KeepDays)
Get-ChildItem $DestDir -Include "*.db","*.bundle" -File -Recurse |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object { Write-Output ("    removing " + $_.Name); Remove-Item $_.FullName -Force }

$all = Get-ChildItem $DestDir -Include "*.db","*.bundle" -File -Recurse
$size = ($all | Measure-Object -Property Length -Sum).Sum
Write-Output ("==> {0} file(s) held locally, {1:N1} MB in {2}" -f $all.Count, ($size / 1MB), $DestDir)
