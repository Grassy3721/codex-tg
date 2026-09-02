#!/usr/bin/env bash
set -eu

IFS= read -r initialize
[[ "$initialize" == *'"method":"initialize"'* ]]
printf '%s\n' '{"id":1,"result":{}}'

IFS= read -r initialized
[[ "$initialized" == *'"method":"initialized"'* ]]

IFS= read -r thread_resume
[[ "$thread_resume" == *'"method":"thread/resume"'* ]]
[[ "$thread_resume" == *'"threadId":"existing-thread"'* ]]
printf '%s\n' '{"id":2,"result":{"thread":{"id":"existing-thread"}}}'

IFS= read -r mcp_reload
[[ "$mcp_reload" == *'"method":"config/mcpServer/reload"'* ]]
printf '%s\n' '{"id":3,"result":{}}'

IFS= read -r turn_start
[[ "$turn_start" == *'"method":"turn/start"'* ]]
[[ "$turn_start" == *'"threadId":"existing-thread"'* ]]
printf '%s\n' '{"id":4,"result":{"turn":{"id":"resume-turn"}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"existing-thread","turn":{"id":"resume-turn","status":"inProgress","items":[]}}}'
printf '%s\n' '{"method":"item/completed","params":{"threadId":"existing-thread","turnId":"resume-turn","item":{"type":"agentMessage","id":"answer-1","text":"resume reloaded","phase":"final_answer","memoryCitation":null}}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"existing-thread","turn":{"id":"resume-turn","status":"completed","error":null}}}'

IFS= read -r _ || true
