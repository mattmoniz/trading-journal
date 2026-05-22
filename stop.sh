#!/bin/bash
echo "Stopping Trading Journal..."
pkill -9 -f "concurrently" 2>/dev/null
pkill -9 -f "nodemon" 2>/dev/null
pkill -9 -f "vite" 2>/dev/null
pkill -9 -f "node server/index.js" 2>/dev/null
fuser -k 3001/tcp 2>/dev/null
fuser -k 5173/tcp 2>/dev/null
fuser -k 3000/tcp 2>/dev/null
sleep 1
echo "Done."
