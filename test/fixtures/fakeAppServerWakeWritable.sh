#!/usr/bin/env bash
set -eu

IFS= read -r initialize
[[ "$initialize" == *'"method":"initialize"'* ]]
printf '%s\n' '{"id":1,"result":{}}'

IFS= read -r initialized
[[ "$initialized" == *'"method":"initialized"'* ]]

IFS= read -r wake_resume
[[ "$wake_resume" == *'"method":"thread/resume"'* ]]
[[ "$wake_resume" == *'"threadId":"live-thread"'* ]]
[[ "$wake_resume" == *'"cwd":"/tmp/writable-workspace"'* ]]
[[ "$wake_resume" == *'"sandbox":"workspace-write"'* ]]
[[ "$wake_resume" == *'"approvalPolicy":"never"'* ]]
printf '%s\n' '{"id":2,"result":{"thread":{"id":"live-thread"}}}'

IFS= read -r mcp_reload
[[ "$mcp_reload" == *'"method":"config/mcpServer/reload"'* ]]
printf '%s\n' '{"id":3,"result":{}}'

IFS= read -r wake_turn
[[ "$wake_turn" == *'"method":"turn/start"'* ]]
[[ "$wake_turn" == *'"threadId":"live-thread"'* ]]
printf '%s\n' '{"id":4,"result":{"turn":{"id":"wake-turn"}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"live-thread","turn":{"id":"wake-turn","status":"inProgress","items":[]}}}'
printf '%s\n' '{"method":"item/completed","params":{"threadId":"live-thread","turnId":"wake-turn","item":{"type":"agentMessage","id":"wake-answer","text":"recoverable write completed","phase":"final_answer","memoryCitation":null}}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"live-thread","turn":{"id":"wake-turn","status":"completed","error":null}}}'

IFS= read -r main_resume
[[ "$main_resume" == *'"method":"thread/resume"'* ]]
[[ "$main_resume" == *'"threadId":"live-thread"'* ]]
[[ "$main_resume" == *'"cwd":"/tmp/writable-workspace"'* ]]
[[ "$main_resume" == *'"sandbox":"workspace-write"'* ]]
[[ "$main_resume" == *'"approvalPolicy":"on-request"'* ]]
printf '%s\n' '{"id":5,"result":{"thread":{"id":"live-thread"}}}'

IFS= read -r main_turn
[[ "$main_turn" == *'"method":"turn/start"'* ]]
[[ "$main_turn" == *'"threadId":"live-thread"'* ]]
printf '%s\n' '{"id":6,"result":{"turn":{"id":"main-turn"}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"live-thread","turn":{"id":"main-turn","status":"inProgress","items":[]}}}'
printf '%s\n' '{"method":"item/completed","params":{"threadId":"live-thread","turnId":"main-turn","item":{"type":"agentMessage","id":"main-answer","text":"main thread remains writable","phase":"final_answer","memoryCitation":null}}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"live-thread","turn":{"id":"main-turn","status":"completed","error":null}}}'

IFS= read -r _ || true
