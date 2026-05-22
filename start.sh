#!/bin/bash
echo "Starting Trading Journal..."

# Kill any existing instances first
pkill -9 -f "concurrently" 2>/dev/null
pkill -9 -f "nodemon" 2>/dev/null
pkill -9 -f "vite" 2>/dev/null
pkill -9 -f "node server/index.js" 2>/dev/null
fuser -k 3001/tcp 2>/dev/null
fuser -k 5173/tcp 2>/dev/null
fuser -k 3000/tcp 2>/dev/null
sleep 1

# Ensure PostgreSQL is running
if ! pg_isready -q; then
    echo "PostgreSQL not running — start it with: sudo service postgresql start"
    exit 1
fi

echo "Frontend:  http://localhost:5173"
echo "Backend:   http://localhost:3001/api"
echo "Press Ctrl+C to stop"
echo ""

npm start
