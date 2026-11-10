param([string]$Task = ':app:assembleDebug')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    if (-not $env:JAVA_HOME -and (Test-Path 'D:/Download/Android JDK/jdk21.0.8_9/bin/java.exe')) {
        $env:JAVA_HOME = 'D:/Download/Android JDK/jdk21.0.8_9'
    }
    $bundledNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
    if (-not $env:JIUGUAN_NODE -and (Test-Path $bundledNode)) { $env:JIUGUAN_NODE = $bundledNode }
    if (-not $env:JAVA_HOME) { throw '请先设置 JAVA_HOME 为 JDK 21 的目录。' }
    if (-not $env:JIUGUAN_NODE) { throw '请先设置 JIUGUAN_NODE 为 Node >=20 的可执行文件路径。' }
    $env:GRADLE_USER_HOME = Join-Path $projectRoot '.tools/gradle-home'
    & "$projectRoot/gradlew.bat" $Task "-PnodeExecutable=$env:JIUGUAN_NODE" --console plain
    if ($LASTEXITCODE -ne 0) { throw "Gradle 构建失败：$LASTEXITCODE" }
} finally { Pop-Location }
