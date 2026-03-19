@echo off
rem Execute bbext via tsx
cd /d "%~dp0"
cd apps\bbext-cli
tsx src\cli.ts %*
