import '@picocss/pico/css/pico.min.css'
import './App.css'
import { invariant } from 'es-toolkit'
import * as Y from 'yjs'
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
  protected values: Y.Map<FlatNodeValue>
  protected parentKeys: Y.Map<Key>

  constructor(ydoc = getSingletonYDoc()) {
    this.values = ydoc.getMap('values')
    this.parentKeys = ydoc.getMap('parentKeys')
  }

  getValue(key: Key): FlatNodeValue {
    const value = this.values.get(key)

    invariant(value != null, `Value for key ${key} not found`)

    return value
  }

  getParentKey(key: Key): Key | null {
    return this.parentKeys.get(key) ?? null
  }

  has(key: Key) {
    return this.values.has(key)
  }

  getValueEntires() {
    return Array.from(this.values.entries())
  }
}

let ydoc: Y.Doc | null = null

function getSingletonYDoc() {
  if (!ydoc) {
    ydoc = new Y.Doc()
  }
  return ydoc
}
