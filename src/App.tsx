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
      key: Key,
      value: F,
    ) => StoredKey<K, F>,
    private readonly setParentKey: (key: Key, parentKey: Key | null) => void,
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

  toWritable(transaction: Transaction) {
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
  TypeName: string | null
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
}

abstract class TreeNode<S extends NodeSpec> extends Stateful {
  constructor(public readonly jsonValue: S['JSONValue']) {
    super()
  }
}

class AbstractNodeType<
  S extends NodeSpec,
  T extends S['TypeName'],
  F extends typeof FlatNode<S>,
  W extends typeof TreeNode<S>,
> {
  constructor(
    public readonly typeName: T,
    public readonly FlatNode: F,
    public readonly TreeNode: W,
  ) {}

  specialize<
    S2 extends S,
    T2 extends S2['TypeName'],
    F2 extends typeof FlatNode<S2>,
    W2 extends TreeNode<S2>,
  >(update: () => [T2, F2])
}

const BaseNodeType = new AbstractNodeType(null, FlatNode, TreeNode)

interface ContentNodeType<
  S extends NodeSpec,
  F extends typeof FlatNode<S>,
  T extends typeof TreeNode<S>,
> extends AbstractNodeType<S, F, T> {
  typeName: S['TypeName']
  FlatNode: new (
    store: EditorStore,
    key: StoredKey<S['FlatValue']>,
  ) => InstanceType<F>
  TreeNode: new (jsonValue: S['JSONValue']) => InstanceType<T>
  createFlatNode: (
    store: EditorStore,
    key: StoredKey<S['FlatValue']>,
  ) => InstanceType<F>
  createTreeNode: (jsonValue: S['JSONValue']) => InstanceType<T>
}

class NodeTypeBuilder<
  S extends NodeSpec,
  F extends typeof FlatNode<S>,
  T extends typeof TreeNode<S>,
> implements AbstractNodeType<S, F, T>
{
  constructor(public readonly typeName: S['TypeName'] | null = null) {}

  apply<F2 extends typeof FlatNode<T>, W2 extends typeof TreeNode<T>>(
    mixin: Mixin<T, F, W, F2, W2>,
  ) {
    const [NewFlatNode, NewTreeNode] = mixin([
      this.typeName,
      this.FlatNode,
      this.TreeNode,
    ])

    return new NodeTypeBuilder(this.typeName, NewFlatNode, NewTreeNode)
  }

  finish(this: {
    typeName: T
    FlatNode: new (store: EditorStore, key: Key<T>) => InstanceType<F>
    TreeNode: new (jsonValue: JsonValue<T>) => InstanceType<W>
  }) {
    return {
      typeName: this.typeName,
      FlatNode: this.FlatNode,
      TreeNode: this.TreeNode,
      createFlatNode(store: EditorStore, key: Key<T>) {
        return new this.FlatNode(store, key)
      },
      createTreeNode(jsonValue: JsonValue<T>) {
        return new this.TreeNode(jsonValue)
      },
    }
  }

  static create(
    typeName: 'root',
  ): NodeTypeBuilder<'root', typeof FlatNode<'root'>, typeof TreeNode<'root'>>
  static create<T extends Exclude<TypeName, 'root'>>(
    typeName: T,
  ): NodeTypeBuilder<T, typeof NonRootFlatNode<T>, typeof NonRootTreeNode<T>>
  static create<T extends TypeName>(typeName: T) {
    return typeName === 'root'
      ? new NodeTypeBuilder(typeName, FlatNode<T>, TreeNode<T>)
      : new NodeTypeBuilder(typeName, NonRootFlatNode<T>, NonRootTreeNode<T>)
  }
}

const BaseNodeType = { FlatNode, TreeNode } satisfies AbstractNodeType

abstract class NonRootFlatNode<S extends NodeSpec> extends FlatNode<S> {
  get parentKey(): Key {
    const parentKey = this.getParentKeyFromStore()

    invariant(parentKey != null, `Node ${this.key} has no parent`)

    return parentKey
  }
}

abstract class NonRootTreeNode<S extends NodeSpec> extends TreeNode<S> {
  abstract store(
    this: this & Writable,
    parentKey: Key,
  ): StoredKey<S['FlatValue']>
}

type Mixin<
  T extends TypeName,
  F extends typeof FlatNode<T> = typeof FlatNode<T>,
  W extends typeof TreeNode<T> = typeof TreeNode<T>,
  F2 extends typeof FlatNode<T> = F,
  W2 extends typeof TreeNode<T> = W,
> = (arg: [T, F, W]) => readonly [F2, W2]

const TextType = NodeTypeBuilder.create('text')
  .apply(([_, BaseFlatNote, BaseTreeNode]) => {
    class TextFlatNode extends BaseFlatNote {
      override toJsonValue(): JsonValue<'text'> {
        return this.value.toString()
      }
    }

    class TextTreeNode extends BaseTreeNode {
      override store(this: this & Writable, parentKey: Key): Key<'text'> {
        return this.transaction.insert(
          'text',
          parentKey,
          () => new Y.Text(this.jsonValue),
        )
      }
    }

    return [TextFlatNode, TextTreeNode]
  })
  .finish()

type WrappedNodeTypeName = {
  [T in TypeName]: NodeMap[T] extends WrappedNodeSpec<T> ? T : never
}[TypeName]

