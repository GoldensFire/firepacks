# Заводит в Планировщике заданий Windows ночной обход базы: каждый день
# в час ночи по Москве запускается scripts/nightly.js — он собирает базу
# и выкладывает её на Cloudflare.
#
# Запуск (из папки проекта, в обычном окне PowerShell — прав администратора
# не нужно, задание заводится в вашей учётной записи):
#
#     powershell -ExecutionPolicy Bypass -File scripts\schedule-nightly.ps1
#
# Снять задание:
#
#     powershell -ExecutionPolicy Bypass -File scripts\schedule-nightly.ps1 -Remove
#
# Про время. Планировщик умеет только местное время, а нужен час ночи по Москве —
# и это разные вещи, если часы на компьютере стоят не по Москве. Час назначается
# пересчётом: берётся 01:00 по Москве и переводится в местное время этой машины.
# Поэтому скрипт стоит перегнать заново, если сменится часовой пояс компьютера.
#
# Компьютер должен быть включён: индексатору нужны ВК, Gemini и сами файлы паков,
# и на Cloudflare его не запустить. Ключ -Wake будит машину из сна к назначенному
# часу; выключенный компьютер не разбудит ничто.

[CmdletBinding()]
param(
	# Убрать задание вместо того, чтобы его завести
	[switch]$Remove,

	# Будить компьютер из сна к назначенному часу
	[switch]$Wake,

	# Час по Москве, в который начинается обход
	[int]$MoscowHour = 1
)

$ErrorActionPreference = 'Stop'

$taskName = 'FirePacks: ночной обход базы'
$root = Split-Path -Parent $PSScriptRoot

if ($Remove) {
	if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
		Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
		Write-Host "Задание «$taskName» снято."
	}
	else {
		Write-Host "Задания «$taskName» и не было."
	}

	return
}

# Час ночи по Москве в местное время. Москва живёт на UTC+3 круглый год —
# перевода часов там нет, — а вот местный пояс может быть каким угодно,
# и его смещение берётся у системы на сегодняшний день.
$moscow = [System.TimeZoneInfo]::FindSystemTimeZoneById('Russian Standard Time')
$today = [datetime]::UtcNow.Date
$moscowRun = [datetime]::SpecifyKind($today.AddHours($MoscowHour), [System.DateTimeKind]::Unspecified)
$utcRun = [System.TimeZoneInfo]::ConvertTimeToUtc($moscowRun, $moscow)
$localRun = $utcRun.ToLocalTime()

$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $node) {
	throw 'Node.js не найден в PATH. Поставьте Node 22 или новее и повторите.'
}

# Рабочая папка обязательна: nightly.js считает пути от корня проекта,
# а планировщик по умолчанию запускает всё из system32.
$action = New-ScheduledTaskAction -Execute $node `
	-Argument '--no-warnings scripts/nightly.js' `
	-WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Daily -At $localRun

# Ночной обход идёт десятками минут и упирается в сеть, а не в процессор:
# ограничение по времени снято, засыпать посреди работы машине нельзя,
# и на батарее это тоже должно работать — иначе на ноутбуке не запустится вовсе.
$settingsArgs = @{
	AllowStartIfOnBatteries    = $true
	DontStopIfGoingOnBatteries = $true
	StartWhenAvailable         = $true
	ExecutionTimeLimit         = (New-TimeSpan -Hours 6)
	RestartCount               = 2
	RestartInterval            = (New-TimeSpan -Minutes 30)
}

if ($Wake) {
	$settingsArgs['WakeToRun'] = $true
}

$settings = New-ScheduledTaskSettingsSet @settingsArgs

Register-ScheduledTask -TaskName $taskName `
	-Action $action -Trigger $trigger -Settings $settings `
	-Description 'Собирает базу FirePacks (ВК, разбор паков, статистика, Gemini) и выкладывает её на Cloudflare.' `
	-Force | Out-Null

Write-Host ''
Write-Host "Задание «$taskName» заведено."
Write-Host ("  час ночи по Москве  = {0} по местным часам" -f $localRun.ToString('HH:mm'))
Write-Host ("  часовой пояс машины : {0}" -f ([System.TimeZoneInfo]::Local.DisplayName))
Write-Host ("  папка проекта       : {0}" -f $root)
Write-Host ("  будить из сна       : {0}" -f $(if ($Wake) { 'да' } else { 'нет' }))
Write-Host ''
Write-Host 'Отчёты о ночных запусках складываются в data\nightly.'
Write-Host 'Проверить прямо сейчас, не дожидаясь ночи:'
Write-Host ("  Start-ScheduledTask -TaskName '{0}'" -f $taskName)
