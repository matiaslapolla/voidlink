# VoidLink shell integration for zsh — OSC 133 semantic prompts.
#
# Add this to the END of your ~/.zshrc:
#
#     source /path/to/voidlink/shell-integration/voidlink.zsh
#
# It emits the standard FinalTerm/iTerm2/VS Code sequences around every command
# so VoidLink can tell a build that FAILED from a build that merely ENDED. Only
# the shell knows $?; a terminal watching the process table does not.
#
# It is a no-op outside VoidLink: the marker below is exported by the app when
# it spawns the PTY, so sourcing this from your rc costs nothing in any other
# terminal. Nothing here touches PS1, PATH, or any variable you own.

# Not in VoidLink, or already loaded. `return` and not `exit` — this is sourced.
[[ -n ${VOIDLINK_SHELL_INTEGRATION-} ]] || return 0
[[ -n ${__voidlink_osc133_loaded-} ]] && return 0
typeset -g __voidlink_osc133_loaded=1
typeset -g __voidlink_running=

autoload -Uz add-zsh-hook

# `$?` must be the very first thing read: any command in between overwrites it.
__voidlink_precmd() {
  local status_code=$?
  if [[ -n $__voidlink_running ]]; then
    # D — the command that just ran ended, with this status. The one sequence
    # this whole file exists to emit.
    printf '\033]133;D;%d\007' "$status_code"
    __voidlink_running=
  fi
  # A — a prompt is about to be drawn.
  printf '\033]133;A\007'
}

__voidlink_pre_command() {
  # C — a command is about to run. VoidLink measures C to D, and rejects a `D`
  # it has no `C` for, so this is what makes a completion reportable at all.
  printf '\033]133;C\007'
  __voidlink_running=1
}

add-zsh-hook precmd __voidlink_precmd
add-zsh-hook preexec __voidlink_pre_command

# `B` (prompt end / command-line start) is deliberately NOT emitted.
#
# The only way to place it is to append an escape to PS1, wrapped in %{...%} so
# zsh does not count it toward the prompt width. That is a write into a variable
# owned by the user's prompt framework — powerlevel10k, starship and oh-my-zsh
# all rebuild PS1 on their own schedule, so the append either gets clobbered or
# gets duplicated once per prompt. VoidLink uses only C and D, so the sequence
# that carries the risk buys nothing. A shell that does emit B is still parsed
# correctly; this file just does not become that risk.
