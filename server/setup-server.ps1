<#
  Archicad License Logger: one-time server setup.

  Run on the server in PowerShell opened with "Run as administrator":
      powershell -ExecutionPolicy Bypass -File setup-server.ps1

  What it does:
    1. Checks that Git for Windows is installed.
    2. Creates a read-only deploy key for the GitHub repo and walks you through adding it.
    3. Downloads (clones) the repo to C:\ArchicadLicenseLogger.
    4. Adds a hidden scheduled task, running as SYSTEM, that fetches approved
       changes every 10 minutes. The extension reloads itself when its version changes.

  Safe to run again: it reuses the key and the folder if they already exist.
#>
param(
  [string]$Repo = 'stmoha/archicad-license-logger',
  [string]$InstallDir = 'C:\ArchicadLicenseLogger'
)

$ErrorActionPreference = 'Stop'
$KeyDir = Join-Path $env:ProgramData 'ArchicadLicenseLogger'
$Key = Join-Path $KeyDir 'deploy_key'
$KnownHosts = Join-Path $KeyDir 'known_hosts'
$TaskName = 'Archicad License Logger update'
# GitHub's published SSH host key, so the server only ever talks to the real github.com.
$GitHubHostKey = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'

function Step($text) { Write-Host ''; Write-Host $text -ForegroundColor Cyan }
function Fail($text) { Write-Host ''; Write-Host $text -ForegroundColor Red; exit 1 }
function Fwd($p) { return ($p -replace '\\', '/') }

# --- 0. Administrator check ------------------------------------------------
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'Please run this in PowerShell opened with "Run as administrator".'
}

# --- 1. Git ------------------------------------------------------------------
Step '1/4  Checking for Git'
$GitExe = $null
$cmd = Get-Command git.exe -ErrorAction SilentlyContinue
if ($cmd) { $GitExe = $cmd.Definition }
foreach ($p in @("$env:ProgramFiles\Git\cmd\git.exe", "${env:ProgramFiles(x86)}\Git\cmd\git.exe")) {
  if (-not $GitExe -and (Test-Path $p)) { $GitExe = $p }
}
if (-not $GitExe) {
  Fail ("Git for Windows isn't installed. Install it from https://git-scm.com/download/win " +
        "(the default options are fine), then run this script again. If the newest installer " +
        "won't run on this version of Windows Server, use an older Git for Windows release.")
}
# Find Git's own ssh.exe and ssh-keygen.exe (usr\bin under the Git folder).
$GitRoot = Split-Path $GitExe
while ($GitRoot -and -not (Test-Path (Join-Path $GitRoot 'usr\bin\ssh.exe'))) { $GitRoot = Split-Path $GitRoot }
if (-not $GitRoot) { Fail "Couldn't find ssh.exe in the Git for Windows folder. Reinstalling Git for Windows should fix this." }
$Ssh = Join-Path $GitRoot 'usr\bin\ssh.exe'
$SshKeygen = Join-Path $GitRoot 'usr\bin\ssh-keygen.exe'
Write-Host "     Found $GitExe"

# --- 2. Deploy key -----------------------------------------------------------
Step '2/4  Read-only deploy key'
if (-not (Test-Path $KeyDir)) { New-Item -ItemType Directory -Path $KeyDir | Out-Null }
Set-Content -Path $KnownHosts -Value $GitHubHostKey -Encoding Ascii
if (-not (Test-Path $Key)) {
  $p = Start-Process -FilePath $SshKeygen -Wait -NoNewWindow -PassThru `
        -ArgumentList "-q -t ed25519 -N `"`" -C archicad-logger-server -f `"$(Fwd $Key)`""
  if ($p.ExitCode -ne 0 -or -not (Test-Path $Key)) { Fail 'Creating the deploy key failed.' }
  # Only SYSTEM (which runs the update task) and administrators may read the private key.
  & icacls.exe $Key /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' | Out-Null
  $new = $true
} else { $new = $false }

$SshCommand = "`"$(Fwd $Ssh)`" -i `"$(Fwd $Key)`" -o IdentitiesOnly=yes -o UserKnownHostsFile=`"$(Fwd $KnownHosts)`" -o StrictHostKeyChecking=yes"
$env:GIT_SSH_COMMAND = $SshCommand

