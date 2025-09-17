import '@picocss/pico/css/pico.min.css'
import './App.css'
import { invariant } from 'es-toolkit'
import type * as Y from 'yjs'
import { DebugPanel } from './components/debug-panel'

export default function App() {
  return (
    <main className="p-10">
      <h1>Rsbuild with React</h1>
      <p>Start building amazing things with Rsbuild.</p>
      <DebugPanel
        labels={{ example: 'Example' }}
        getCurrentValue={{ example: () => 'Hello World!' }}
        showOnStartup={{ example: true }}
      />
    </main>
  )
}

type Key<T extends string = string> = `${T}:${number}`
type FlatNodeValue =
  | Key
  | Record<string, Key>
  | Key[]
  | Y.Text
  | number
  | boolean
  | string

export class EditorStore {
  protected values = new Map<Key, FlatNodeValue>()

  getValue(key: Key): FlatNodeValue {
    const value = this.values.get(key)

    invariant(value != null, `Value for key ${key} not found`)

    return value
  }
}
