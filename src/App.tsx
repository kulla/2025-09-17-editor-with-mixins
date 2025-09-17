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

let ydoc: Y.Doc | null = null

function getSingletonYDoc() {
  if (!ydoc) {
    ydoc = new Y.Doc()
  }
  return ydoc
}

interface NodeSpec {
  type: string
  flatValue:
    | Key
    | Record<string, Key>
    | Key[]
    | Y.Text
    | number
    | boolean
    | string
  jsonValue: object | unknown[] | number | boolean | string
}
type Type<S extends NodeSpec> = S['type']
type Key<S extends NodeSpec = NodeSpec> = `${S['type']}:${number}`
type FlatValue<S extends NodeSpec = NodeSpec> = S['flatValue']

export class EditorStore {
  protected values: Y.Map<FlatValue>
  protected parentKeys: Y.Map<Key | null>
  protected state: Y.Map<unknown>
  private lastKeyNumber = 0
  private currentTransaction: Transaction | null = null

  constructor(ydoc = getSingletonYDoc()) {
    this.values = ydoc.getMap('values')
    this.parentKeys = ydoc.getMap('parentKeys')
    this.state = ydoc.getMap('state')
  }

  getValue<S extends NodeSpec>(key: Key<S>): FlatValue<S> {
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

  get updateCount() {
    const count = this.state.get('updateCount') ?? 0

    invariant(typeof count === 'number', 'updateCount must be a number')

    return count
  }

  update(updateFn: (tx: Transaction) => void) {
    if (this.currentTransaction) {
      // If we're already in a transaction, just call the update function directly
      updateFn(this.currentTransaction)
      return
    } else {
      this.currentTransaction = new Transaction(
        (key) => this.getValue(key),
        (key, value) => this.setValue(key, value),
        (key, parentKey) => this.setParentKey(key, parentKey),
        (type) => this.generateKey(type),
      )

      updateFn(this.currentTransaction)

      this.incrementUpdateCount()

      this.currentTransaction = null
    }
  }

  private incrementUpdateCount() {
    this.state.set('updateCount', this.updateCount + 1)
  }

  private setValue<S extends NodeSpec>(key: Key<S>, value: FlatValue<S>) {
    this.values.set(key, value)
  }

  private setParentKey(key: Key, parentKey: Key | null) {
    this.parentKeys.set(key, parentKey)
  }

  private generateKey<S extends NodeSpec>(type: Type<S>): Key<S> {
    this.lastKeyNumber += 1

    return `${type}:${this.lastKeyNumber}`
  }
}

class Transaction {
  constructor(
    private readonly getValue: <S extends NodeSpec>(
      key: Key<S>,
    ) => FlatValue<S>,
    private readonly setValue: <S extends NodeSpec>(
      key: Key<S>,
      value: FlatValue<S>,
    ) => void,
    private readonly setParentKey: (key: Key, parentKey: Key | null) => void,
    private readonly generateKey: (type: string) => Key,
  ) {}

  update<S extends NodeSpec>(
    key: Key<S>,
    updateFn: FlatValue<S> | ((current: FlatValue<S>) => FlatValue<S>),
  ) {
    const currentValue = this.getValue(key)
    const newValue =
      typeof updateFn === 'function' ? updateFn(currentValue) : updateFn

    this.setValue(key, newValue)
  }

  insert<S extends NodeSpec>(
    type: Type<S>,
    parentKey: Key | null,
    createValue: (key: Key<S>) => FlatValue<S>,
  ) {
    const key = this.generateKey(type)
    const value = createValue(key)

    this.setValue(key, value)
    this.setParentKey(key, parentKey)
  }
}

abstract class FlatNode<S extends NodeSpec = NodeSpec> {
  constructor(
    protected store: EditorStore,
    public key: Key<S>,
  ) {
    invariant(store.has(key), `Key ${key} does not exist in the store`)
  }

  get value(): FlatValue<S> {
    return this.store.getValue(this.key)
  }

  get parentKey(): Key | null {
    return this.store.getParentKey(this.key)
  }
}
