#!/usr/bin/env bash
set -eu

IFS= read -r initialize
[[ "$initialize" == *'"method":"initialize"'* ]]
[[ "$initialize" == *'"experimentalApi":true'* ]]
printf '%s\n' '{"id":1,"result":{}}'

IFS= read -r initialized
[[ "$initialized" == *'"method":"initialized"'* ]]

IFS= read -r resume
[[ "$resume" == *'"method":"thread/resume"'* ]]
[[ "$resume" == *'"threadId":"thread-for-compact-test"'* ]]
[[ "$resume" == *'"excludeTurns":true'* ]]
[[ "$resume" == *'"model":"test-model"'* ]]
[[ "$resume" == *'"model_reasoning_effort":"high"'* ]]
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-for-compact-test"}}}'

IFS= read -r compact
[[ "$compact" == *'"method":"thread/compact/start"'* ]]
[[ "$compact" == *'"threadId":"thread-for-compact-test"'* ]]
printf '%s\n' '{"id":3,"result":{}}'
printf '%s\n' '{"method":"thread/compacted","params":{"threadId":"thread-for-compact-test","turnId":"compact-turn"}}'
