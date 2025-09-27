import '@picocss/pico/css/pico.min.css'
import './App.css'
import { invariant } from 'es-toolkit'
import { padStart } from 'es-toolkit/compat'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import { DebugPanel } from './components/debug-panel'

let ydoc: Y.Doc | null = null

function getSingletonYDoc() {
  if (!ydoc) {
    ydoc = new Y.Doc()
  }
  return ydoc
}

type NonRootKey<T extends string = string> = `${T}:${number}`
type RootKey = 'root'
type Key = RootKey | NonRootKey

type PrimitiveValue = string | number | boolean
type FlatValue =
  | PrimitiveValue
  | Y.Text
  | NonRootKey
  | NonRootKey[]
  | Record<string, NonRootKey>

function isNonRootKey<T extends string>(
  value: unknown,
  type: T,
): value is NonRootKey<T> {
  return typeof value === 'string' && value.startsWith(`${type}:`)
}

interface Transaction {
  update<F extends FlatValue>(
    validator: (value: FlatValue) => value is F,
    key: Key,
    updateFn: F | ((current: F) => F),
  ): void
  insertRoot(rootKey: RootKey, value: NonRootKey): void
  insert<T extends string>(
    typeName: T,
    parentKey: Key,
    createValue: (key: NonRootKey<T>) => FlatValue,
  ): NonRootKey<T>
}

export class EditorStore {
  protected readonly values: Y.Map<FlatValue>
  protected readonly parentKeys: Y.Map<Key | null>
  protected readonly state: Y.Map<unknown>
  private lastKeyNumber = 0
  private currentTransaction: Transaction | null = null

  constructor(private readonly ydoc = getSingletonYDoc()) {
    this.values = ydoc.getMap('values')
    this.parentKeys = ydoc.getMap('parentKeys')
    this.state = ydoc.getMap('state')
  }

  getValue<F extends FlatValue>(
    guard: (value: FlatValue) => value is F,
    key: Key,
  ): F {
    const value = this.values.get(key)

    invariant(value != null, `Value for key ${key} not found`)
    invariant(guard(value), `Value for key ${key} has unexpected type`)

    return value
  }

  getParentKey(key: Key): Key | null {
    return this.parentKeys.get(key) ?? null
  }

  has(key: Key): boolean {
    return this.values.has(key)
  }

  getValueEntries() {
    return Array.from(this.values.entries())
  }

  get updateCount() {
    const count = this.state.get('updateCount') ?? 0

    invariant(typeof count === 'number', 'updateCount must be a number')

    return count
  }

  addUpdateListener(listener: () => void) {
    this.ydoc.on('update', listener)
  }

  removeUpdateListener(listener: () => void) {
    this.ydoc.off('update', listener)
  }

  update(updateFn: (tx: Transaction) => void) {
    if (this.currentTransaction) {
      // If we're already in a transaction, just call the update function directly
      updateFn(this.currentTransaction)
      return
    } else {
      this.ydoc.transact(() => {
        this.currentTransaction = this.createNewTransaction()

        updateFn(this.currentTransaction)

        this.incrementUpdateCount()

        this.currentTransaction = null
      })
    }
  }

  private createNewTransaction(): Transaction {
    return {
      update: (guard, key, updateFn) => {
        const currentValue = this.getValue(guard, key)
        const newValue =
          typeof updateFn === 'function' ? updateFn(currentValue) : updateFn

        this.values.set(key, newValue)
      },
      insertRoot: (rootKey, value) => {
        invariant(
          !this.has(rootKey),
          `Root key ${rootKey} already exists in the store`,
        )

        this.values.set(rootKey, value)
      },
      insert: (typeName, parentKey, createValue) => {
        const newKey = this.generateKey(typeName)
        const value = createValue(newKey)

        this.parentKeys.set(newKey, parentKey)
        this.values.set(newKey, value)

        return newKey
      },
    }
  }

  private incrementUpdateCount() {
    this.state.set('updateCount', this.updateCount + 1)
  }

  private generateKey<T extends string>(typeName: T): NonRootKey<T> {
    this.lastKeyNumber += 1

    return `${typeName}:${this.lastKeyNumber}`
  }
}

