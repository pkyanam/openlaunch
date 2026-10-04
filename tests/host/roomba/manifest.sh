#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$test_dir/../../.." && pwd)
out_dir=$(mktemp -d)
trap 'rm -rf "$out_dir"' EXIT

c++ -std=c++11 -Wall -Wextra -Werror \
  -I"$test_dir/stubs" \
  -I"$repo_dir/firmware/uno-r4-wifi/openlaunch_roomba" \
  -I"$repo_dir/build/arduino-dependencies/libraries/ArduinoJson/src" \
  "$test_dir/dump_roomba_manifest.cpp" -o "$out_dir/dump_roomba_manifest"
"$out_dir/dump_roomba_manifest"
