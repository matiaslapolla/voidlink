# VoidLink shell integration for bash — OSC 133 semantic prompts.
#
# Add this to the END of your ~/.bashrc:
#
#     source /path/to/voidlink/shell-integration/voidlink.bash
#
# See voidlink.zsh for what these sequences are and why VoidLink needs them.
# It is a no-op outside VoidLink and touches nothing you own except
# PROMPT_COMMAND, which it prepends to rather than replaces.

[[ -n ${VOIDLINK_SHELL_INTEGRATION-} ]] || return 0
[[ -n ${__voidlink_osc133_loaded-} ]] && return 0
__voidlink_osc133_loaded=1
__voidlink_running=
__voidlink_armed=

# `$?` first, before anything else can overwrite it.
__voidlink_prompt() {
  local status_code=$?
  if [[ -n $__voidlink_running ]]; then
    printf '\033]133;D;%d\007' "$status_code"
    __voidlink_running=
  fi
  printf '\033]133;A\007'
  # Re-arm: the next thing bash reports through the DEBUG trap is the command
  # the user just typed. Without the arming flag the trap fires for every
  # command inside PROMPT_COMMAND itself and each prompt would look like a
  # command starting.
  __voidlink_armed=1
}

__voidlink_started() {
  [[ -n $__voidlink_armed ]] || return 0
  __voidlink_armed=
  __voidlink_running=1
  printf '\033]133;C\007'
}

# bash-preexec (used by Atuin, iTerm2's own integration, and others) owns the
# DEBUG trap outright and calling `trap ... DEBUG` on top of it would silently
# break whichever of us installed first. When it is loaded we register through
# its arrays instead, which is what it exists for.
if [[ -n ${preexec_functions+x} && -n ${precmd_functions+x} ]]; then
  preexec_functions+=(__voidlink_started)
  precmd_functions+=(__voidlink_prompt)
  # bash-preexec calls preexec for the real command only, so the arming dance
  # above is unnecessary — but harmless, and leaving it in keeps one code path.
  __voidlink_armed=1
else
  # A DEBUG trap already installed by something else would be replaced by ours.
  # Refuse rather than clobber: a half-working integration is recoverable, a
  # silently disabled `trap ... DEBUG` somebody else depends on is not.
  if trap -p DEBUG | grep -q .; then
    printf 'voidlink: a DEBUG trap is already installed; shell integration not loaded.\n' >&2
    return 0
  fi
  trap '__voidlink_started' DEBUG
  # An array PROMPT_COMMAND (bash 5.1+) and a string one both have to work.
  # `declare -p` rather than `${PROMPT_COMMAND@a}`: the parameter transformation
  # is bash 4.4+, and macOS still ships 3.2 as /bin/bash.
  if declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then
    PROMPT_COMMAND=(__voidlink_prompt "${PROMPT_COMMAND[@]}")
  else
    PROMPT_COMMAND="__voidlink_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  fi
fi
