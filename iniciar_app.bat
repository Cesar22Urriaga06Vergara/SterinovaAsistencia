@echo off
title Sterinova - Sistema Web y App Movil de Asistencia y Nomina
echo ===============================================================
echo   STERINOVA - Plataforma En Linea y App Movil (PC y Celular)
echo ===============================================================
echo.
echo Iniciando servidor en http://localhost:8000 ...
echo Para abrir desde tu celular conectado al mismo Wi-Fi, usa la IP local de este PC en el puerto 8000.
echo.
start "" "http://localhost:8000"
"C:\Users\urria\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" server.py
pause
