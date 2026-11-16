#!/bin/sh
# Double-click in the Finder: nine players and the desk tiled on this screen,
# the wall fullscreen on the second. See midi/room.js.
cd "$(dirname "$0")" && exec node midi/room.js "$@"
