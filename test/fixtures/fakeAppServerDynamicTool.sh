#!/usr/bin/env bash
set -eu

IFS= read -r initialize
[[ "$initialize" == *'"method":"initialize"'* ]]
printf '%s\n' '{"id":1,"result":{}}'

IFS= read -r initialized
[[ "$initialized" == *'"method":"initialized"'* ]]

IFS= read -r thread_start
[[ "$thread_start" == *'"method":"thread/start"'* ]]
[[ "$thread_start" == *'"dynamicTools"'* ]]
[[ "$thread_start" == *'"name":"telegram_react"'* ]]
printf '%s\n' '{"id":2,"result":{"thread":{"id":"dynamic-thread-1"}}}'

IFS= read -r turn_start
[[ "$turn_start" == *'"method":"turn/start"'* ]]
printf '%s\n' '{"id":3,"result":{"turn":{"id":"dynamic-turn-1"}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"dynamic-thread-1","turn":{"id":"dynamic-turn-1","status":"inProgress","items":[]}}}'
printf '%s\n' '{"method":"item/tool/call","id":901,"params":{"threadId":"dynamic-thread-1","turnId":"dynamic-turn-1","callId":"reaction-1","namespace":null,"tool":"telegram_react","arguments":{"emoji":"❤️"}}}'

IFS= read -r tool_response
[[ "$tool_response" == *'"id":901'* ]]
[[ "$tool_response" == *'"success":true'* ]]
[[ "$tool_response" == *'"type":"inputText"'* ]]
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"dynamic-thread-1","turn":{"id":"dynamic-turn-1","status":"completed","error":null}}}'

IFS= read -r _ || true
