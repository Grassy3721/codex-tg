#!/usr/bin/env bash
set -eu
trap 'exit 0' TERM INT

log_file=${APP_SERVER_RACE_LOG:?APP_SERVER_RACE_LOG is required}
skills_delay_ms=${APP_SERVER_RACE_SKILLS_DELAY_MS:-0}

printf 'start:%s\n' "$$" >>"$log_file"

IFS= read -r initialize
[[ "$initialize" == *'"method":"initialize"'* ]]
printf 'request:%s:%s\n' "$$" "$initialize" >>"$log_file"
initialize_id=$(sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p' <<<"$initialize")
printf '{"id":%s,"result":{}}\n' "$initialize_id"

IFS= read -r initialized
[[ "$initialized" == *'"method":"initialized"'* ]]

while IFS= read -r request; do
  printf 'request:%s:%s\n' "$$" "$request" >>"$log_file"
  request_id=$(sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p' <<<"$request")
  method=$(sed -n 's/.*"method":"\([^"]*\)".*/\1/p' <<<"$request")

  case "$method" in
    skills/list)
      if [[ "$skills_delay_ms" != 0 ]]; then
        sleep "$(awk "BEGIN { print $skills_delay_ms / 1000 }")"
      fi
      printf '{"id":%s,"result":{"data":[{"cwd":"/tmp","skills":[]}]}}\n' "$request_id"
      ;;
    config/mcpServer/reload|config/value/write|thread/resume|thread/start|thread/fork|thread/inject_items|thread/archive)
      printf '{"id":%s,"result":{}}\n' "$request_id"
      ;;
    *)
      printf '{"id":%s,"result":{}}\n' "$request_id"
      ;;
  esac
done