export function useEditorStore() {
  const store = useRef(new EditorStore()).current
  const lastReturn = useRef({ store, updateCount: store.updateCount })

  return useSyncExternalStore(
    (listener) => {
      store.addUpdateListener(listener)

      return () => store.removeUpdateListener(listener)
    },
    () => {
      if (lastReturn.current.updateCount === store.updateCount) {
        return lastReturn.current
      }

      lastReturn.current = { store, updateCount: store.updateCount }

      return lastReturn.current
    },
  )
}

interface NodeSpec {
  TypeName: string
  Key: Key
  ParentKey: Key | null
  FlatValue: FlatValue
  JSONValue: Record<string, unknown> | unknown[] | PrimitiveValue
}

interface FlatNode<S extends NodeSpec> {
  store: EditorStore
  key: S['Key']
}

interface NodeType<S extends NodeSpec = NodeSpec> {
  typeName: S['TypeName']
  getFlatValue(node: FlatNode<S>): S['FlatValue']
  getParentKey(node: FlatNode<S>): S['ParentKey']
  isValidFlatValue(value: FlatValue): value is S['FlatValue']
  toJsonValue(node: FlatNode<S>): S['JSONValue']
  __spec__(): S
}

type Abstract<T extends object> = {
  [K in keyof T]?: T[K] extends (...args: infer A) => infer R
    ? (this: T, ...args: A) => R
    : T[K]
}

function AbstractNode<S extends NodeSpec>() {
  return {
    __spec__() {
      throw new Error('This function should not be called')
    },

    getFlatValue({ store, key }) {
      return store.getValue(this.isValidFlatValue, key)
    },

    getParentKey({ store, key }) {
      return store.getParentKey(key)
    },
  } satisfies Abstract<NodeType<S>>
}

type Spec<N extends { __spec__: () => NodeSpec }> = ReturnType<N['__spec__']>

type NonRootSpecValue = Omit<NodeSpec, 'Key' | 'ParentKey'>
type NonRootSpec<S extends NonRootSpecValue = NonRootSpecValue> = S & {
  Key: NonRootKey<S['TypeName']>
  ParentKey: Key
}

function NonRootNode<S extends NonRootSpec>() {
  const Base = AbstractNode<S>()

  return {
    ...Base,

    getParentKey(node) {
      const parentKey = Base.getParentKey.call(this, node)

      invariant(parentKey != null, 'Non-root node must have a parent key')

      return parentKey
    },
  } satisfies Abstract<NodeType<S>>
}

interface NonRootType<S extends NonRootSpec = NonRootSpec> extends NodeType<S> {
  getParentKey(node: FlatNode<S>): S['ParentKey']
  storeNonRoot(
    jsonValue: S['JSONValue'],
    tx: Transaction,
    parentKey: S['ParentKey'],
  ): S['Key']
}

type TextSpec = NonRootSpec<{
  TypeName: 'text'
  FlatValue: Y.Text
  JSONValue: string
}>

const TextType: NonRootType<TextSpec> = {
  typeName: 'text' as const,

  ...NonRootNode<TextSpec>(),

  isValidFlatValue(value) {
    return value instanceof Y.Text
  },

  toJsonValue(node) {
    return this.getFlatValue(node).toString()
  },

  storeNonRoot(jsonValue, tx, parentKey) {
    return tx.insert('text', parentKey, () => new Y.Text(jsonValue))
  },
}

type WrappedNodeSpec<T extends string, C extends NonRootSpec> = NonRootSpec<{
  TypeName: T
  FlatValue: NonRootKey<C['TypeName']>
  JSONValue: { type: T; value: C['JSONValue'] }
}>

interface WrappedNodeType<T extends string, C extends NonRootSpec>
  extends NonRootType<WrappedNodeSpec<T, C>> {
  getChild(node: FlatNode<WrappedNodeSpec<T, C>>): FlatNode<C>
}

function WrappedNode<T extends string, C extends NonRootType>(
  typeName: T,
  childType: C,
): WrappedNodeType<T, Spec<C>> {
  return {
    typeName,

    ...NonRootNode<WrappedNodeSpec<T, Spec<C>>>(),

    isValidFlatValue(value) {
      return isNonRootKey(value, childType.typeName)
    },

    toJsonValue(node) {
      const value = childType.toJsonValue(this.getChild(node))

      return { type: typeName, value }
    },

    getChild(node) {
      return { store: node.store, key: this.getFlatValue(node) }
    },

    storeNonRoot(jsonValue, tx, parentKey) {
      return tx.insert(typeName, parentKey, (key) =>
        childType.storeNonRoot(jsonValue.value, tx, key),
      )
    },
  }
}

