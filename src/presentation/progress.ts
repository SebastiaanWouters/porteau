import * as clack from '@clack/prompts'

export interface InteractiveProgress {
  start(message: string): void
  update(message: string): void
  stop(message: string): void
  cancel(message: string): void
}

export type ProgressFactory = (signal?: AbortSignal) => InteractiveProgress

export const clackProgress: ProgressFactory = (signal) => {
  const spinner = clack.spinner(signal ? { signal } : {})
  return {
    start: (message) => spinner.start(message),
    update: (message) => spinner.message(message),
    stop: (message) => spinner.stop(message),
    cancel: (message) => spinner.cancel(message),
  }
}
