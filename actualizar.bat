@echo off
echo ============================================
echo  Tetra Pak Band Monitor - Actualizacion
echo ============================================
echo.

echo [1/2] Actualizando datos desde BCRA (Banco Nacion)...
python fetch_data.py --update
if errorlevel 1 (
    echo ERROR en fetch_data.py
    pause
    exit /b 1
)

echo.
echo [2/2] Generando banda_monitor.html...
python build_standalone.py
if errorlevel 1 (
    echo ERROR en build_standalone.py
    pause
    exit /b 1
)

echo.
echo Listo. Compartir el archivo: banda_monitor.html
echo (abrir directamente en el navegador, sin instalaciones)
echo.
pause
