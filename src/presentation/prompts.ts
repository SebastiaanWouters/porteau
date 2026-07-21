import * as clack from '@clack/prompts'

export interface PromptAdapter {
  text(message: string, signal?: AbortSignal): Promise<string | undefined>
  password(message: string, signal?: AbortSignal): Promise<string | undefined>
  confirm(message: string, signal?: AbortSignal): Promise<boolean | undefined>
}
export const clackPrompts: PromptAdapter = {
  async text(message, signal) {
    const value = await clack.text({ message, ...(signal ? { signal } : {}) })
    return clack.isCancel(value) ? undefined : value
  },
  async password(message, signal) {
    const value = await clack.password({ message, ...(signal ? { signal } : {}) })
    return clack.isCancel(value) ? undefined : value
  },
  async confirm(message, signal) {
    const value = await clack.confirm({
      message,
      initialValue: false,
      ...(signal ? { signal } : {}),
    })
    return clack.isCancel(value) ? undefined : value
  },
}
