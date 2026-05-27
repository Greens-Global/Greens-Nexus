@echo off
echo Starting Greens Nexus...

start "FastAPI Backend" cmd /k "cd /d "%~dp0backend" && python -m uvicorn main:app --reload --port 8000"
timeout /t 2 /nobreak >nul
start "React Frontend" cmd /k "cd /d "%~dp0frontend" && npm run dev"

echo.
echo Backend:  http://localhost:8000
echo Frontend: http://localhost:5173
echo API Docs: http://localhost:8000/docs
echo.
pause
