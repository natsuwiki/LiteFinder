@echo off
chcp 65001 >nul
echo ========================================
echo   LiteFinder v1.3.1
echo   Minecraft World Generation Analyzer
echo ========================================
echo.
cd src-api
node --max-old-space-size=384 --expose-gc node_modules/tsx/dist/cli.mjs src/server.ts
