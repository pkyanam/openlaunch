#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$test_dir/../../.." && pwd)
out_dir=$(mktemp -d)
trap 'rm -rf "$out_dir"' EXIT

c++ -std=c++11 -Wall -Wextra -Werror \
  -I"$repo_dir/firmware/uno-r4-wifi/openlaunch_roomba" \
  "$test_dir/test_drive_adapter.cpp" -o "$out_dir/test_drive_adapter"
"$out_dir/test_drive_adapter"

c++ -std=c++11 -Wall -Wextra -Werror \
  -I"$repo_dir/firmware/uno-r4-wifi/openlaunch_roomba" \
  "$test_dir/test_command_guard.cpp" -o "$out_dir/test_command_guard"
"$out_dir/test_command_guard"

c++ -std=c++11 -Wall -Wextra -Werror \
  -I"$repo_dir/firmware/uno-r4-wifi/openlaunch_roomba" \
  "$test_dir/test_result_journal.cpp" -o "$out_dir/test_result_journal"
"$out_dir/test_result_journal"

c++ -std=c++11 -Wall -Wextra -Werror \
  -I"$repo_dir/firmware/uno-r4-wifi/openlaunch_roomba" \
  "$test_dir/test_bootstrap_record.cpp" -o "$out_dir/test_bootstrap_record"
"$out_dir/test_bootstrap_record"

json_dir="$repo_dir/build/arduino-dependencies/libraries/ArduinoJson/src"
c++ -std=c++11 -Wall -Wextra -Werror \
  -I"$test_dir/stubs" \
  -I"$repo_dir/firmware/uno-r4-wifi/openlaunch_roomba" \
  -I"$json_dir" \
  "$test_dir/test_roomba_functions.cpp" -o "$out_dir/test_roomba_functions"
"$out_dir/test_roomba_functions"
echo "Roomba host adapter tests passed"
