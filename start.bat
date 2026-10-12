@echo off
cd /d "%~dp0"
echo Iniciando MVP de mantenimiento de flota...
start "" http://localhost:3100
node --no-warnings server\index.js
pause
