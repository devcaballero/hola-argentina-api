#!/bin/zsh
cd "$(dirname "$0")"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs kill -9 2>/dev/null
lsof -tiTCP:3001 -sTCP:LISTEN | xargs kill -9 2>/dev/null
export PORT=3000
echo "Starting hola-argentina-api on :$PORT ..."
exec node index.js
