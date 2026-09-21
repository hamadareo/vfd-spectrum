#!/bin/bash
# Double-click to start the VFD analyzer with "now playing" (Apple Music) support.
cd "$(dirname "$0")" || exit 1
( sleep 1; open "http://127.0.0.1:8765/" ) &
exec python3 server.py
