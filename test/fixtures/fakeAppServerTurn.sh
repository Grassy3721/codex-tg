#!/usr/bin/env bash
set -eu

IFS= read -r initialize
[[ "$initialize" == *'"method":"initialize"'* ]]
printf '%s\n' '{"id":1,"result":{}}'

IFS= read -r initialized
[[ "$initialized" == *'"method":"initialized"'* ]]

IFS= read -r thread_start
[[ "$thread_start" == *'"method":"thread/start"'* ]]
[[ "$thread_start" == *'"approvalPolicy":"on-request"'* ]]
[[ "$thread_start" == *'"approvalsReviewer":"user"'* ]]
[[ "$thread_start" == *'"developerInstructions":"test portrait"'* ]]
[[ "$thread_start" == *'"ephemeral":true'* ]]
printf '%s\n' '{"id":2,"result":{"thread":{"id":"app-thread-1"}}}'

IFS= read -r memory_inject
[[ "$memory_inject" == *'"method":"thread/inject_items"'* ]]
[[ "$memory_inject" == *'"role":"developer"'* ]]
[[ "$memory_inject" == *'"text":"latest memory"'* ]]
[[ "$memory_inject" == *'inner_baton version=\"3\"'* ]]
[[ "$memory_inject" == *'"text":"recent thread tail"'* ]]
printf '%s\n' '{"id":3,"result":{}}'

IFS= read -r turn_start
[[ "$turn_start" == *'"method":"turn/start"'* ]]
[[ "$turn_start" == *'"type":"localImage","path":"/tmp/input.png"'* ]]
[[ "$turn_start" == *'"outputSchema"'* ]]
printf '%s\n' '{"id":4,"result":{"turn":{"id":"app-turn-1"}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"app-thread-1","turn":{"id":"app-turn-1","status":"inProgress","items":[]}}}'
printf '%s\n' '{"method":"item/commandExecution/requestApproval","id":900,"params":{"threadId":"app-thread-1","turnId":"app-turn-1","itemId":"command-1","startedAtMs":1,"command":"echo approved","cwd":"/tmp","availableDecisions":["accept","acceptForSession","decline","cancel"]}}'

IFS= read -r approval
[[ "$approval" == *'"id":900'* ]]
[[ "$approval" == *'"decision":"accept"'* ]]
printf '%s\n' '{"method":"item/completed","params":{"threadId":"app-thread-1","turnId":"app-turn-1","item":{"type":"agentMessage","id":"answer-1","text":"approval resumed","phase":"final_answer","memoryCitation":null}}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"app-thread-1","turn":{"id":"app-turn-1","status":"completed","error":null}}}'

IFS= read -r _ || true
