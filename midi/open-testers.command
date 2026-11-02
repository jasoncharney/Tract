#!/bin/sh
# Double-click in the Finder: eight player windows, one per MIDI track.
# See midi/testers.js for what it does and why it uses its own Chrome.
cd "$(dirname "$0")/.." && exec node midi/testers.js "$@"
