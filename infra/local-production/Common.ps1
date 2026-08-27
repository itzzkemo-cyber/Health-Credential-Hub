[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail-LocalProduction {
  param([Parameter(Mandatory)][string]$Message)
  throw "Local production check failed: $Message"
}

function Get-RepositoryRoot {
  return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
}

function Get-NormalizedPath {
  param([Parameter(Mandatory)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-PathInside {
  param(
    [Parameter(Mandatory)][string]$ChildPath,
    [Parameter(Mandatory)][string]$ParentPath
  )

  $child = Get-NormalizedPath -Path $ChildPath
  $parent = Get-NormalizedPath -Path $ParentPath
  return $child.Equals($parent, [System.StringComparison]::OrdinalIgnoreCase) -or
    $child.StartsWith("$parent\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-OutsideUnsafeRoots {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Label
  )

  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    Fail-LocalProduction "$Label must be an absolute path"
  }
  $repositoryRoot = Get-RepositoryRoot
  $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (Test-PathInside -ChildPath $Path -ParentPath $repositoryRoot) {
    Fail-LocalProduction "$Label must be outside the Git repository"
  }
  if (Test-PathInside -ChildPath $Path -ParentPath $temporaryRoot) {
    Fail-LocalProduction "$Label must not use a temporary directory"
  }
}

function Assert-SafeIdentifier {
  param(
    [Parameter(Mandatory)][string]$Value,
    [Parameter(Mandatory)][string]$Label
  )

  if ($Value -notmatch '^[a-z_][a-z0-9_]{0,62}$') {
    Fail-LocalProduction "$Label must be a lowercase PostgreSQL identifier"
  }
}

function Get-IdentitySid {
  param([Parameter(Mandatory)][System.Security.Principal.IdentityReference]$Identity)
  try {
    return $Identity.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    Fail-LocalProduction "an ACL identity could not be translated to a SID"
  }
}

function Get-ApprovedAclSids {
  param([string[]]$AdditionalApprovedSids = @())

  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $current) {
    Fail-LocalProduction "the current Windows identity has no SID"
  }
  $approved = @(
    $current.Value,
    "S-1-5-18",      # LocalSystem
    "S-1-5-32-544"   # BUILTIN\Administrators
  )
  foreach ($sid in $AdditionalApprovedSids) {
    if ($sid -notmatch '^S-1-5-(?:21|80)-(?:[0-9]+-){1,10}[0-9]+$') {
      Fail-LocalProduction "an additional approved ACL SID is invalid"
    }
    $approved += $sid
  }
  return @($approved | Sort-Object -Unique)
}

function Assert-RestrictedAcl {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Label,
    [string[]]$AdditionalApprovedSids = @()
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    Fail-LocalProduction "$Label does not exist"
  }
  $approvedSids = Get-ApprovedAclSids -AdditionalApprovedSids $AdditionalApprovedSids
  $sensitiveRights = [System.Security.AccessControl.FileSystemRights]::Read -bor
    [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
    [System.Security.AccessControl.FileSystemRights]::Write -bor
    [System.Security.AccessControl.FileSystemRights]::Modify -bor
    [System.Security.AccessControl.FileSystemRights]::FullControl
  $acl = Get-Acl -LiteralPath $Path
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      continue
    }
    $sid = Get-IdentitySid -Identity $rule.IdentityReference
    if ($sid -notin $approvedSids -and (($rule.FileSystemRights -band $sensitiveRights) -ne 0)) {
      Fail-LocalProduction "$Label grants sensitive access to an unapproved Windows principal ($sid)"
    }
  }
}

