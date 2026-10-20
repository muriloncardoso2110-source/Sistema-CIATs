@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Node.js 22.13 ou superior nao encontrado. Instale em https://nodejs.org
 pause
 exit /b 1
)
if not exist .env (
 copy .env.example .env >nul
 echo Arquivo .env criado com modo de demonstracao ativo.
)
echo Abrindo Solvia ServiceOps em http://localhost:3100
start "" http://localhost:3100
node server/index.mjs
pause
