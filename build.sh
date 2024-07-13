#!/usr/bin/env bash

shopt -s expand_aliases

if ! command -v nerdctl &>/dev/null; then
  alias nerdctl="docker"
  echo "yep"
fi

case "${1}" in
compile)
  sed "/\#\!\/usr\/bin\/env\ zx/a import 'npm:zx\/globals'\nimport minimist from 'npm:minimist'\nimport process from 'npm:process'\nimport fs from 'npm:fs-extra'\nimport os from 'npm:os'" pelm.mjs >pelm.build.mjs
  sed -i -e 's/const argvOffset = 3/const argvOffset = 2/' pelm.build.mjs
  nerdctl run --rm -it -v "$PWD:$PWD" --workdir "$PWD" denoland/deno compile --output ./pelm --allow-all ./pelm.build.mjs
  ;;
install)
  cp ./pelm "$HOME/.local/bin/pelm"
  ;;
esac