function Set-RestrictedAcl {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][ValidateSet("File", "Directory")][string]$PathType,
    [string[]]$AdditionalApprovedSids = @()
  )

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  # Build a DACL-only descriptor. Reusing Get-Acl can carry an unreadable SACL
  # into Set-Acl and make a legitimate repeat run require SeSecurityPrivilege.
  $acl = if ($PathType -eq "Directory") {
    [System.Security.AccessControl.DirectorySecurity]::new()
  } else {
    [System.Security.AccessControl.FileSecurity]::new()
  }
  $acl.SetAccessRuleProtection($true, $false)

  $inheritance = if ($PathType -eq "Directory") {
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [System.Security.AccessControl.InheritanceFlags]::None
  }
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  foreach ($sidValue in (Get-ApprovedAclSids -AdditionalApprovedSids $AdditionalApprovedSids)) {
    $sid = [System.Security.Principal.SecurityIdentifier]::new($sidValue)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      $propagation,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $null = $acl.AddAccessRule($rule)
  }
  # Set-Acl can ask Windows to persist an empty SACL together with this new
  # DACL, which requires SeSecurityPrivilege even though no audit rule is being
  # changed. FileSystemAclExtensions writes the DACL-only descriptor as the
  # normal operator identity.
  if ($PathType -eq "Directory") {
    [System.IO.FileSystemAclExtensions]::SetAccessControl(
      [System.IO.DirectoryInfo]::new($resolved),
      $acl
    )
  } else {
    [System.IO.FileSystemAclExtensions]::SetAccessControl(
      [System.IO.FileInfo]::new($resolved),
      $acl
    )
  }
  Assert-RestrictedAcl -Path $resolved -Label $PathType -AdditionalApprovedSids $AdditionalApprovedSids
}

function Assert-EncryptedVolume {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Label
  )

  $root = [System.IO.Path]::GetPathRoot((Get-NormalizedPath -Path $Path))
  if ([string]::IsNullOrWhiteSpace($root) -or $root.StartsWith("\\")) {
    Fail-LocalProduction "$Label must be on a locally verifiable encrypted volume"
  }
  $bitLocker = Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue
  if ($null -eq $bitLocker) {
    Fail-LocalProduction "BitLocker status cannot be verified for $Label"
  }
  try {
    $volume = Get-BitLockerVolume -MountPoint $root -ErrorAction Stop
  } catch {
    Fail-LocalProduction "BitLocker status cannot be read for $Label"
  }
  if ($volume.VolumeStatus -ne "FullyEncrypted" -or
      $volume.ProtectionStatus -ne "On" -or
      [int]$volume.EncryptionPercentage -ne 100) {
    Fail-LocalProduction "$Label must be fully encrypted with BitLocker protection enabled"
  }
}

function Enable-EfsEncryption {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    Fail-LocalProduction "$Label does not exist"
  }
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $item = Get-Item -LiteralPath $resolved -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail-LocalProduction "$Label must not be a reparse point"
  }
  $cipher = Get-Command cipher.exe -ErrorAction SilentlyContinue
  if ($null -eq $cipher) {
    Fail-LocalProduction "Windows EFS tooling is unavailable for $Label"
  }
  & $cipher.Source /E /A /H /I /Q $resolved *> $null
  if ($LASTEXITCODE -ne 0) {
    Fail-LocalProduction "Windows EFS could not encrypt $Label"
  }
  $item.Refresh()
  if (($item.Attributes -band [IO.FileAttributes]::Encrypted) -eq 0) {
    Fail-LocalProduction "$Label is not protected by Windows EFS"
  }
}

function Assert-EfsEncryptedDirectory {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    Fail-LocalProduction "$Label does not exist"
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail-LocalProduction "$Label must not be a reparse point"
  }
  if (($item.Attributes -band [IO.FileAttributes]::Encrypted) -eq 0) {
    Fail-LocalProduction "$Label must be protected by Windows EFS"
  }
}