const ParagraphType = WrappedNode('paragraph', TextType)

type ArrayNodeSpec<T extends string, C extends NonRootSpec> = NonRootSpec<{
  TypeName: T
  FlatValue: NonRootKey<C['TypeName']>[]
  JSONValue: C['JSONValue'][]
}>

interface ArrayNodeType<T extends string, C extends NonRootSpec>
  extends NonRootType<ArrayNodeSpec<T, C>> {
  getChildren(node: FlatNode<ArrayNodeSpec<T, C>>): FlatNode<C>[]
}

function isArrayOf<C>(
  value: unknown,
  itemValidator: (v: unknown) => v is C,
): value is C[] {
  return Array.isArray(value) && value.every(itemValidator)
}

function ArrayNode<T extends string, C extends NonRootType>(
  typeName: T,
  childType: C,
): ArrayNodeType<T, Spec<C>> {
  return {
    typeName,

    ...NonRootNode<ArrayNodeSpec<T, Spec<C>>>(),

    isValidFlatValue(value) {
      return isArrayOf(value, (v) => isNonRootKey(v, childType.typeName))
    },

    toJsonValue(node) {
      return this.getChildren(node).map((child) => childType.toJsonValue(child))
    },

    getChildren(node) {
      return this.getFlatValue(node).map((key) => ({ store: node.store, key }))
    },

    storeNonRoot(jsonValue, tx, parentKey) {
      return tx.insert(typeName, parentKey, (key) =>
        jsonValue.map((item) => childType.storeNonRoot(item, tx, key)),
      )
    },
  }
}

const ContentType = ArrayNode('content', ParagraphType)

interface RootSpec<C extends NonRootSpec> extends NodeSpec {
  TypeName: 'root'
  Key: RootKey
  FlatValue: NonRootKey<C['TypeName']>
  JSONValue: C['JSONValue']
}

interface RootType<C extends NonRootSpec> extends NodeType<RootSpec<C>> {
  storeRoot(
    jsonValue: RootSpec<C>['JSONValue'],
    tx: Transaction,
    rootKey: RootKey,
  ): void
}

function RootType<C extends NonRootType>(childType: C): RootType<Spec<C>> {
  return {
    typeName: 'root' as const,

    ...AbstractNode<RootSpec<Spec<C>>>(),

    getParentKey() {
      return null
    },

    isValidFlatValue(value) {
      return isNonRootKey(value, childType.typeName)
    },

    toJsonValue(node) {
      const value = this.getFlatValue(node)
      return childType.toJsonValue({ store: node.store, key: value })
    },

    storeRoot(jsonValue, tx, rootKey) {
      const flatValue = childType.storeNonRoot(jsonValue, tx, rootKey)

      tx.insertRoot(rootKey, flatValue)
    },
  }
}

type AppRootType = typeof AppRootType
const AppRootType = RootType(ContentType)
const initialValue: Spec<AppRootType>['JSONValue'] = [
  { type: 'paragraph', value: 'Hello, Rsbuild!' },
]
const rootKey: RootKey = 'root'

export default function App() {
  const { store } = useEditorStore()

  useEffect(() => {
    setTimeout(() => {
      if (store.has(rootKey)) return

      store.update((tx) => AppRootType.storeRoot(initialValue, tx, 'root'))
    }, 1000)
  }, [store])

  return (
    <main className="p-10">
      <h1>Rsbuild with React</h1>
      <p>Start building amazing things with Rsbuild.</p>
      <DebugPanel
        labels={{
          entries: 'Internal editor store',
          json: 'JSON representation',
        }}
        getCurrentValue={{
          entries: () => {
            const stringifyEntry = ([key, entry]: [string, unknown]) =>
              `${padStart(key, 11)}: ${JSON.stringify(entry)}`

            return store.getValueEntries().map(stringifyEntry).join('\n')
          },
          json: () => {
            if (!store.has(rootKey)) return ''

            const jsonValue = AppRootType.toJsonValue({ store, key: rootKey })
            return JSON.stringify(jsonValue, null, 2)
          },
        }}
        showOnStartup={{ entries: true, json: true }}
      />
    </main>
  )
}
