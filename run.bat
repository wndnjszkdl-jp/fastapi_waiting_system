@echo off
chcp 65001 > nul
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
pause