interface NodeType<
  T extends TypeName,
  F extends typeof FlatNode<T> = typeof FlatNode<T>,
  W extends typeof TreeNode<T> = typeof TreeNode<T>,
> {
  typeName: T
  FlatNode: new (store: EditorStore, key: Key<T>) => InstanceType<F>
  TreeNode: new (jsonValue: JsonValue<T>) => InstanceType<W>
  createFlatNode: (store: EditorStore, key: Key<T>) => InstanceType<F>
  createTreeNode: (jsonValue: JsonValue<T>) => InstanceType<W>
}

type NonRootNodeType<T extends Exclude<TypeName, 'root'>> = NodeType<
  T,
  typeof NonRootFlatNode<T>,
  typeof NonRootTreeNode<T>
>

function WrappedNode<
  T extends WrappedNodeTypeName,
  C extends NonRootNodeType<NodeMap[T]['childType']>,
>(childType: C) {
  return (([typeName, BaseFlatNode, BaseTreeNode]) => {
    class WrappedFlatNode extends BaseFlatNode {
      override toJsonValue(): JsonValue<T> {
        return { type: typeName, value: this.getChild().toJsonValue() }
      }

      getChild(this: this & Writable): InstanceType<C['FlatNode']> & Writable
      getChild(): InstanceType<C['FlatNode']>
      getChild() {
        return this.create(childType, this.value)
      }
    }

    class WrappedTreeNode extends BaseTreeNode {
      override store(this: this & Writable, parentKey: Key): Key<T> {
        return this.transaction.insert(typeName, parentKey, (key) =>
          this.getChild().store(key),
        )
      }

      getChild(this: this & Writable): InstanceType<C['TreeNode']> & Writable
      getChild(): InstanceType<C['TreeNode']>
      getChild() {
        return this.create(childType, this.jsonValue.value)
      }
    }

    return [WrappedFlatNode, WrappedTreeNode]
  }) satisfies Mixin<T, typeof NonRootFlatNode<T>, typeof NonRootTreeNode<T>>
}

const ParagraphType = NodeTypeBuilder.create('paragraph')
  .apply(WrappedNode(TextType))
  .finish()

type ArrayNodeTypeName = {
  [T in TypeName]: NodeMap[T] extends ArrayNodeSpec ? T : never
}[TypeName]

function ArrayNode<
  T extends ArrayNodeTypeName,
  C extends NonRootNodeType<NodeMap[T]['childType']>,
>(childType: C) {
  return (([typeName, BaseFlatNode, BaseTreeNode]) => {
    class ArrayFlatNode extends BaseFlatNode {
      override toJsonValue(): JsonValue<T> {
        return this.value.map((childKey) =>
          this.create(childType, childKey).toJsonValue(),
        ) as JsonValue<T>
      }

      getChildren(
        this: this & Writable,
      ): (InstanceType<C['FlatNode']> & Writable)[]
      getChildren(): InstanceType<C['FlatNode']>[]
      getChildren() {
        return this.value.map((child) => this.create(childType, child))
      }
    }

    class ArrayTreeNode extends BaseTreeNode {
      override store(this: this & Writable, parentKey: Key): Key<T> {
        return this.transaction.insert(
          typeName,
          parentKey,
          (key) =>
            this.getChildren().map((child) => child.store(key)) as FlatValue<T>,
        )
      }

      getChildren(
        this: this & Writable,
      ): (InstanceType<C['TreeNode']> & Writable)[]
      getChildren(): InstanceType<C['TreeNode']>[]
      getChildren() {
        return this.jsonValue.map((child) => this.create(childType, child))
      }
    }

    return [ArrayFlatNode, ArrayTreeNode]
  }) satisfies Mixin<T, typeof NonRootFlatNode<T>, typeof NonRootTreeNode<T>>
}

const ContentType = NodeTypeBuilder.create('content')
  .apply(ArrayNode(ParagraphType))
  .finish()

export const RootType = NodeTypeBuilder.create('root')
  .apply(([_, BaseFlatNode, BaseTreeNode]) => {
    class RootFlatNode extends BaseFlatNode {
      get parentKey(): null {
        return null
      }

      override toJsonValue(): JsonValue<'root'> {
        const document = this.create(ContentType, this.value).toJsonValue()

        return { type: 'document', document }
      }
    }

    class RootTreeNode extends BaseTreeNode {
      store(this: this & Writable, rootKey: Key<'root'>): void {
        const child = this.create(ContentType, this.jsonValue.document)

        this.transaction.insertRoot(rootKey, child.store(rootKey))
      }
    }

    return [RootFlatNode, RootTreeNode]
  })
  .finish()

const initialValue: JsonValue<'root'> = {
  type: 'document',
  document: [{ type: 'paragraph', value: 'Hello, Rsbuild!' }],
}
const rootKey: Key<'root'> = 'root:0'

export default function App() {
  const { store } = useEditorStore()

  useEffect(() => {
    setTimeout(() => {
      if (store.has(rootKey)) return

      store.update((transaction) => {
        RootType.createTreeNode(initialValue)
          .toWritable(transaction)
          .store(rootKey)
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
            if (!store.has(rootKey)) return ''

            const jsonValue = RootType.createFlatNode(
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
