@echo off
cd /d %~dp0
py -m venv .venv
call .venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8765
