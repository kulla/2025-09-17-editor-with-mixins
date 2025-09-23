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

type StoredKey<K extends Key, F extends FlatValue> = K & { __StoredType__: F }

interface Transaction {
  update<F extends FlatValue>(
    key: StoredKey<Key, F>,
    updateFn: F | ((current: F) => F),
  ): void
  insertRoot<F extends FlatValue>(
    rootKey: RootKey,
    value: F,
  ): StoredKey<RootKey, F>
  insert<T extends string, F extends FlatValue>(
    typeName: T,
    parentKey: Key,
    createValue: (key: NonRootKey<T>) => F,
  ): StoredKey<NonRootKey<T>, F>
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

  getValue<F extends FlatValue>(key: StoredKey<Key, F>): F {
    const value = this.values.get(key)

    invariant(value != null, `Value for key ${key} not found`)

    return value as F
  }

  getParentKey(key: Key): Key | null {
    return this.parentKeys.get(key) ?? null
  }

  has(key: Key): key is StoredKey<Key, FlatValue> {
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
      update: (key, updateFn) => {
        const currentValue = this.getValue(key)
        const newValue =
          typeof updateFn === 'function' ? updateFn(currentValue) : updateFn

        this.storeValue(key, newValue)
      },
      insertRoot: (rootKey, value) => {
        invariant(
          !this.has(rootKey),
          `Root key ${rootKey} already exists in the store`,
        )

        return this.storeValue(rootKey, value)
      },
      insert: (typeName, parentKey, createValue) => {
        const newKey = this.generateKey(typeName)
        const value = createValue(newKey)

        this.parentKeys.set(newKey, parentKey)
        return this.storeValue(newKey, value)
      },
    }
  }

  private incrementUpdateCount() {
    this.state.set('updateCount', this.updateCount + 1)
  }

  private storeValue<K extends Key, F extends FlatValue>(
    key: K,
    value: F,
  ): StoredKey<K, F> {
    this.values.set(key, value)

    return key as StoredKey<K, F>
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
  key: StoredKey<S['Key'], S['FlatValue']>
}

interface NodeType<S extends NodeSpec = NodeSpec> {
  __spec__(): S
  typeName: S['TypeName']

  getFlatValue(node: FlatNode<S>): S['FlatValue']
  getParentKey(node: FlatNode<S>): S['ParentKey']
  toJsonValue(node: FlatNode<S>): S['JSONValue']
}

function AbstractNodeType<S extends NodeSpec>() {
  return {
    __spec__(): S {
      throw new Error('This function should not be called')
    },

    getFlatValue({ store, key }): S['FlatValue'] {
      return store.getValue(key)
    },

    getParentKey({ store, key }): S['ParentKey'] {
      return store.getParentKey(key)
    },
  } satisfies Partial<NodeType<S>>
}

type Spec<N extends { __spec__: () => NodeSpec }> = ReturnType<N['__spec__']>

type NonRootSpec = Omit<NodeSpec, 'Key' | 'ParentKey'>
type ToNodeSpec<S extends NonRootSpec> = S & {
  Key: NonRootKey<S['TypeName']>
  ParentKey: Key
}

interface NonRootType<S extends NonRootSpec = NonRootSpec>
  extends NodeType<ToNodeSpec<S>> {
  storeNonRoot(
    jsonValue: S['JSONValue'],
    tx: Transaction,
    parentKey: Key,
  ): StoredKey<NonRootKey<S['TypeName']>, S['FlatValue']>
}

function AbstractNonRootType<S extends NonRootSpec>() {
  return AbstractNodeType<ToNodeSpec<S>>() satisfies Partial<NonRootType<S>>
}

type TextSpec = { TypeName: 'text'; FlatValue: Y.Text; JSONValue: string }

const TextType = {
  typeName: 'text' as const,

  ...AbstractNonRootType<TextSpec>(),

  toJsonValue(node) {
    return this.getFlatValue(node).toString()
  },

  storeNonRoot(jsonValue, tx, parentKey) {
    return tx.insert('text', parentKey, () => new Y.Text(jsonValue))
  },
} satisfies NonRootType<TextSpec>

type WrappedNodeSpec<T extends string, C extends NonRootType> = {
  TypeName: T
  FlatValue: StoredKey<NonRootKey<Spec<C>['TypeName']>, Spec<C>['FlatValue']>
  JSONValue: { type: T; value: Spec<C>['JSONValue'] }
}

