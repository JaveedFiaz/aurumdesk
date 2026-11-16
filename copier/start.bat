@echo off
cd /d "%~dp0"
if not exist config.json copy config.example.json config.json
python copier.py config.json
pause
