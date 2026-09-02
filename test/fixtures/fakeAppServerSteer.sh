#!/usr/bin/env bash
set -eu

IFS= read -r initialize
[[ "$initialize" == *'"method":"initialize"'* ]]
printf '%s\n' '{"id":1,"result":{}}'

IFS= read -r initialized
[[ "$initialized" == *'"method":"initialized"'* ]]

IFS= read -r thread_start
[[ "$thread_start" == *'"method":"thread/start"'* ]]
printf '%s\n' '{"id":2,"result":{"thread":{"id":"steer-thread-1"}}}'

IFS= read -r turn_start
[[ "$turn_start" == *'"method":"turn/start"'* ]]
printf '%s\n' '{"id":3,"result":{"turn":{"id":"steer-turn-1"}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"steer-thread-1","turn":{"id":"steer-turn-1","status":"inProgress","items":[]}}}'

IFS= read -r turn_steer
[[ "$turn_steer" == *'"method":"turn/steer"'* ]]
[[ "$turn_steer" == *'"threadId":"steer-thread-1"'* ]]
[[ "$turn_steer" == *'"expectedTurnId":"steer-turn-1"'* ]]
[[ "$turn_steer" == *'"clientUserMessageId":"telegram:123:456"'* ]]
[[ "$turn_steer" == *'"text":"Actually use the new requirement."'* ]]
printf '%s\n' '{"id":4,"result":{"turnId":"steer-turn-1"}}'

printf '%s\n' '{"method":"item/completed","params":{"threadId":"steer-thread-1","turnId":"steer-turn-1","item":{"type":"agentMessage","id":"answer-1","text":"steering received","phase":"final_answer","memoryCitation":null}}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"steer-thread-1","turn":{"id":"steer-turn-1","status":"completed","error":null}}}'

IFS= read -r _ || true
