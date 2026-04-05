# Voidlink shell integration for Zsh — OSC 133 prompt marking
# Injected automatically; do not source manually.

if [[ "$VOIDLINK_SHELL_INTEGRATION" == "1" ]]; then
  return 0
fi
export VOIDLINK_SHELL_INTEGRATION=1

__voidlink_osc() { printf '\033]133;%s\007' "$1"; }

# Report CWD via OSC 7
__voidlink_report_cwd() {
  printf '\033]7;file://%s%s\033\\' "$(hostname)" "$(pwd)"
}

__voidlink_preexec() {
  __voidlink_osc "C"
}

__voidlink_precmd() {
  __voidlink_osc "D;$?"
  __voidlink_report_cwd
  __voidlink_osc "A"
}

# Emit prompt-end after each prompt render
__voidlink_line_init() {
  __voidlink_osc "B"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec  __voidlink_preexec
add-zsh-hook precmd   __voidlink_precmd
add-zsh-hook zle-line-init __voidlink_line_init 2>/dev/null || {
  # Fallback: wrap zle-line-init if add-zsh-hook doesn't support it
  if [[ -z "$functions[zle-line-init]" ]]; then
    zle-line-init() { __voidlink_osc "B"; }
    zle -N zle-line-init
  fi
}

# Emit initial prompt start
__voidlink_osc "A"
