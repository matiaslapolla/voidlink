# Voidlink shell integration for Fish — OSC 133 prompt marking
# Injected automatically; do not source manually.

if set -q VOIDLINK_SHELL_INTEGRATION
  exit 0
end
set -gx VOIDLINK_SHELL_INTEGRATION 1

function __voidlink_osc
  printf '\033]133;%s\007' $argv[1]
end

function __voidlink_report_cwd
  printf '\033]7;file://%s%s\033\\' (hostname) (pwd)
end

function __voidlink_fish_prompt --on-event fish_prompt
  __voidlink_osc "D;$status"
  __voidlink_report_cwd
  __voidlink_osc "A"
end

function __voidlink_fish_preexec --on-event fish_preexec
  __voidlink_osc "C"
end

function __voidlink_fish_postexec --on-event fish_postexec
  # postexec fires after command completes; status available via $status
end

# Emit initial prompt start + prompt end
__voidlink_osc "A"
__voidlink_osc "B"
