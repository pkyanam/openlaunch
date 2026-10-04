# Source this file from the repository root before using staging tools.
OPENLAUNCH_ROOT="$(pwd)"
export HOME="$OPENLAUNCH_ROOT/../.openlaunch-runtime/home"
export npm_config_cache="$OPENLAUNCH_ROOT/.cache/npm"
export GOCACHE="$OPENLAUNCH_ROOT/.cache/go-build"
export GOPATH="$OPENLAUNCH_ROOT/.cache/go-path"
export PATH="$OPENLAUNCH_ROOT/node_modules/.bin:$OPENLAUNCH_ROOT/.tools/bin:$OPENLAUNCH_ROOT/.tools/go/bin:$PATH"
export CF_SEND_TELEMETRY=false

export ARDUINO_BUILD_CACHE_PATH="$OPENLAUNCH_ROOT/.cache/arduino"