function CanReachRepo {
  $p = Start-Process -FilePath $GitExe -Wait -NoNewWindow -PassThru `
        -ArgumentList "ls-remote git@github.com:$Repo.git HEAD" `
        -RedirectStandardOutput (Join-Path $env:TEMP 'acl-lsremote.out') -RedirectStandardError (Join-Path $env:TEMP 'acl-lsremote.err')
  return ($p.ExitCode -eq 0)
}

if (-not (CanReachRepo)) {
  $pub = [IO.File]::ReadAllText("$Key.pub").Trim()
  $pub | & clip.exe
  Write-Host '     Add this key to GitHub (it is already copied to the clipboard):' -ForegroundColor Yellow
  Write-Host ''
  Write-Host "     $pub"
  Write-Host ''
  Write-Host "     1. Opening https://github.com/$Repo/settings/keys/new"
  Write-Host '     2. Title: Office server'
  Write-Host '     3. Paste the key. Leave "Allow write access" UNCHECKED.'
  Write-Host '     4. Click "Add key", then come back here.'
  try { Start-Process "https://github.com/$Repo/settings/keys/new" } catch { }
  for ($i = 0; $i -lt 5; $i++) {
    Read-Host '     Press Enter once the key is added' | Out-Null
    if (CanReachRepo) { break }
    Write-Host "     Still can't reach the repo with this key. Check it was added to $Repo, then try again." -ForegroundColor Yellow
  }
  if (-not (CanReachRepo)) { Fail "The server still can't read the repo. Check the deploy key on GitHub and run this script again." }
}
Write-Host "     The server can read $Repo"

# --- 3. Clone ----------------------------------------------------------------
Step "3/4  Downloading the logger to $InstallDir"
if (Test-Path (Join-Path $InstallDir '.git')) {
  Write-Host '     Already there, updating it'
  & $GitExe -C $InstallDir pull --ff-only
} else {
  if ((Test-Path $InstallDir) -and (Get-ChildItem $InstallDir -Force | Select-Object -First 1)) {
    Fail "$InstallDir exists and isn't empty. Move it aside or pick another folder with -InstallDir."
  }
  & $GitExe clone "git@github.com:$Repo.git" $InstallDir
  if ($LASTEXITCODE -ne 0) { Fail 'Downloading the repo failed.' }
}
& $GitExe -C $InstallDir config core.sshCommand $SshCommand
# The update task runs as SYSTEM, which doesn't own this folder; tell Git that's expected.
$safe = & $GitExe config --system --get-all safe.directory 2>$null
if (-not ($safe -contains (Fwd $InstallDir))) { & $GitExe config --system --add safe.directory (Fwd $InstallDir) }

# --- 4. Scheduled task ---------------------------------------------------------
Step '4/4  Scheduling updates every 10 minutes'
$tr = "\`"$GitExe\`" -C \`"$InstallDir\`" pull --ff-only --quiet"
$p = Start-Process -FilePath schtasks.exe -Wait -NoNewWindow -PassThru `
      -ArgumentList "/Create /F /TN `"$TaskName`" /SC MINUTE /MO 10 /RU SYSTEM /RL HIGHEST /TR `"$tr`""
if ($p.ExitCode -ne 0) { Fail 'Creating the scheduled task failed.' }
& schtasks.exe /Run /TN $TaskName | Out-Null
Start-Sleep -Seconds 15
$info = & schtasks.exe /Query /TN $TaskName /V /FO LIST | Select-String 'Last Result'
Write-Host "     Task '$TaskName' created. $info (0 means it worked)"

$ver = [regex]::Match([IO.File]::ReadAllText((Join-Path $InstallDir 'extension\manifest.json')), '"version":\s*"([^"]+)"').Groups[1].Value
Step 'Done. Last steps, in the Chrome that runs the logger:'
Write-Host '  1. Open the current Archicad License Logger popup > Settings, and copy the'
Write-Host '     Web app URL and Shared key somewhere (Notepad).'
Write-Host '  2. Go to chrome://extensions and click Remove on the old Archicad License Logger.'
Write-Host "  3. Click Load unpacked and choose $InstallDir\extension  (version $ver)"
Write-Host '  4. In its popup > Settings, paste the URL and key, then Save and test.'
Write-Host '  5. Sign in to Graphisoft on the pinned Graphisoft tab it opens.'
Write-Host ''
Write-Host 'From now on, approved changes install themselves within about 20 minutes.'
