# 线上全套：线上号守护(run_online.sh → bot.js vakesamahere, 端口3002) + 看门狗(watchdog.js) + 看板(dash.js, :3010)
# 不动本地服/本地号。用法：powershell -ExecutionPolicy Bypass -File bin\online.ps1 start|stop|status
# 进程用 Start-Process 隐藏启动，不挂在控制台上，关掉窗口也不会被带走。
param([ValidateSet('start', 'stop', 'status')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
New-Item -ItemType Directory -Force logs | Out-Null

# node：优先 PATH，找不到就用 fnm 装的那个（重启后普通 cmd 里 PATH 不一定有 node）
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "$env:APPDATA\fnm\node-versions\v24.22.1\installation\node.exe" }
$env:PATH = (Split-Path $node) + ';' + $env:PATH   # run_online.sh 里直接调 node，子进程继承这个 PATH
$bash = 'C:\Program Files\Git\bin\bash.exe'

# 按命令行结尾匹配，避免把查询命令自己也算进去
function Find-Proc($tail) {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='bash.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Trim().EndsWith($tail) })
}

$parts = @(
  @{ Name = '线上号守护 run_online.sh'; Tail = 'bin/run_online.sh'; Exe = $bash; Args = 'bin/run_online.sh'; Out = $null },
  @{ Name = '看门狗 watchdog.js'; Tail = 'bin/watchdog.js'; Exe = $node; Args = 'bin/watchdog.js'; Out = $null },
  @{ Name = '看板 dash.js (:3010)'; Tail = 'bin/dash.js'; Exe = $node; Args = 'bin/dash.js'; Out = 'logs\dash.out' }
)
$bot = @{ Name = '线上号 bot.js vakesamahere'; Tail = 'bot.js vakesamahere' }

switch ($Action) {
  'status' {
    foreach ($p in $parts + $bot) {
      $n = @(Find-Proc $p.Tail).Count
      Write-Host ("{0,-28} {1}" -f $p.Name, $(if ($n) { "在跑 ($n)" } else { '没在跑' }))
    }
    Write-Host ("offline.flag: " + $(if (Test-Path memory\offline.flag) { '有（守护会等着不连）' } else { '无' }))
    Write-Host ("autofarm.flag: " + $(if (Test-Path memory\autofarm.flag) { '有（连上后自动开刷）' } else { '无（连上后不刷）' }))
  }
  'start' {
    Remove-Item -Force -ErrorAction SilentlyContinue memory\offline.flag   # 要上线，去掉下线标记
    foreach ($p in $parts) {
      if (@(Find-Proc $p.Tail).Count) { Write-Host "[skip]  $($p.Name) 已在跑"; continue }
      $sp = @{ FilePath = $p.Exe; ArgumentList = $p.Args; WorkingDirectory = $Root; WindowStyle = 'Hidden' }
      if ($p.Out) { $sp.RedirectStandardOutput = $p.Out; $sp.RedirectStandardError = "$($p.Out).err" }
      Start-Process @sp
      Write-Host "[start] $($p.Name)"
    }
    Write-Host "`n看板: http://127.0.0.1:3010 ；线上号大约 10-30 秒后连上。是否自动开刷看 memory\autofarm.flag。"
  }
  'stop' {
    # 先停看门狗（免得报掉线），再停守护（免得把号拉回来），再停号和看板
    foreach ($p in @($parts[1], $parts[0], $bot, $parts[2])) {
      $ps = @(Find-Proc $p.Tail)
      if (-not $ps.Count) { Write-Host "[skip]  $($p.Name) 没在跑"; continue }
      $ps | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Write-Host "[stop]  $($p.Name) ($($ps.Count))"
    }
  }
}
