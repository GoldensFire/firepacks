@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запускаю библиотеку паков...
echo.
echo Сначала сверяю базу с сайтом: если ночной обход собрал что-то новое,
echo оно приедет сюда. Первый раз это может занять минуту.
echo.
node --no-warnings scripts\start.js --open
pause
