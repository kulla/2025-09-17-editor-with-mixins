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

let ydoc: Y.Doc | null = null

function getSingletonYDoc() {
  if (!ydoc) {
    ydoc = new Y.Doc()
  }
  return ydoc
}

export class EditorStore {
  private lastKeyNumber = 0
  protected values: Y.Map<FlatNodeValue>
  protected parentKeys: Y.Map<Key | null>

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

  update(updateFn: (tx: Transaction) => void) {
    const tx = new Transaction(
      (key) => this.getValue(key),
      (key, value) => this.setValue(key, value),
    )

    updateFn(tx)
  }

  private setValue(key: Key, value: FlatNodeValue) {
    this.values.set(key, value)
  }

  private setParentKey(key: Key, parentKey: Key | null) {
    this.parentKeys.set(key, parentKey)
  }

  private generateKey(type: string): Key {
    this.lastKeyNumber += 1

    return `${type}:${this.lastKeyNumber}`
  }
}

class Transaction {
  constructor(
    private readonly getValue: (key: Key) => FlatNodeValue,
    private readonly setValue: (key: Key, value: FlatNodeValue) => void,
  ) {}

  update(
    key: Key,
    updateFn: FlatNodeValue | ((current: FlatNodeValue) => FlatNodeValue),
  ) {
    const currentValue = this.getValue(key)
    const newValue =
      typeof updateFn === 'function' ? updateFn(currentValue) : updateFn

    this.setValue(key, newValue)
  }
}
