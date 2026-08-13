@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запускаю библиотеку паков...
start "" http://localhost:3000
node --no-warnings src/server.js
pause
