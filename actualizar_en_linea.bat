@echo off
title Sterinova - Actualizar y Desplegar Cambios en Linea
echo ===============================================================
echo   STERINOVA - Subiendo cambios a la nube (Auto-Deploy)
echo ===============================================================
echo.
set /p MSG="Describe brevemente el cambio (o presiona Enter para 'Actualizacion'): "
if "%MSG%"=="" set MSG=Actualizacion del sistema Sterinova

git add .
git commit -m "%MSG%"
git push

echo.
echo ===============================================================
echo   Cambios enviados a GitHub. El servidor en linea se
echo   actualizara automaticamente en 1-2 minutos.
echo ===============================================================
pause
