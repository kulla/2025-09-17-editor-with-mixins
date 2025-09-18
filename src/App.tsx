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

interface NodeMap {
  text: {
    flatValue: Y.Text
    jsonValue: string
  }
  root: {
    flatValue: Key<'text'>
    jsonValue: { type: 'document'; content: JsonValue<'text'> }
  }
}

type TypeName = keyof NodeMap
type Key<T extends TypeName = TypeName> = `${T}:${number}`
type FlatValue<T extends TypeName = TypeName> = NodeMap[T]['flatValue']
type JsonValue<T extends TypeName> = NodeMap[T]['jsonValue']

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

  getValue<T extends TypeName>(key: Key<T>): FlatValue<T> {
    const value = this.values.get(key)

    invariant(value != null, `Value for key ${key} not found`)

    return value
  }

  getParentKey<T extends TypeName>(key: Key<T>): Key | null {
    return this.parentKeys.get(key) ?? null
  }

  has<T extends TypeName>(key: Key<T>): boolean {
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

  private setValue<T extends TypeName>(key: Key<T>, value: FlatValue<T>) {
    this.values.set(key, value)
  }

  private setParentKey<T extends TypeName>(key: Key<T>, parentKey: Key | null) {
    this.parentKeys.set(key, parentKey)
  }

  private generateKey<T extends TypeName>(typeName: T): Key<T> {
    this.lastKeyNumber += 1

    return `${typeName}:${this.lastKeyNumber}`
  }
}

class Transaction {
  constructor(
    private readonly getValue: <T extends TypeName>(
      key: Key<T>,
    ) => FlatValue<T>,
    private readonly setValue: <T extends TypeName>(
      key: Key<T>,
      value: FlatValue<T>,
    ) => void,
    private readonly setParentKey: <T extends TypeName>(
      key: Key<T>,
      parentKey: Key | null,
    ) => void,
    private readonly generateKey: <T extends TypeName>(typeName: T) => Key<T>,
  ) {}

  update<T extends TypeName>(
    key: Key<T>,
    updateFn: FlatValue<T> | ((current: FlatValue<T>) => FlatValue<T>),
  ) {
    const currentValue = this.getValue(key)
    const newValue =
      typeof updateFn === 'function' ? updateFn(currentValue) : updateFn

    this.setValue(key, newValue)
  }

  insert<T extends TypeName>(
    typeName: T,
    parentKey: Key | null,
    createValue: (key: Key<T>) => FlatValue<T>,
  ): Key<T> {
    const key = this.generateKey(typeName)
    const value = createValue(key)

    this.setValue(key, value)
    this.setParentKey(key, parentKey)

    return key
  }
}

abstract class FlatNode<T extends TypeName> {
  constructor(
    protected store: EditorStore,
    public key: Key<T>,
  ) {
    invariant(store.has(key), `Key ${key} does not exist in the store`)
  }

  get value(): FlatValue<T> {
    return this.store.getValue(this.key)
  }

  get parentKey(): Key | null {
    return this.store.getParentKey(this.key)
  }

  abstract toJsonValue(): JsonValue<T>
}

abstract class NodeType<T extends TypeName> {
  abstract readonly name: T

  abstract readonly FlatNode: new (
    store: EditorStore,
    key: Key<T>,
  ) => FlatNode<T>

  createFlatNode(store: EditorStore, key: Key<T>): FlatNode<T> {
    return new this.FlatNode(store, key)
  }
}

export const RootType = new (class RootType extends NodeType<'root'> {
  override name = 'root' as const

  override FlatNode = class RootNode extends FlatNode<'root'> {
    override toJsonValue(): JsonValue<'root'> {
      const childNode = TextType.createFlatNode(this.store, this.value)

      return { type: 'document', content: childNode.toJsonValue() }
    }
  }

  storeJsonValue(tx: Transaction, value: JsonValue<'root'>): Key<'root'> {
    return tx.insert('root', null, (key) =>
      TextType.storeJsonValue(tx, key, value.content),
    )
  }
})()

abstract class ChildNodeType<T extends TypeName> extends NodeType<T> {
  abstract storeJsonValue(
    tx: Transaction,
    parentKey: Key,
    value: JsonValue<T>,
  ): Key<T>
}

const TextType = new (class TextType extends ChildNodeType<'text'> {
  override name = 'text' as const

  override FlatNode = class TextNode extends FlatNode<'text'> {
    override toJsonValue(): JsonValue<'text'> {
      return this.value.toString()
    }
  }

  storeJsonValue(
    tx: Transaction,
    parentKey: Key,
    value: JsonValue<'text'>,
  ): Key<'text'> {
    return tx.insert('text', parentKey, () => new Y.Text(value))
  }
})()
