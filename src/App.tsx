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
        this.currentTransaction = new Transaction(
          (key) => this.getValue(key),
          (key) => this.has(key),
          (key, value) => this.storeValue(key, value),
          (key, parentKey) => this.setParentKey(key, parentKey),
          (type) => this.generateKey(type),
        )

        updateFn(this.currentTransaction)

        this.incrementUpdateCount()

        this.currentTransaction = null
      })
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

  private setParentKey(key: NonRootKey, parentKey: Key | null) {
    this.parentKeys.set(key, parentKey)
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

class Transaction {
  constructor(
    private readonly getValue: <F extends FlatValue>(
      key: StoredKey<Key, F>,
    ) => F,
    private readonly has: (key: Key) => boolean,
    private readonly storeValue: <K extends Key, F extends FlatValue>(
      key: K,
      value: F,
    ) => StoredKey<K, F>,
    private readonly setParentKey: (
      key: NonRootKey,
      parentKey: Key | null,
    ) => void,
    private readonly generateKey: <T extends string>(
      typeName: T,
    ) => NonRootKey<T>,
  ) {}

  update<F extends FlatValue>(
    key: StoredKey<Key, F>,
    updateFn: F | ((current: F) => F),
  ) {
    const currentValue = this.getValue(key)
    const newValue =
      typeof updateFn === 'function' ? updateFn(currentValue) : updateFn

    this.storeValue(key, newValue)
  }

  insertRoot(
    rootKey: RootKey,
    value: NonRootKey,
  ): StoredKey<RootKey, NonRootKey> {
    invariant(
      !this.has(rootKey),
      'Root node already exists. Only one root node is allowed.',
    )

    return this.storeValue(rootKey, value)
  }

  insert<T extends string, F extends FlatValue>(
    typeName: T,
    parentKey: Key,
    createValue: (key: NonRootKey<T>) => F,
  ): StoredKey<NonRootKey<T>, F> {
    const key = this.generateKey(typeName)
    const value = createValue(key)

    this.setParentKey(key, parentKey)

    return this.storeValue(key, value)
  }
}

type Writable = { transaction: Transaction }

abstract class Stateful {
  protected transaction: Transaction | null = null

  toWritable(transaction: Transaction): this & Writable {
    this.transaction = transaction

    return this as this & Writable
  }

  copyStateFrom(other: Stateful & Writable): this & Writable
  copyStateFrom(other: Stateful): this
  copyStateFrom(other: Stateful): this {
    this.transaction = other.transaction
    return this
  }
}

interface NodeSpec {
  TypeName: string
  Key: Key
  FlatValue: FlatValue
  JSONValue: Record<string, unknown> | unknown[] | PrimitiveValue
}

abstract class FlatNode<S extends NodeSpec> extends Stateful {
  constructor(
    protected store: EditorStore,
    public key: StoredKey<S['Key'], S['FlatValue']>,
  ) {
    super()

    invariant(store.has(key), `Key ${key} does not exist in the store`)
  }

  get value(): S['FlatValue'] {
    return this.store.getValue(this.key)
  }

  abstract toJsonValue(): S['JSONValue']

  protected getParentKeyFromStore(): Key | null {
    return this.store.getParentKey(this.key)
  }

  get __spec__(): S {
    throw new Error('Not meant to be called directly')
  }
}

abstract class TreeNode<S extends NodeSpec> extends Stateful {
  constructor(public readonly jsonValue: S['JSONValue']) {
    super()
  }

  get __spec__(): S {
    throw new Error('Not meant to be called directly')
  }
}

interface NodeType<S extends NodeSpec = NodeSpec> {
  FlatNode: typeof FlatNode<S>
  TreeNode: typeof TreeNode<S>
}
const NodeType = { FlatNode, TreeNode } satisfies NodeType

type Spec<N extends NodeType> = N extends NodeType<infer S> ? S : never

// TODO: Avoid 'any' here
interface ConcreteType<A extends NodeType> {
  FlatNode: new (...args: any) => InstanceType<A['FlatNode']>
  TreeNode: new (...args: any) => InstanceType<A['TreeNode']>
}

type NonRootSpec = Omit<NodeSpec, 'Key'>

abstract class NonRootFlatNode<S extends NonRootSpec> extends NodeType.FlatNode<
  S & { Key: NonRootKey<S['TypeName']> }
> {
  get parentKey(): Key {
    const parentKey = this.getParentKeyFromStore()

    invariant(parentKey != null, `Node ${this.key} has no parent`)

    return parentKey
  }
}

abstract class NonRootTreeNode<S extends NonRootSpec> extends NodeType.TreeNode<
  S & { Key: NonRootKey<S['TypeName']> }
> {
  abstract store(
    this: this & Writable,
    parentKey: Key,
  ): StoredKey<NonRootKey<S['TypeName']>, FlatValue>
}

interface NonRootType<S extends NonRootSpec = NonRootSpec>
  extends NodeType<S & { Key: NonRootKey<S['TypeName']> }> {
  FlatNode: typeof NonRootFlatNode<S>
  TreeNode: typeof NonRootTreeNode<S>
}
const NonRootType = {
  FlatNode: NonRootFlatNode,
  TreeNode: NonRootTreeNode,
} satisfies NonRootType<NonRootSpec>

interface TextSpec extends NonRootSpec {
  TypeName: 'text'
  FlatValue: Y.Text
  JSONValue: string
}

class TextFlatNode extends NonRootType.FlatNode<TextSpec> {
  override toJsonValue() {
    return this.value.toString()
  }
}

class TextTreeNode extends NonRootType.TreeNode<TextSpec> {
  override store(this: this & Writable, parentKey: Key) {
    const value = new Y.Text(this.jsonValue)

    return this.transaction.insert('text', parentKey, () => value)
  }
}

const TextType = {
  FlatNode: TextFlatNode,
  TreeNode: TextTreeNode,
} satisfies ConcreteType<NonRootType<TextSpec>>

function WrappedNode<T extends string, C extends ConcreteType<NonRootType>>(
  typeName: T,
  childType: C,
) {
  interface WrappedNodeSpec {
    TypeName: T
    FlatValue: StoredKey<NonRootKey<Spec<C>['TypeName']>, Spec<C>['FlatValue']>
    JSONValue: { type: T; value: Spec<C>['JSONValue'] }
  }

  class WrappedFlatNode extends NonRootType.FlatNode<WrappedNodeSpec> {
    override toJsonValue(): WrappedNodeSpec['JSONValue'] {
      return { type: typeName, value: this.getChild().toJsonValue() }
    }

    getChild(this: this & Writable): InstanceType<C['FlatNode']> & Writable
    getChild(): InstanceType<C['FlatNode']>
    getChild() {
      return new childType.FlatNode(this.store, this.value).copyStateFrom(this)
    }
  }

  class WrappedTreeNode extends NonRootType.TreeNode<WrappedNodeSpec> {
    override store(this: this & Writable, parentKey: Key) {
      return this.transaction.insert(typeName, parentKey, (key) =>
        this.getChild().store(key),
      )
    }

    getChild(this: this & Writable): InstanceType<C['TreeNode']> & Writable
    getChild(): InstanceType<C['TreeNode']>
    getChild() {
      return new childType.TreeNode(this.jsonValue.value).copyStateFrom(this)
    }
  }

  return { FlatNode: WrappedFlatNode, TreeNode: WrappedTreeNode }
}

const ParagraphType = WrappedNode('paragraph', TextType)

function ArrayNode<T extends string, C extends ConcreteType<NonRootType>>(
  typeName: T,
  childType: C,
) {
  interface ArrayNodeSpec extends NonRootSpec {
    TypeName: T
    FlatValue: StoredKey<
      NonRootKey<Spec<C>['TypeName']>,
      Spec<C>['FlatValue']
    >[]
    JSONValue: Spec<C>['JSONValue'][]
  }

  class ArrayFlatNode extends NonRootType.FlatNode<ArrayNodeSpec> {
    override toJsonValue(): ArrayNodeSpec['JSONValue'] {
      return this.value.map((childKey) =>
        new childType.FlatNode(this.store, childKey).toJsonValue(),
      )
    }

    getChildren(
      this: this & Writable,
    ): (InstanceType<C['FlatNode']> & Writable)[]
    getChildren(): InstanceType<C['FlatNode']>[]
    getChildren() {
      return this.value.map((child) =>
        new childType.FlatNode(this.store, child).copyStateFrom(this),
      )
    }
  }

  class ArrayTreeNode extends NonRootType.TreeNode<ArrayNodeSpec> {
    override store(this: this & Writable, parentKey: Key) {
      return this.transaction.insert(typeName, parentKey, (key) =>
        this.getChildren().map((child) => child.store(key)),
      )
    }

    getChildren(
      this: this & Writable,
    ): (InstanceType<C['TreeNode']> & Writable)[]
    getChildren(): InstanceType<C['TreeNode']>[]
    getChildren() {
      return this.jsonValue.map((child) =>
        new childType.TreeNode(child).copyStateFrom(this),
      )
    }
  }

  return { FlatNode: ArrayFlatNode, TreeNode: ArrayTreeNode }
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

class RootFlatNode extends NodeType.FlatNode<RootSpec> {
  override toJsonValue(): RootSpec['JSONValue'] {
    const doc = new ContentType.FlatNode(this.store, this.value).toJsonValue()

    return { type: 'document', document: doc }
  }
}

class RootTreeNode extends NodeType.TreeNode<RootSpec> {
  store(this: this & Writable, rootKey: RootKey) {
    const doc = new ContentType.TreeNode(this.jsonValue.document)
      .toWritable(this.transaction)
      .store(rootKey)

    return this.transaction.insertRoot(rootKey, doc)
  }
}

type RootType = typeof RootType
const RootType = {
  FlatNode: RootFlatNode,
  TreeNode: RootTreeNode,
} satisfies ConcreteType<NodeType<RootSpec>>

const initialValue: Spec<RootType>['JSONValue'] = {
  type: 'document',
  document: [{ type: 'paragraph', value: 'Hello, Rsbuild!' }],
}

type StoredRootKey = RootType['FlatNode']['prototype']['key']

export default function App() {
  const { store } = useEditorStore()
  const rootKey: StoredRootKey = 'root' as StoredRootKey

  useEffect(() => {
    setTimeout(() => {
      if (store.has(rootKey)) return

      store.update((transaction) => {
        new RootType.TreeNode(initialValue)
          .toWritable(transaction)
          .store('root')
      })
    }, 1000)
  }, [store, rootKey])

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
            if (!store.has(rootKey)) return ''

            const jsonValue = new RootType.FlatNode(
              store,
              rootKey,
            ).toJsonValue()

            return JSON.stringify(jsonValue, null, 2)
          },
        }}
        showOnStartup={{ entries: true, json: true }}
      />
    </main>
  )
}
