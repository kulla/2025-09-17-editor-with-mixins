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

interface WrappedNodeSpec<
  T extends TypeName,
  C extends { typeName: TypeName } = { typeName: TypeName },
> {
  flatValue: Key<C['typeName']>
  jsonValue: { type: T; value: JsonValue<C['typeName']> }
  childType: C
}

interface NodeMap {
  text: {
    flatValue: Y.Text
    jsonValue: string
  }
  root: WrappedNodeSpec<'root', typeof TextType>
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

abstract class FlatNode<T extends TypeName> extends Stateful {
  constructor(
    protected store: EditorStore,
    public key: Key<T>,
  ) {
    super()

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

abstract class TreeNode<T extends TypeName> extends Stateful {
  constructor(public readonly jsonValue: JsonValue<T>) {
    super()
  }

  abstract store(this: this & Writable, parentKey: Key | null): Key<T>
}

type Mixin<
  T extends TypeName,
  F extends typeof FlatNode<T> = typeof FlatNode<T>,
  F2 extends typeof FlatNode<T> = typeof FlatNode<T>,
  W extends typeof TreeNode<T> = typeof TreeNode<T>,
  W2 extends typeof TreeNode<T> = typeof TreeNode<T>,
> = (arg: [T, F, W]) => [F2, W2]

class NodeTypeBuilder<
  T extends TypeName,
  F extends typeof FlatNode<T>,
  W extends typeof TreeNode<T>,
> {
  constructor(
    public readonly typeName: T,
    public readonly FlatNode: F,
    public readonly TreeNode: W,
  ) {}

  apply<F2 extends typeof FlatNode<T>, W2 extends typeof TreeNode<T>>(
    mixin: Mixin<T, F, F2, W, W2>,
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

  static create<T extends TypeName>(typeName: T) {
    return new NodeTypeBuilder(typeName, FlatNode<T>, TreeNode<T>)
  }
}

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
  .apply(([_, BaseFlatNode, BaseTreeNode]) => {
    class NonRootFlatNode extends BaseFlatNode {
      override get parentKey(): Key {
        const parentKey = this.store.getParentKey(this.key)

        invariant(parentKey != null, `Parent key for ${this.key} is null`)

        return parentKey
      }
    }

    class NonRootTreeNode extends BaseTreeNode {
      override store(this: this & Writable, parentKey: Key) {
        return super.store(parentKey)
      }
    }

    return [NonRootFlatNode, NonRootTreeNode]
  })
  .finish()

type WrappedNodeTypeName = {
  [T in TypeName]: NodeMap[T] extends WrappedNodeSpec<T> ? T : never
}[TypeName]

function WrappedNode<
  T extends WrappedNodeTypeName,
  C extends NodeMap[T]['childType'],
>(childType: C) {
  return (([typeName, BaseFlatNode, BaseTreeNode]: [
    T,
    typeof FlatNode<T>,
    typeof TreeNode<T>,
  ]) => {
    class WrappedFlatNode extends BaseFlatNode {
      override toJsonValue(): JsonValue<T> {
        return { type: typeName, value: this.getChild().toJsonValue() }
      }

      getChild(this: this & Writable): InstanceType<C['FlatNode']> & Writable
      getChild(): InstanceType<C['FlatNode']>
      getChild() {
        return childType
          .createFlatNode(this.store, this.value)
          .copyStateFrom(this)
      }
    }

    class WrappedTreeNode extends BaseTreeNode {
      override store(this: this & Writable, parentKey: Key | null): Key<T> {
        return this.transaction.insert(typeName, parentKey, (key) =>
          this.getChild().store(key),
        )
      }

      getChild(this: this & Writable): InstanceType<C['TreeNode']> & Writable
      getChild(): InstanceType<C['TreeNode']>
      getChild() {
        return childType
          .createTreeNode(this.jsonValue.value)
          .copyStateFrom(this)
      }
    }

    return [WrappedFlatNode, WrappedTreeNode]
  }) satisfies Mixin<T>
}

export const RootType = NodeTypeBuilder.create('root')
  .apply(WrappedNode(TextType))
  .apply(([_, BaseFlatNode, BaseTreeNode]) => {
    class RootFlatNode extends BaseFlatNode {
      override get parentKey(): null {
        return null
      }
    }

    class RootTreeNode extends BaseTreeNode {
      override store(this: this & Writable): Key<'root'> {
        return super.store(null)
      }
    }

    return [RootFlatNode, RootTreeNode]
  })
  .finish()
