import type { Volatile } from '@deepseek-ai/cordis'

/** Loader-owned live settings, while direct fixture configurations stay plain values. */
export type LiveValue<T> = T | Volatile<T>

export function liveValue<T>(value: LiveValue<T>): T {
  return typeof value === 'object' && value !== null && 'get' in value
    ? (value as Volatile<T>).get() as T
    : value as T
}
