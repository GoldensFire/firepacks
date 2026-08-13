@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Включаю ночной обход базы: каждый день в час ночи по Москве.
echo Компьютер в это время должен быть включён — индексатору нужны
echo ВК, Gemini и сами файлы паков, в облаке их взять неоткуда.
echo.
echo Чтобы машина сама просыпалась из сна, допишите -Wake в строке ниже.
echo Убрать задание: тот же файл с ключом -Remove.
echo.
powershell -ExecutionPolicy Bypass -File "scripts\schedule-nightly.ps1"
echo.
pause
