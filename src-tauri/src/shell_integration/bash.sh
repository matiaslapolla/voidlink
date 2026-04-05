# Voidlink shell integration for Bash — OSC 133 prompt marking
# Injected automatically; do not source manually.

if [[ "$VOIDLINK_SHELL_INTEGRATION" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
export VOIDLINK_SHELL_INTEGRATION=1

__voidlink_osc() { printf '\033]133;%s\007' "$1"; }

__voidlink_prompt_start() { __voidlink_osc "A"; }
__voidlink_prompt_end()   { __voidlink_osc "B"; }
__voidlink_cmd_start()    { __voidlink_osc "C"; }
__voidlink_cmd_end()      { __voidlink_osc "D;$?"; }

# Report CWD via OSC 7
__voidlink_report_cwd() {
  printf '\033]7;file://%s%s\033\\' "$(hostname)" "$(pwd)"
}

__voidlink_preexec() {
  __voidlink_cmd_start
}

__voidlink_precmd() {
  __voidlink_cmd_end
  __voidlink_report_cwd
  __voidlink_prompt_start
}

# Install via PROMPT_COMMAND
if [[ -z "$__voidlink_installed" ]]; then
  __voidlink_installed=1

  # Wrap DEBUG trap for preexec
  __voidlink_prev_debug_trap="$(trap -p DEBUG | sed "s/^trap -- '\\(.*\\)' DEBUG$/\\1/")"
  trap '__voidlink_preexec; eval "$__voidlink_prev_debug_trap"' DEBUG

  # Append to PROMPT_COMMAND
  if [[ -n "$PROMPT_COMMAND" ]]; then
    PROMPT_COMMAND="__voidlink_precmd;$PROMPT_COMMAND"
  else
    PROMPT_COMMAND="__voidlink_precmd"
  fi

  # Emit initial prompt start
  __voidlink_prompt_start
fi
