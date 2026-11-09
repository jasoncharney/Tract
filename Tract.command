#!/usr/bin/env bash
#
# Double-click me.
#
# The Finder opens a Terminal here and runs ./tract, which asks whether this
# is a rehearsal or a performance, starts the bridge, and opens the conductor
# and the projection in Chrome. Closing this Terminal window stops the bridge.
#
cd "$(dirname "$0")" || exit 1
exec ./tract "$@"
