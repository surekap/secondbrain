'use strict'

const INSTALL_MARK = Symbol.for('secondbrain.processOutputGuardInstalled')

function installProcessOutputGuard({
  stdout = process.stdout,
  stderr = process.stderr,
  exit = process.exit,
} = {}) {
  if (process[INSTALL_MARK]) return false
  process[INSTALL_MARK] = true

  // A supervised worker cannot do useful work after its output channel dies.
  // Exit synchronously instead of letting an uncaughtException logger write to
  // the same broken pipe forever.
  const onOutputError = () => exit(1)
  stdout?.on?.('error', onOutputError)
  stderr?.on?.('error', onOutputError)
  return true
}

if (process.env.SECOND_BRAIN_PROCESS_OUTPUT_GUARD === '1') {
  installProcessOutputGuard()
}

module.exports = { installProcessOutputGuard }
