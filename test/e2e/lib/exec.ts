import { spawn } from 'node:child_process'

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${String(code)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`))
    })
  })
}

export async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs = 180_000, intervalMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor(${label}) timed out after ${String(timeoutMs)}ms${lastErr ? `: ${String(lastErr)}` : ''}`)
}

export async function httpGetOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url)
    return res.ok
  } catch {
    return false
  }
}