function Get-WindowsDefenderExecutable {
  param([Parameter(Mandatory)]$Config)

  if ($env:OS -ne "Windows_NT") {
    Fail-LocalProduction "the local malware scanner requires Windows"
  }
  $candidate = [string]$Config.windowsDefenderMpCmdRunPath
  if ([string]::IsNullOrWhiteSpace($candidate) -or
      -not [IO.Path]::IsPathRooted($candidate) -or
      [IO.Path]::GetFileName($candidate) -ine "MpCmdRun.exe" -or
      -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    Fail-LocalProduction "windowsDefenderMpCmdRunPath must name an existing absolute MpCmdRun.exe"
  }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  $item = Get-Item -LiteralPath $resolved -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail-LocalProduction "MpCmdRun.exe must not be a reparse point"
  }

  $approvedRoots = @(
    (Join-Path $env:ProgramData "Microsoft\Windows Defender\Platform"),
    (Join-Path $env:ProgramFiles "Windows Defender")
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  if (-not ($approvedRoots | Where-Object {
        Test-PathInside -ChildPath $resolved -ParentPath $_
      })) {
    Fail-LocalProduction "MpCmdRun.exe must be under an approved Windows Defender installation directory"
  }

  try {
    $signature = Get-AuthenticodeSignature -LiteralPath $resolved -ErrorAction Stop
  } catch {
    Fail-LocalProduction "the MpCmdRun.exe Authenticode signature could not be verified"
  }
  if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
      $null -eq $signature.SignerCertificate -or
      [string]$signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
    Fail-LocalProduction "MpCmdRun.exe must have a valid Microsoft Authenticode signature"
  }
  return $resolved
}

function Assert-WindowsDefenderReady {
  param([Parameter(Mandatory)]$Config)

  $resolved = Get-WindowsDefenderExecutable -Config $Config
  $statusCommand = Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue
  if ($null -eq $statusCommand) {
    Fail-LocalProduction "Windows Defender status cannot be verified"
  }
  try {
    $status = & $statusCommand
  } catch {
    Fail-LocalProduction "Windows Defender status could not be read"
  }
  foreach ($property in @(
      "AMServiceEnabled",
      "AntivirusEnabled",
      "RealTimeProtectionEnabled",
      "AMRunningMode",
      "AntivirusSignatureLastUpdated",
      "AntivirusSignatureVersion"
    )) {
    if ($status.PSObject.Properties.Name -notcontains $property) {
      Fail-LocalProduction "Windows Defender status is missing $property"
    }
  }
  if ($status.AMServiceEnabled -ne $true -or
      $status.AntivirusEnabled -ne $true -or
      $status.RealTimeProtectionEnabled -ne $true -or
      [string]$status.AMRunningMode -ne "Normal") {
    Fail-LocalProduction "Windows Defender antivirus and real-time protection must be active in Normal mode"
  }
  if ([string]::IsNullOrWhiteSpace([string]$status.AntivirusSignatureVersion)) {
    Fail-LocalProduction "Windows Defender has no antivirus signature version"
  }
  try {
    $signatureUpdatedAt = ([DateTime]$status.AntivirusSignatureLastUpdated).ToUniversalTime()
  } catch {
    Fail-LocalProduction "Windows Defender signature age cannot be verified"
  }
  $maximumAgeHours = [int]$Config.maxDefenderSignatureAgeHours
  if ($signatureUpdatedAt -gt [DateTime]::UtcNow.AddMinutes(5) -or
      [DateTime]::UtcNow.Subtract($signatureUpdatedAt).TotalHours -gt $maximumAgeHours) {
    Fail-LocalProduction "Windows Defender antivirus signatures are stale or have an invalid timestamp"
  }
  if ($status.PSObject.Properties.Name -contains "DefenderSignaturesOutOfDate" -and
      $status.DefenderSignaturesOutOfDate -eq $true) {
    Fail-LocalProduction "Windows Defender reports out-of-date signatures"
  }
  return $resolved
}