interface WrappedNodeType<T extends string, C extends NonRootType>
  extends NonRootType<WrappedNodeSpec<T, C>> {
  getChild(node: FlatNode<ToNodeSpec<WrappedNodeSpec<T, C>>>): FlatNode<Spec<C>>
}

function WrappedNode<T extends string, C extends NonRootType>(
  typeName: T,
  childType: C,
) {
  return {
    typeName,

    ...AbstractNonRootType<WrappedNodeSpec<T, C>>(),

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
  } satisfies WrappedNodeType<T, C>
}

const ParagraphType = WrappedNode('paragraph', TextType)

interface ArrayNodeSpec<T extends string, C extends NonRootType>
  extends NonRootSpec {
  TypeName: T
  FlatValue: StoredKey<NonRootKey<Spec<C>['TypeName']>, Spec<C>['FlatValue']>[]
  JSONValue: Spec<C>['JSONValue'][]
}

interface ArrayNodeType<T extends string, C extends NonRootType>
  extends NonRootType<ArrayNodeSpec<T, C>> {
  getChildren(
    node: FlatNode<ToNodeSpec<ArrayNodeSpec<T, C>>>,
  ): FlatNode<Spec<C>>[]
}

function ArrayNode<T extends string, C extends NonRootType>(
  typeName: T,
  childType: C,
) {
  return {
    typeName,

    ...AbstractNonRootType<ArrayNodeSpec<T, C>>(),

    // TODO: Why do I need a typecast here?!
    toJsonValue(node): Spec<C>['JSONValue'][] {
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
  } satisfies ArrayNodeType<T, C>
}

type ContentType = typeof ContentType
const ContentType = ArrayNode('content', ParagraphType)

interface RootSpec extends NodeSpec {
  TypeName: 'root'
  Key: RootKey
  FlatValue: StoredKey<
    NonRootKey<Spec<ContentType>['TypeName']>,
    Spec<ContentType>['FlatValue']
  >
  JSONValue: { type: 'document'; document: Spec<ContentType>['JSONValue'] }
}

interface RootType extends NodeType<RootSpec> {
  storeRoot(
    jsonValue: RootSpec['JSONValue'],
    tx: Transaction,
    rootKey: RootKey,
  ): StoredKey<RootKey, RootSpec['FlatValue']>
}

const RootType = {
  typeName: 'root' as const,

  ...AbstractNodeType<RootSpec>(),

  toJsonValue(node) {
    const value = node.store.getValue(node.key)
    const doc = ContentType.toJsonValue({ store: node.store, key: value })

    return { type: 'document', document: doc }
  },

  storeRoot(jsonValue, tx, rootKey) {
    const flatValue = ContentType.storeNonRoot(jsonValue.document, tx, rootKey)

    return tx.insertRoot(rootKey, flatValue) as StoredKey<
      RootKey,
      RootSpec['FlatValue']
    >
  },
} satisfies RootType

const initialValue: Spec<RootType>['JSONValue'] = {
  type: 'document',
  document: [{ type: 'paragraph', value: 'Hello, Rsbuild!' }],
}

function getFlatNode<C extends NodeType>(
  store: EditorStore,
  key: Spec<C>['Key'],
): FlatNode<Spec<C>> | null {
  if (!store.has(key)) return null

  return { store, key }
}

export default function App() {
  const { store } = useEditorStore()
  const rootNode = useRef<FlatNode<RootSpec> | null>(null)

  useEffect(() => {
    setTimeout(() => {
      rootNode.current = getFlatNode<RootType>(store, 'root')

      if (rootNode.current) return

      store.update((tx) => {
        const rootKey = RootType.storeRoot(initialValue, tx, 'root')

        rootNode.current = { store, key: rootKey }
      })
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
          entries: () =>
            store
              .getValueEntries()
              .map(
                ([key, entry]) =>
                  `${padStart(key, 11)}: ${JSON.stringify(entry)}`,
              )
              .join('\n'),
          json: () => {
            if (rootNode.current == null) return ''

            const jsonValue = RootType.toJsonValue(rootNode.current)
            return JSON.stringify(jsonValue, null, 2)
          },
        }}
        showOnStartup={{ entries: true, json: true }}
      />
    </main>
  )
}
