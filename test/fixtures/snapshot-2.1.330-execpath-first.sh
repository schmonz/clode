# --- Claude Code 2.1.330 shell-snapshot shadows, feature-flagged variant (find, grep, rg) ---
# Provenance: the REAL 2.1.330 darwin-arm64 writer (UUt/BUt/AAi and the No() shell quoter, sliced
# verbatim from the binary) run under node with tengu_playful_dusk ON: each shadow tries the
# RUNNING binary (process.execPath, here a path with a space and an apostrophe, so upstream's
# quoter single-quotes it) and then the install path, spelled as words instead of "$_cc_bin"
# (2026-11-21).
unalias find 2>/dev/null || true
unalias grep 2>/dev/null || true
function find {
  if [[ -x '/home/user/O'"'"'Brien Apps/claude/versions/2.1.330' ]]; then
  if [[ -n ${ZSH_VERSION:-} ]]; then
    ARGV0=bfs '/home/user/O'"'"'Brien Apps/claude/versions/2.1.330' -S dfs -regextype findutils-default ${1+"$@"}
  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
    ARGV0=bfs '/home/user/O'"'"'Brien Apps/claude/versions/2.1.330' -S dfs -regextype findutils-default ${1+"$@"}
  else
    (exec -a bfs '/home/user/O'"'"'Brien Apps/claude/versions/2.1.330' -S dfs -regextype findutils-default ${1+"$@"})
  fi
  elif [[ -x /home/user/.local/bin/claude ]]; then
  if [[ -n ${ZSH_VERSION:-} ]]; then
    ARGV0=bfs /home/user/.local/bin/claude -S dfs -regextype findutils-default ${1+"$@"}
  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
    ARGV0=bfs /home/user/.local/bin/claude -S dfs -regextype findutils-default ${1+"$@"}
  else
    (exec -a bfs /home/user/.local/bin/claude -S dfs -regextype findutils-default ${1+"$@"})
  fi
  else command find ${1+"$@"}; fi
}
function grep {
  local _cc_a
  for _cc_a in ${1+"$@"}; do
    case "$_cc_a" in -*-filter*|-*-pager*|-*-view*|-*-format-open*|-*-config*|---*|-@*|-*-save-config*|-[Zz]*|-[!-]*[Zz]*|--null|--null-data) command grep ${1+"$@"}; return ;; esac
  done
  if [[ -x '/home/user/O'"'"'Brien Apps/claude/versions/2.1.330' ]]; then
  if [[ -n ${ZSH_VERSION:-} ]]; then
    ARGV0=ugrep '/home/user/O'"'"'Brien Apps/claude/versions/2.1.330' -G --ignore-files --hidden -I --encoding=UTF-8 --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl ${1+"$@"}
  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
    ARGV0=ugrep '/home/user/O'"'"'Brien Apps/claude/versions/2.1.330' -G --ignore-files --hidden -I --encoding=UTF-8 --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl ${1+"$@"}
  else
    (exec -a ugrep '/home/user/O'"'"'Brien Apps/claude/versions/2.1.330' -G --ignore-files --hidden -I --encoding=UTF-8 --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl ${1+"$@"})
  fi
  elif [[ -x /home/user/.local/bin/claude ]]; then
  if [[ -n ${ZSH_VERSION:-} ]]; then
    ARGV0=ugrep /home/user/.local/bin/claude -G --ignore-files --hidden -I --encoding=UTF-8 --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl ${1+"$@"}
  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
    ARGV0=ugrep /home/user/.local/bin/claude -G --ignore-files --hidden -I --encoding=UTF-8 --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl ${1+"$@"}
  else
    (exec -a ugrep /home/user/.local/bin/claude -G --ignore-files --hidden -I --encoding=UTF-8 --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl ${1+"$@"})
  fi
  else command grep ${1+"$@"}; fi
}
function rg {
  if [[ -x '/home/user/O'"'"'Brien Apps/claude/versions/2.1.330' ]]; then
  if [[ -n ${ZSH_VERSION:-} ]]; then
    ARGV0=rg '/home/user/O'"'"'Brien Apps/claude/versions/2.1.330' ${1+"$@"}
  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
    ARGV0=rg '/home/user/O'"'"'Brien Apps/claude/versions/2.1.330' ${1+"$@"}
  else
    (exec -a rg '/home/user/O'"'"'Brien Apps/claude/versions/2.1.330' ${1+"$@"})
  fi
  elif [[ -x /home/user/.local/bin/claude ]]; then
  if [[ -n ${ZSH_VERSION:-} ]]; then
    ARGV0=rg /home/user/.local/bin/claude ${1+"$@"}
  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
    ARGV0=rg /home/user/.local/bin/claude ${1+"$@"}
  else
    (exec -a rg /home/user/.local/bin/claude ${1+"$@"})
  fi
  else command rg ${1+"$@"}; fi
}
