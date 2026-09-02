#!/usr/bin/env bash
set -eu

IFS= read -r initialize
[[ "$initialize" == *'"method":"initialize"'* ]]
printf '%s\n' '{"id":1,"result":{}}'

IFS= read -r initialized
[[ "$initialized" == *'"method":"initialized"'* ]]

IFS= read -r thread_fork
[[ "$thread_fork" == *'"method":"thread/fork"'* ]]
[[ "$thread_fork" == *'"threadId":"parent-thread"'* ]]
[[ "$thread_fork" == *'"developerInstructions":"<isolated_episode_instructions>test policy</isolated_episode_instructions>"'* ]]
[[ "$thread_fork" != *'SKILL.md'* ]]
printf '%s\n' '{"id":2,"result":{"thread":{"id":"skill-worker","forkedFromId":"parent-thread"}}}'

IFS= read -r first_turn
[[ "$first_turn" == *'"method":"turn/start"'* ]]
[[ "$first_turn" == *'"type":"text","text":"first prompt"'* ]]
[[ "$first_turn" != *'"type":"skill"'* ]]
printf '%s\n' '{"id":3,"result":{"turn":{"id":"skill-turn-1"}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"skill-worker","turn":{"id":"skill-turn-1","status":"inProgress","items":[]}}}'
printf '%s\n' '{"method":"item/completed","params":{"threadId":"skill-worker","turnId":"skill-turn-1","item":{"type":"agentMessage","id":"answer-1","text":"first answer","phase":"final_answer"}}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"skill-worker","turn":{"id":"skill-turn-1","status":"completed"}}}'

IFS= read -r thread_resume
[[ "$thread_resume" == *'"method":"thread/resume"'* ]]
[[ "$thread_resume" == *'"threadId":"skill-worker"'* ]]
[[ "$thread_resume" != *'"developerInstructions"'* ]]
printf '%s\n' '{"id":4,"result":{"thread":{"id":"skill-worker"}}}'

IFS= read -r mcp_reload
[[ "$mcp_reload" == *'"method":"config/mcpServer/reload"'* ]]
printf '%s\n' '{"id":5,"result":{}}'

IFS= read -r second_turn
[[ "$second_turn" == *'"method":"turn/start"'* ]]
[[ "$second_turn" == *'"type":"text","text":"follow up"'* ]]
[[ "$second_turn" != *'"type":"skill"'* ]]
printf '%s\n' '{"id":6,"result":{"turn":{"id":"skill-turn-2"}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"skill-worker","turn":{"id":"skill-turn-2","status":"inProgress","items":[]}}}'
printf '%s\n' '{"method":"item/completed","params":{"threadId":"skill-worker","turnId":"skill-turn-2","item":{"type":"agentMessage","id":"answer-2","text":"second answer","phase":"final_answer"}}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"skill-worker","turn":{"id":"skill-turn-2","status":"completed"}}}'

IFS= read -r _ || true
