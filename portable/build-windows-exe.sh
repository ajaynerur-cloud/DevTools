#!/bin/sh
# Builds dist/ToolboxPlus-Portable.exe (Windows, 64-bit) from this repo. Needs Python 3 and Go 1.21+. No Windows machine needed.
set -e
cd "$(dirname "$0")/.."
python3 portable/build-single-file.py dist/ToolboxPlus.html
cp dist/ToolboxPlus.html portable/windows/ToolboxPlus.html
(cd portable/windows && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H=windowsgui -s -w" -o ../../dist/ToolboxPlus-Portable.exe .)
rm portable/windows/ToolboxPlus.html
ls -la dist
