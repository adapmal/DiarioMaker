@echo off
title DiarioMaker - Modo Desenvolvedor
echo =======================================================
echo    Iniciando DiarioMaker no Modo de Desenvolvimento
echo =======================================================
echo.
echo [1/2] Abrindo o navegador em http://localhost:3000...
start http://localhost:3000
echo.
echo [2/2] Iniciando o servidor Node/Vite (npm run dev)...
echo.
npm run dev
pause
