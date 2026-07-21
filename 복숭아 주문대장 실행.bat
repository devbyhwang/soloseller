@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 22 이상이 필요합니다.
  echo https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%A in ('node --version') do set "NODE_MAJOR=%%A"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if %NODE_MAJOR% LSS 22 (
  echo.
  echo Node.js 22 이상이 필요합니다.
  echo https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo 처음 실행하는 중입니다. 필요한 파일을 설치합니다...
  call npm install
  if errorlevel 1 (
    echo.
    echo 설치에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 실행해 주세요.
    pause
    exit /b 1
  )
)

rem 서버가 준비된 뒤 기본 브라우저를 엽니다.
start "" /B powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:3000'"
echo 복숭아 주문대장을 실행 중입니다. 이 창을 닫으면 앱도 종료됩니다.
echo 종료하려면 이 창에서 Ctrl+C를 누르세요.
call npm start
