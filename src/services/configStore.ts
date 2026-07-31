// Settings live in session and local storage, which React cannot observe. The
// providers that build API clients sit above the component holding the
// settings form, so saving a key used to change nothing until a reload: the
// services kept the provider and key they were constructed with, and pages
// that read storage during render kept whatever was there before the save.
//
// This is the notification side of that storage. Anything that writes a
// setting announces it here, and anything that depends on one subscribes,
// so a saved key takes effect immediately and everywhere.

type ConfigListener = () => void

const listeners = new Set<ConfigListener>()

// A counter rather than a config object: it is the stable snapshot
// useSyncExternalStore needs, and every reader already knows how to load the
// settings it cares about
let revision = 0

export function subscribeToConfig(listener: ConfigListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getConfigRevision(): number {
  return revision
}

export function configChanged(): void {
  revision += 1
  for (const listener of listeners) {
    listener()
  }
}
