import chalk from 'chalk'

export function success(msg: string): void {
  console.log(`${chalk.green('✓')} ${msg}`)
}

export function error(msg: string): void {
  console.error(`${chalk.red('✗')} ${msg}`)
}

export function warn(msg: string): void {
  console.log(`${chalk.yellow('!')} ${msg}`)
}

export function info(msg: string): void {
  console.log(chalk.dim(msg))
}

export function step(label: string, msg: string): void {
  console.log(`${chalk.blue('→')} ${chalk.bold(label)} ${msg}`)
}

export function header(msg: string): void {
  console.log(`\n${chalk.bold.underline(msg)}`)
}

export function table(rows: string[][]): void {
  if (rows.length === 0) return
  const colWidths = rows[0].map((_, colIdx) =>
    Math.max(...rows.map((row) => (row[colIdx] ?? '').length)),
  )
  for (const row of rows) {
    const line = row.map((cell, i) => cell.padEnd(colWidths[i] + 2)).join('')
    console.log(line)
  }
}

export function handleError(err: unknown): never {
  if (err instanceof Error) {
    error(err.message)
    process.exit(2)
  }
  error(String(err))
  process.exit(2)
}
