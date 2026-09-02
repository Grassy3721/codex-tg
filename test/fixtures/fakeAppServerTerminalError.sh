#!/usr/bin/env bash
set -eu

IFS= read -r initialize
[[ "$initialize" == *'"method":"initialize"'* ]]
printf '%s\n' '{"id":1,"result":{}}'

IFS= read -r initialized
[[ "$initialized" == *'"method":"initialized"'* ]]

IFS= read -r first_thread_start
[[ "$first_thread_start" == *'"method":"thread/start"'* ]]
printf '%s\n' '{"id":2,"result":{"thread":{"id":"capacity-thread"}}}'

IFS= read -r first_turn_start
[[ "$first_turn_start" == *'"method":"turn/start"'* ]]
printf '%s\n' '{"id":3,"result":{"turn":{"id":"capacity-turn"}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"capacity-thread","turn":{"id":"capacity-turn","status":"inProgress","items":[]}}}'
printf '%s\n' '{"method":"error","params":{"threadId":"capacity-thread","turnId":"capacity-turn","error":{"message":"Selected model is at capacity. Please try a different model."},"willRetry":false}}'

IFS= read -r second_thread_start
[[ "$second_thread_start" == *'"method":"thread/start"'* ]]
printf '%s\n' '{"id":4,"result":{"thread":{"id":"recovery-thread"}}}'

IFS= read -r second_turn_start
[[ "$second_turn_start" == *'"method":"turn/start"'* ]]
printf '%s\n' '{"id":5,"result":{"turn":{"id":"recovery-turn"}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"recovery-thread","turn":{"id":"recovery-turn","status":"inProgress","items":[]}}}'
printf '%s\n' '{"method":"item/completed","params":{"threadId":"recovery-thread","turnId":"recovery-turn","item":{"type":"agentMessage","id":"recovery-answer","text":"scheduler recovered","phase":"final_answer","memoryCitation":null}}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"recovery-thread","turn":{"id":"recovery-turn","status":"completed","error":null}}}'

IFS= read -r _ || true
