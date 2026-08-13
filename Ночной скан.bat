@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Включаю ночной обход базы на этом компьютере: каждый день в час ночи
echo по Москве. Компьютер в это время должен быть включён.
echo.
echo Если выключать его на ночь всё-таки хочется — обход умеет идти сам,
echo в GitHub Actions. Как это включить, написано в README, раздел
echo «Ночной обход» → «Расписание в облаке».
echo.
echo Чтобы машина сама просыпалась из сна, допишите -Wake в строке ниже.
echo Убрать задание: тот же файл с ключом -Remove.
echo.
powershell -ExecutionPolicy Bypass -File "scripts\schedule-nightly.ps1"
echo.
pause
