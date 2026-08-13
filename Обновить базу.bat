@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Открываю страницу обновления базы.
echo Там можно отметить, что именно обновлять: ссылки из ВК, разбор паков,
echo статистику, проценты категорий, краткие описания.
echo Окно не закрывайте — на нём держится сайт.
echo.
start "" http://localhost:3000/update
node --no-warnings src/server.js
pause