function Invoke-WindowsDefenderReadinessProbe {
  param(
    [Parameter(Mandatory)]$Config,
    [Parameter(Mandatory)][string]$ExecutablePath
  )

  $quarantine = (Resolve-Path -LiteralPath $Config.quarantineRoot).Path
  $probeId = [Guid]::NewGuid().ToString("N")
  $probePath = Join-Path $quarantine ".defender-probe-$probeId.txt"
  $stdoutPath = Join-Path $quarantine ".defender-probe-$probeId.stdout"
  $stderrPath = Join-Path $quarantine ".defender-probe-$probeId.stderr"
  $process = $null
  try {
    [IO.File]::WriteAllText($probePath, "Health Credential Hub Defender readiness probe $probeId")
    Set-RestrictedAcl -Path $probePath -PathType File
    $process = Start-Process -FilePath $ExecutablePath -ArgumentList @(
      "-Scan", "-ScanType", "3", "-File", ('"{0}"' -f $probePath), "-DisableRemediation"
    ) -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    if (-not $process.WaitForExit([int]$Config.malwareScanTimeoutMs)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      Fail-LocalProduction "the Windows Defender readiness scan timed out"
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      Fail-LocalProduction "the Windows Defender readiness scan did not return a clean result"
    }
  } catch {
    if ($_.Exception.Message -like "Local production check failed:*") { throw }
    Fail-LocalProduction "the Windows Defender readiness scan could not run"
  } finally {
    foreach ($file in @($probePath, $stdoutPath, $stderrPath)) {
      if (Test-Path -LiteralPath $file -PathType Leaf) {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

function Assert-VolumeAttestation {
  param(
    [Parameter(Mandatory)]$Config,
    [Parameter(Mandatory)][string]$ConfigPath,
    [string]$SecretsPath = ""
  )

  $evidencePath = Join-Path $Config.runtimeRoot "volume-attestation.json"
  if (-not (Test-Path -LiteralPath $evidencePath -PathType Leaf)) {
    Fail-LocalProduction "an elevated BitLocker volume attestation is required"
  }
  Assert-RestrictedAcl -Path $evidencePath -Label "BitLocker volume attestation"
  try {
    $attestation = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
    $verifiedAt = [DateTime]::Parse(
      [string]$attestation.verifiedAtUtc,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    ).ToUniversalTime()
  } catch {
    Fail-LocalProduction "the BitLocker volume attestation is malformed"
  }
  $maximumAge = [int]$Config.maxVolumeAttestationAgeDays
  if ($maximumAge -lt 1 -or $maximumAge -gt 7 -or
      $attestation.schemaVersion -ne 1 -or
      $verifiedAt -gt [DateTime]::UtcNow.AddMinutes(5) -or
      [DateTime]::UtcNow.Subtract($verifiedAt).TotalDays -gt $maximumAge) {
    Fail-LocalProduction "the BitLocker volume attestation is missing, expired, or invalid"
  }

  $paths = @(
    [string]$Config.runtimeRoot,
    [string]$Config.objectStorageRoot,
    [string]$Config.quarantineRoot,
    [string]$Config.postgresDataRoot,
    [string]$Config.backupRoot,
    [string]$ConfigPath
  )
  if (-not [string]::IsNullOrWhiteSpace($SecretsPath)) { $paths += $SecretsPath }
  $expectedRoots = @($paths | ForEach-Object {
      [IO.Path]::GetPathRoot((Get-NormalizedPath -Path $_)).ToUpperInvariant()
    } | Sort-Object -Unique)
  $recorded = @($attestation.volumes)
  foreach ($root in $expectedRoots) {
    $entry = @($recorded | Where-Object { ([string]$_.mountPoint).ToUpperInvariant() -eq $root })
    if ($entry.Count -ne 1 -or $entry[0].fullyEncrypted -ne $true -or
        $entry[0].protectionOn -ne $true -or $entry[0].fileSystem -ne "NTFS") {
      Fail-LocalProduction "the BitLocker volume attestation does not approve $root"
    }
    $driveLetter = $root.TrimEnd('\').TrimEnd(':')
    try {
      $currentVolume = Get-Volume -DriveLetter $driveLetter -ErrorAction Stop
    } catch {
      Fail-LocalProduction "the attested volume $root is unavailable"
    }
    if ([string]$currentVolume.UniqueId -ne [string]$entry[0].uniqueId -or
        [string]$currentVolume.FileSystemType -ne "NTFS" -or
        [string]$currentVolume.HealthStatus -ne "Healthy") {
      Fail-LocalProduction "the attested volume $root changed or is unhealthy"
    }
  }
}

function Read-LocalProductionConfig {
  param([Parameter(Mandatory)][string]$ConfigPath)

  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    Fail-LocalProduction "the configuration file does not exist"
  }
  $resolved = (Resolve-Path -LiteralPath $ConfigPath).Path
  Assert-OutsideUnsafeRoots -Path $resolved -Label "the configuration file"
  Assert-RestrictedAcl -Path $resolved -Label "the configuration file"
  try {
    $config = Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json
  } catch {
    Fail-LocalProduction "the configuration file is not valid JSON"
  }
  if ($config.schemaVersion -ne 1) {
    Fail-LocalProduction "config schemaVersion must equal 1"
  }
  return $config
}

function Get-SecureStringPlainText {
  param([Parameter(Mandatory)][Security.SecureString]$Value)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Read-LocalProductionSecrets {
  param([Parameter(Mandatory)][string]$SecretsPath)

  if (-not (Test-Path -LiteralPath $SecretsPath -PathType Leaf)) {
    Fail-LocalProduction "the DPAPI secret bundle does not exist"
  }
  $resolved = (Resolve-Path -LiteralPath $SecretsPath).Path
  Assert-OutsideUnsafeRoots -Path $resolved -Label "the DPAPI secret bundle"
  Assert-RestrictedAcl -Path $resolved -Label "the DPAPI secret bundle"
  try {
    $secrets = Import-Clixml -LiteralPath $resolved
  } catch {
    Fail-LocalProduction "the DPAPI secret bundle could not be decrypted by this Windows identity"
  }
  foreach ($name in @(
      "AppDatabasePassword",
      "MigratorDatabasePassword",
      "SessionSecret",
      "TotpEncryptionKey"
    )) {
    if ($secrets.PSObject.Properties.Name -notcontains $name -or
        $secrets.$name -isnot [Security.SecureString]) {
      Fail-LocalProduction "the DPAPI secret bundle is missing $name"
    }
  }
  return $secrets
}

function Assert-ConfigValues {
  param([Parameter(Mandatory)]$Config)

  foreach ($property in @(
      "quarantineRoot",
      "windowsDefenderMpCmdRunPath",
      "malwareScanTimeoutMs",
      "maxDefenderSignatureAgeHours"
    )) {
    if ($Config.PSObject.Properties.Name -notcontains $property) {
      Fail-LocalProduction "the configuration is missing $property"
    }
  }

  if ($Config.nodeEnv -ne "production") {
    Fail-LocalProduction "nodeEnv must equal production"
  }
  if ($Config.bindHost -ne "127.0.0.1" -or [int]$Config.port -ne 3000) {
    Fail-LocalProduction "the API must bind only to 127.0.0.1:3000"
  }
  if ($Config.publicAppUrl -ne "https://app.wathaiqihealth.com") {
    Fail-LocalProduction "publicAppUrl must equal https://app.wathaiqihealth.com"
  }
  if ($Config.objectStorageProvider -ne "filesystem") {
    Fail-LocalProduction "objectStorageProvider must equal filesystem"
  }
  if ([int]$Config.maxVolumeAttestationAgeDays -lt 1 -or
      [int]$Config.maxVolumeAttestationAgeDays -gt 7) {
    Fail-LocalProduction "maxVolumeAttestationAgeDays must be between 1 and 7"
  }
  if ([int]$Config.malwareScanTimeoutMs -lt 5000 -or
      [int]$Config.malwareScanTimeoutMs -gt 120000) {
    Fail-LocalProduction "malwareScanTimeoutMs must be between 5000 and 120000"
  }
  if ([int]$Config.maxDefenderSignatureAgeHours -lt 1 -or
      [int]$Config.maxDefenderSignatureAgeHours -gt 168) {
    Fail-LocalProduction "maxDefenderSignatureAgeHours must be between 1 and 168"
  }
  if ([string]::IsNullOrWhiteSpace([string]$Config.windowsDefenderMpCmdRunPath) -or
      -not [IO.Path]::IsPathRooted([string]$Config.windowsDefenderMpCmdRunPath) -or
      [IO.Path]::GetFileName([string]$Config.windowsDefenderMpCmdRunPath) -ine "MpCmdRun.exe") {
    Fail-LocalProduction "windowsDefenderMpCmdRunPath must be an absolute MpCmdRun.exe path"
  }
  if ($Config.privateObjectDir -notmatch '^/[a-z0-9][a-z0-9-]{2,62}/private$') {
    Fail-LocalProduction "privateObjectDir must use /bucket-name/private form"
  }
  if ($Config.database.host -ne "127.0.0.1" -or
      [int]$Config.database.port -lt 1 -or
      [int]$Config.database.port -gt 65535) {
    Fail-LocalProduction "PostgreSQL must use a valid loopback port"
  }
  if ($Config.database.sslMode -ne "disable") {
    Fail-LocalProduction "database.sslMode must be disable for the loopback-only PostgreSQL profile"
  }
  $postgresServiceSid = [string]$Config.database.windowsServiceSid
  if (-not [string]::IsNullOrWhiteSpace($postgresServiceSid) -and
      $postgresServiceSid -notmatch '^S-1-5-(?:21|80)-(?:[0-9]+-){1,10}[0-9]+$') {
    Fail-LocalProduction "database.windowsServiceSid must be a dedicated Windows account or service SID"
  }
  foreach ($entry in @(
      @($Config.database.name, "database.name"),
      @($Config.database.appUser, "database.appUser"),
      @($Config.database.appRole, "database.appRole"),
      @($Config.database.migratorUser, "database.migratorUser"),
      @($Config.database.migratorRole, "database.migratorRole")
    )) {
    Assert-SafeIdentifier -Value $entry[0] -Label $entry[1]
  }
  if ($Config.database.name -in @("postgres", "template0", "template1")) {
    Fail-LocalProduction "database.name must be a dedicated application database"
  }
  if (@(
      $Config.database.appUser,
      $Config.database.appRole,
      $Config.database.migratorUser,
      $Config.database.migratorRole
    ) | Sort-Object -Unique | Measure-Object | Select-Object -ExpandProperty Count | Where-Object { $_ -ne 4 }) {
    Fail-LocalProduction "application and migration users/roles must all be distinct"
  }

  $paths = @(
    @($Config.runtimeRoot, "runtimeRoot"),
    @($Config.objectStorageRoot, "objectStorageRoot"),
    @($Config.quarantineRoot, "quarantineRoot"),
    @($Config.postgresDataRoot, "postgresDataRoot"),
    @($Config.backupRoot, "backupRoot")
  )
  foreach ($entry in $paths) {
    Assert-OutsideUnsafeRoots -Path $entry[0] -Label $entry[1]
  }
  for ($left = 0; $left -lt $paths.Count; $left++) {
    for ($right = $left + 1; $right -lt $paths.Count; $right++) {
      if ((Test-PathInside -ChildPath $paths[$left][0] -ParentPath $paths[$right][0]) -or
          (Test-PathInside -ChildPath $paths[$right][0] -ParentPath $paths[$left][0])) {
        Fail-LocalProduction "$($paths[$left][1]) and $($paths[$right][1]) must not overlap"
      }
    }
  }
  $backupVolume = [System.IO.Path]::GetPathRoot((Get-NormalizedPath -Path $Config.backupRoot))
  foreach ($source in @($Config.objectStorageRoot, $Config.postgresDataRoot)) {
    $sourceVolume = [System.IO.Path]::GetPathRoot((Get-NormalizedPath -Path $source))
    if ($backupVolume.Equals($sourceVolume, [System.StringComparison]::OrdinalIgnoreCase)) {
      Fail-LocalProduction "backupRoot must be on a different encrypted volume from database and object data"
    }
  }
  $quarantineVolume = [System.IO.Path]::GetPathRoot((Get-NormalizedPath -Path $Config.quarantineRoot))
  $objectVolume = [System.IO.Path]::GetPathRoot((Get-NormalizedPath -Path $Config.objectStorageRoot))
  if (-not $quarantineVolume.Equals($objectVolume, [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail-LocalProduction "quarantineRoot must use the same encrypted volume as objectStorageRoot"
  }
}

function Get-PostgresTool {
  param(
    [Parameter(Mandatory)]$Config,
    [Parameter(Mandatory)][ValidateSet("psql", "pg_dump", "pg_restore", "createdb", "dropdb")][string]$Name
  )

  $candidate = Join-Path $Config.postgresBin "$Name.exe"
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    Fail-LocalProduction "$Name.exe was not found under postgresBin"
  }
  return (Resolve-Path -LiteralPath $candidate).Path
}

function Get-NodeExecutable {
  param([Parameter(Mandatory)]$Config)

  $candidate = [string]$Config.nodePath
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -ne $nodeCommand) {
      $candidate = $nodeCommand.Source
    } else {
      $candidate = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    }
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    Fail-LocalProduction "Node.js was not found; set nodePath to the reviewed Node 24 executable"
  }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  $version = (& $resolved --version 2>$null).TrimStart('v')
  if ($LASTEXITCODE -ne 0 -or -not $version.StartsWith("24.")) {
    Fail-LocalProduction "the runtime requires Node.js 24"
  }
  return $resolved
}

function New-DatabaseUrl {
  param(
    [Parameter(Mandatory)]$Config,
    [Parameter(Mandatory)][string]$User,
    [Parameter(Mandatory)][Security.SecureString]$Password
  )

  $plain = Get-SecureStringPlainText -Value $Password
  try {
    $encodedUser = [Uri]::EscapeDataString($User)
    $encodedPassword = [Uri]::EscapeDataString($plain)
    $encodedDatabase = [Uri]::EscapeDataString([string]$Config.database.name)
    return "postgresql://${encodedUser}:${encodedPassword}@127.0.0.1:$($Config.database.port)/${encodedDatabase}?sslmode=disable"
  } finally {
    $plain = $null
  }
}

function Invoke-PsqlScalar {
  param(
    [Parameter(Mandatory)]$Config,
    [Parameter(Mandatory)][string]$User,
    [Parameter(Mandatory)][Security.SecureString]$Password,
    [Parameter(Mandatory)][string]$Query
  )

  $psql = Get-PostgresTool -Config $Config -Name psql
  $plain = Get-SecureStringPlainText -Value $Password
  $previous = $env:PGPASSWORD
  try {
    $env:PGPASSWORD = $plain
    $arguments = @(
      "--host=127.0.0.1",
      "--port=$($Config.database.port)",
      "--username=$User",
      "--dbname=$($Config.database.name)",
      "--no-password",
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set=ON_ERROR_STOP=1",
      "--command=$Query"
    )
    $output = & $psql @arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
      Fail-LocalProduction "PostgreSQL rejected a required read-only boundary check"
    }
    return (@($output) -join "`n").Trim()
  } finally {
    if ($null -eq $previous) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    else { $env:PGPASSWORD = $previous }
    $plain = $null
  }
}

function Assert-ApplicationDatabaseBoundary {
  param(
    [Parameter(Mandatory)]$Config,
    [Parameter(Mandatory)]$Secrets
  )

  $appUser = [string]$Config.database.appUser
  $appRole = [string]$Config.database.appRole
  $query = @"
SELECT concat_ws('|',
  current_user,
  current_database(),
  role.rolsuper::int,
  role.rolcreatedb::int,
  role.rolcreaterole::int,
  role.rolreplication::int,
  role.rolbypassrls::int,
  boundary.rolcanlogin::int,
  boundary.rolsuper::int,
  boundary.rolcreatedb::int,
  boundary.rolcreaterole::int,
  boundary.rolreplication::int,
  boundary.rolbypassrls::int,
  EXISTS (SELECT 1 FROM pg_auth_members WHERE member = boundary.oid)::int,
  pg_has_role(current_user, '$appRole', 'MEMBER')::int,
  (SELECT count(*) FROM pg_auth_members membership
   JOIN pg_roles granted ON granted.oid = membership.roleid
   JOIN pg_roles member ON member.oid = membership.member
   WHERE member.rolname = current_user AND granted.rolname <> '$appRole'),
  has_database_privilege(current_user, current_database(), 'CREATE')::int,
  has_schema_privilege(current_user, 'public', 'CREATE')::int,
  EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = role.oid)::int,
  EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = role.oid)::int,
  EXISTS (SELECT 1 FROM pg_class WHERE relowner = role.oid)::int,
  (to_regclass('public.users') IS NOT NULL)::int,
  (to_regclass('public.credentials') IS NOT NULL)::int
)
FROM pg_roles role
JOIN pg_roles boundary ON boundary.rolname = '$appRole'
WHERE role.rolname = current_user;
"@
  $result = Invoke-PsqlScalar -Config $Config -User $appUser -Password $Secrets.AppDatabasePassword -Query $query
  $fields = $result.Split('|')
  if ($fields.Count -ne 23 -or
      $fields[0] -ne $appUser -or
      $fields[1] -ne $Config.database.name -or
      @($fields[2..13] | Where-Object { $_ -ne "0" }).Count -ne 0 -or
      $fields[14] -ne "1" -or
      @($fields[15..20] | Where-Object { $_ -ne "0" }).Count -ne 0 -or
      @($fields[21..22] | Where-Object { $_ -ne "1" }).Count -ne 0) {
    Fail-LocalProduction "the application PostgreSQL login is not a migrated DML-only role"
  }
}

function Assert-MigratorDatabaseBoundary {
  param(
    [Parameter(Mandatory)]$Config,
    [Parameter(Mandatory)]$Secrets
  )

  $user = [string]$Config.database.migratorUser
  $role = [string]$Config.database.migratorRole
  $query = @"
SELECT concat_ws('|',
  current_user,
  current_database(),
  login.rolsuper::int,
  login.rolcreatedb::int,
  login.rolcreaterole::int,
  login.rolreplication::int,
  login.rolbypassrls::int,
  boundary.rolcanlogin::int,
  boundary.rolsuper::int,
  boundary.rolcreatedb::int,
  boundary.rolcreaterole::int,
  boundary.rolreplication::int,
  boundary.rolbypassrls::int,
  EXISTS (SELECT 1 FROM pg_auth_members WHERE member = boundary.oid)::int,
  pg_has_role(current_user, '$role', 'MEMBER')::int,
  (SELECT count(*) FROM pg_auth_members membership
   JOIN pg_roles granted ON granted.oid = membership.roleid
   JOIN pg_roles member ON member.oid = membership.member
   WHERE member.rolname = current_user AND granted.rolname <> '$role'),
  EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = login.oid)::int
)
FROM pg_roles login
JOIN pg_roles boundary ON boundary.rolname = '$role'
WHERE login.rolname = current_user;
"@
  $result = Invoke-PsqlScalar -Config $Config -User $user -Password $Secrets.MigratorDatabasePassword -Query $query
  $fields = $result.Split('|')
  if ($fields.Count -ne 17 -or
      $fields[0] -ne $user -or
      $fields[1] -ne $Config.database.name -or
      @($fields[2..13] | Where-Object { $_ -ne "0" }).Count -ne 0 -or
      $fields[14] -ne "1" -or
      $fields[15] -ne "0" -or
      $fields[16] -ne "1") {
    Fail-LocalProduction "the migration PostgreSQL login is not the reviewed DDL-only database owner"
  }
}

function Assert-LoopbackListener {
  param(
    [Parameter(Mandatory)][int]$Port,
    [Parameter(Mandatory)][string]$Label,
    [switch]$RequirePresent
  )

  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($RequirePresent -and $listeners.Count -eq 0) {
    Fail-LocalProduction "$Label is not listening"
  }
  $unsafe = @($listeners | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") })
  if ($unsafe.Count -gt 0) {
    Fail-LocalProduction "$Label is listening on a wildcard or LAN interface"
  }
}

function Get-FileSha256 {
  param([Parameter(Mandatory)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
