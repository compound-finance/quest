// # Quest
// *A scenario language called [Quest](https://observablehq.com/@jflatow/quest)*

// Note: Web3 and ethereum (injected MetaMask) are not currently compatible with Deno,
//  so make them explicit dependencies for now.
// Once we can import, these might be broken into different files.
export default function Quest({Web3, ethereum}) {

  // ## Env
  // The env stores constants and globals.
  // Things that do not depend on the [world](#World).
  // The network name is part of the env, but forked when a world is instantiated.

  function proxy(network, provider) {
    if (provider && provider != true) {
      if (typeof(provider) == 'string')
        return new Web3.providers.HttpProvider(`${provider}/${network}`)
      return provider;
    }
    return new Web3.providers.HttpProvider(`http://localhost:8546/${network}`)
  }

  async function GanacheEnv(opts = {}, host = 'localhost', port = '8545') {
    return new Env({...opts, networkOrProvider: new Web3(`http://${host}:${port}`)})
  }

  async function MetaMaskEnv(opts = {}) {
    return new Env({...opts, networkOrProvider: await MetaMaskProvider()})
  }

  async function MetaMaskProvider() {
    return new Promise((okay, fail) => {
      ethereum.sendAsync({method: 'eth_requestAccounts'}, error => error ? fail(error) : okay(ethereum))
    })
  }

  const DEFAULT_NETWORK = 'mainnet'

  class Env {
    constructor(opts = {}) {
      this.abi = new ABI(this)
      this.networkOrProvider = opts.networkOrProvider || DEFAULT_NETWORK;
      this.createAccounts = opts.createAccounts || 1;
      this.defaultFrom = opts.defaultFrom;
      this.defaultGas = opts.defaultGas;
      this.defaultGasPrice = opts.defaultGasPrice;
      this.defaultValue = opts.defaultValue;

      // serialized state
      this.accounts = {}    // address -> Account
      this.contracts = {}   // contract name -> Contract
      this.instances = {}   // instance name -> Instance
      this.typedefs = {}    // type name -> Typedef
      this.variables = {}   // var name -> any

      this.logDecoders = {} // address -> function
      this.createComplexTypes()
    }

    createComplexTypes() {
      const env = this;

      this.Enum = class Enum extends Function {
        constructor(type, defn) {
          super('...args', 'return this.__call__(...args)')
          if (!Array.isArray(defn))
            throw new Error(`expected array for enum '${type}' definition but got: ${str(defn)}`)
          if (defn.length < 1)
            throw new Error(`expected at least one member for enum '${type}'`)
          const self = Object.assign(this, {...invert(defn, Number), type, defn, meta: 'enum'})
          const bond = Object.assign(this.bind(this), self)
          return env.define(type, bond)
        }

        __call__(name) {
          const M = Math.max(Math.ceil(Math.log2(this.defn.length)), 8)
          switch (realType(name)) {
          case 'string':
            if (!isFinite(name)) {
              const i = this.defn.indexOf(name)
              if (i < 0)
                throw new Error(`enum '${this.type}' has no member '${name}'`)
              return Object.assign(i, {abiType: `uint${M}`})
            } // else fall through
          case 'bigint':
          case 'number':
            if (name < 0 || name >= this.defn.length)
              throw new Error(`enum '${this.type}' has no member '${name}'`)
            return Object.assign(name, {abiType: `uint${M}`})
          default:
            throw new Error(`enum '${this.type}' cannot have member '${name}'`)
          }
        }
      }

      this.Struct = class Struct extends Function {
        constructor(type, defn) {
          super('...args', 'return this.__call__(...args)')
          if (!isPojo(defn))
            throw new Error(`expected object for enum '${type}' definition but got: ${str(defn)}`)
          const self = Object.assign(this, {type, defn, meta: 'struct'})
          const bond = Object.assign(this.bind(this), self)
          return env.define(type, bond)
        }

        __call__(nameOrStruct) {
          const struct = mapobj(this.defn, v => env.abi.cast(0, v))
          switch (realType(nameOrStruct)) {
          case 'string':
            if (exists(nameOrStruct, this.variables))
              return this(this.variables[nameOrStruct])
            throw new Error(`struct '${nameOrStruct}' not defined in env`)
          case 'object':
            for (let field in nameOrStruct) {
              if (!exists(field, this.defn))
                throw new Error(`struct '${this.type}' has no field '${field}'`)
              struct[field] = env.abi.cast(nameOrStruct[field], this.defn[field])
            }
            return Object.defineProperty(struct, 'abiType', {get: () => this.type})
          case 'array':
            const fields = Object.keys(this.defn), N = fields.length;
            if (nameOrStruct.length != N)
              throw new Error(`struct '${this.type}' has ${N} fields, got ${nameOrStruct.length}`)
            for (let i = 0; i < N; i++)
              struct[fields[i]] = env.abi.cast(nameOrStruct[i], this.defn[fields[i]])
            return Object.defineProperty(struct, 'abiType', {get: () => this.type})
          default:
            if (nameOrStruct == 0) // special cases to return empty structs
              return Object.defineProperty(struct, 'abiType', {get: () => this.type})
            throw new Error(`could not cast ${str(nameOrStruct)} to struct '${this.type}'`)
          }
        }
      }
    }

    define(name, type) {
      return this.typedefs[name] = type;
    }

    async assign(data, force = false, kind = 'variables', overlay = false) {
      await this._assign(data, this[kind], force, kind, overlay)
      return this;
    }

    async _assign(data, into, force, kind = 'variables', overlay = false, path = []) {
      for (const [key, maybePromise] of Object.entries(data)) {
        const path_ = [kind, ...path.slice(1), key];
        const val = await maybePromise;
        if (overlay && isPojo(val)) {
          const dst = into[key] = exists(key, into) ? into[key] : {}
          if (isPojo(dst))
            await this._assign(val, dst, force, kind, overlay, path_)
          else
            throw new Error(`tried to overlay object ${crumbs(path_)} -> ${str(val)} without force`)
        } else if (overlay && Array.isArray(val)) {
          const dst = into[key] = exists(key, into) ? into[key] : []
          if (Array.isArray(dst))
            await this._assign(val, dst, force, kind, overlay, path_)
          else
            throw new Error(`tried to overlay array ${crumbs(path_)} -> ${str(val)} without force`)
        } else {
          if (exists(key, into) && !areEqual(val, into[key]) && !force)
            throw new Error(`tried to overwrite ${crumbs(path_)} -> ${str(val)} without force`)
          else if (val === undefined)
            delete into[key]
          else
            into[key] = val;
        }
      }
      return into;
    }

    val(key, kind = 'variables') {
      if (!exists(key, this[kind]))
        throw new Error(`missing key in ${kind}: '${key}' not defined in env`)
      return this[kind][key];
    }

    dumps() {
      // Write a standard JSON conf that can be reloaded
      return str({
        accounts: this.accounts,
        contracts: reject(this.contracts, k => k.startsWith('_')),
        instances: reject(this.instances, k => k.startsWith('_')),
        typedefs: mapobj(this.typedefs, t => ({type: t.type, defn: t.defn})),
        variables: this.variables
      })
    }

    async loads(str, force = false) {
      // Load (back) an unparsed standard JSON conf
      return this.load(JSON.parse(str), force)
    }

    async load(conf, force = false) {
      // Try various methods of loading the conf
      if (isPojo(conf))
        (await this.loadContractsJson(conf, force) ||
         await this.loadNetworksJson(conf, force) ||
         await this.loadStandardJson(conf, force))
      else
        throw new Error(`unsupported conf format: ${conf}`)
      return this;
    }

    async loadContractsJson(json, force) {
      if (json.contracts && json.version) {
        const contracts = {}
        for (let [key, val] of Object.entries(json.contracts)) {
          const [path, name] = key.split(':')
          if (!name || !val || !val.abi || !val.metadata)
            return false;
          const contract = contracts[name] = {
            name,
            abi: JSON.parse(val.abi),
            bin: val.bin,
            metadata: JSON.parse(val.metadata)
          }
          await this.indexLogs(name, contract.abi)
        }
        await this.assign(contracts, force, 'contracts', true)
        return true;
      }
    }

    async loadNetworksJson(json, force) {
      if (json.Blocks && json.Constructors && json.Contracts) {
        const instances = {}

        for (let [name, address] of Object.entries(json.Contracts))
          instances[name] = Object.assign(instances[name] || {}, {name, address})

        for (let [name, rawArgs] of Object.entries(json.Constructors))
          instances[name] = Object.assign(instances[name] || {}, {name, rawArgs})

        for (let [name, deployBlock] of Object.entries(json.Blocks))
          instances[name] = Object.assign(instances[name] || {}, {name, deployBlock})

        await this.assign(instances, force, 'instances', true)
        await this.assign(json.Contracts, force, 'variables')
        return true;
      }
    }

    async loadStandardJson(json, force) {
      for (let kind of ['accounts', 'contracts', 'instances', 'variables']) {
        if (json[kind])
          await this.assign(json[kind], force, kind)
      }
      if (json.typedefs)
        this.loadTypedefs(json.typedefs, force)
      return true;
    }

    async loadTypedefs(typedefs, force) {
      // TODO: when !force, check for overwriting typedefs?
      for (let {meta, type, defn} of Object.values(typedefs)) {
        switch (meta) {
        case 'enum': new (this.Enum)(type, defn); break;
        case 'struct': new (this.Struct)(type, defn); break;
        default:
          throw new Error(`unrecognized meta type '${meta}' for '${type}'`)
        }
      }
    }

    async read(url) {
      return this.load(await (await fetch(url)).json())
    }

    async fetchContractABI(contractNameOrAddress, network = DEFAULT_NETWORK, remember = true) {
      // Find the ABI if possible, and possibly remember it along the way
      if (isAddressLike(contractNameOrAddress)) {
        const address = contractNameOrAddress;
        const instance = Object.values(this.instances).find(i => i.address == address)
        if (instance && typeof instance.contractABI == 'object') // includes 'null'
          return instance.contractABI;
        let contractABI = null; // cached after the first fetch, no matter what
        try {
          contractABI = await etherscan.getABI(address, network)
        } catch (e) {}
        if (remember) {
          if (instance) {
            instance.contractABI = contractABI;
          } else {
            this.instances[address] = {name: address, address, contractABI}
          }
        }
        return contractABI;
      } else {
        const contractName = contractNameOrAddress;
        const contract = this.contracts[contractName]
        if (contract)
          return contract.abi;
      }
    }

    async decodeLogs(logs, network = DEFAULT_NETWORK) {
      const instanceAddrs = Object.values(this.instances).map(i => i.address)
      const contractNames = Object.keys(this.contracts)
      const fallbacks = instanceAddrs.concat(contractNames)
      const decoded = []
      for (let log of logs) // not parallelized on purpose to avoid DoSing ourselves
        decoded.push(await this.decodeLog(log, network, log.address, fallbacks))
      return decoded;
    }

    async decodeLog(log, network, contractNameOrAddress, fallbacks = []) {
      let contractDecoders = this.logDecoders[contractNameOrAddress]
      if (!contractDecoders) {
        const contractABI = await this.fetchContractABI(contractNameOrAddress, network)
        if (contractABI) {
          // index all the log decoders by the primary topic
          contractDecoders = await this.indexLogs(contractNameOrAddress, contractABI)
        } else if (fallbacks.length) {
          // no abi - move on
          return this.decodeLog(log, network, fallbacks[0], fallbacks.slice(1))
        } else {
          // no abi - nowehere else to look
          return {'$ABI_NOT_FOUND': log}
        }
      }

      // try to decode (using the primary topic)
      const decoder = contractDecoders[log.topics[0]]
      if (decoder) {
        return decoder(log)
      } else if (fallbacks.length) {
        return this.decodeLog(log, network, fallbacks[0], fallbacks.slice(1))
      } else {
        return {'$EVENT_NOT_FOUND': log}
      }
    }

    async indexLogs(contractNameOrAddress, contractABI) {
      return contractABI.filter(e => e.type == 'event').reduce((acc, event) => {
        if (event.anonymous) {
          console.warn(`not indexing anonymous event`, event)
        } else {
          const mainTopic = this.keccak(`${event.name}(${event.inputs.map(i => i.type).join(',')})`)
          acc[mainTopic] = this.abi.logDecoder(event)
        }
        return acc;
      }, this.logDecoders[contractNameOrAddress] = {})
    }

    keccak(string) {
      return (new Web3).utils.keccak256(string)
    }

    address(nameOrAddress) {
      // Find addr for name or address: string | throw
      switch (realType(nameOrAddress)) {
      case 'bigint':
      case 'number':
        return `0x${nameOrAddress.toString(16).padStart(40, '0')}`.toLowerCase()
      case 'string':
        if (isAddressLike(nameOrAddress))
          return nameOrAddress.toLowerCase()
        if (exists(nameOrAddress, this.accounts))
          return this.address(this.accounts[nameOrAddress].address)
        if (exists(nameOrAddress, this.instances))
          return this.address(this.instances[nameOrAddress].address)
        if (exists(nameOrAddress, this.variables))
          return this.address(this.variables[nameOrAddress])
      default:
        throw new Error(`address '${nameOrAddress}' not defined in env`)
      }
    }

    array(typeOrTypeName) {
      const typedArray = (arrayNameOrArray) => {
        // Find struct array with name or array of typeName: [<typeName>] | throw
        let typeName = typeOrTypeName;
        if (typeName instanceof Function)
          typeName = this.abi.resolve(typeName).type;
        switch (realType(arrayNameOrArray)) {
        case 'array':
          return Object.assign(arrayNameOrArray.slice(), {abiType: `${typeName}[]`})
        case 'bigint':
        case 'number':
          return Object.assign(Array(arrayNameOrArray), {abiType: `${typeName}[]`})
        case 'string':
        default:
          if (exists(arrayNameOrArray, this.variables))
            return typedArray(this.variables[arrayNameOrArray])
          throw new Error(`array ${arrayNameOrArray} not defined in env`)
        }
      }
      return typedArray;
    }

    bool(nameOrBoolean) {
      // Find bool for name or boolean: boolean | throw
      switch (realType(nameOrBoolean)) {
      case 'string':
        if (exists(nameOrBoolean, this.variables))
          return this.bool(this.variables[nameOrBoolean])
        throw new Error(`bool '${nameOrBoolean}' not defined in env`)
      default:
        return Object.assign(Boolean(nameOrBoolean), {abiType: 'bool'})
      }
    }

    bytes(data, M = '') {
      switch (realType(data)) {
      case 'bigint':
      case 'number':
        return this.bytes(`0x${data.toString(16)}`, M)
      case 'string':
        const b = (data.length - 2) / 2, B = 2 * M + 2;
        if (!data.startsWith('0x'))
          throw new Error(`bytes${M} '${data}' does not start with 0x`)
        else if (M && b > B)
          throw new Error(`bytes${M} '${data}' has ${b} > ${M} bytes`)
        return Object.assign(String(data.padEnd(B, '0')), {abiType: `bytes${M}`})
      default:
        throw new Error(`bytes${M} cannot convert from ${realType(data)} '${data}'`)
      }
    }

    string(data) {
      return Object.assign(data, {abiType: 'string'})
    }

    int(nameOrNumber, M = 256) {
      return Object.assign(this.uint(nameOrNumber), {abiType: `int${M}`})
    }

    uint(nameOrNumber, M = 256) {
      // Find uint for name or number: bigint | throw
      const tag = n => Object.assign(n, {abiType: `uint${M}`})
      switch (realType(nameOrNumber)) {
      case 'bigint': return tag(nameOrNumber)
      case 'number': return tag(BigInt(Math.floor(nameOrNumber)))
      case 'string':
        if (nameOrNumber.match(/^(0x[a-fA-F0-9]*|\d*)$/))
          return this.uint(BigInt(nameOrNumber), M)
        if (exists(nameOrNumber, this.variables))
          return this.uint(this.variables[nameOrNumber], M)
        throw new Error(`uint '${nameOrNumber}' not defined in env`)
      default:
        throw new Error(`uint '${nameOrNumber}' not recognized`)
      }
    }

    custom(typeName) {
      if (exists(typeName, this.typedefs))
        return this.typedefs[typeName];
      throw new Error(`custom type '${typeName}' not defined in env`)
    }

    bindings() {
      return {
        abi: this.abi,
        keccak: this.keccak,
        val: this.val.bind(this),
        address: this.address.bind(this),
        array: this.array.bind(this),
        bool: this.bool.bind(this),
        bytes: this.bytes.bind(this),
        string: this.string.bind(this),
        int: this.int.bind(this),
        uint: this.uint.bind(this),
        Enum: this.Enum,
        Struct: this.Struct,
        ...this.typedefs
      }
    }

    async library(lib, vars) {
      // Convenience to create a library with properly scoped bindings
      const bindings = this.bindings()
      return {...bindings, ...await lib(bindings, this, vars)}
    }
  }


  // ## World
  // The world executes commands and stores things related to the provider.
  // Its state is tied to the blockchain.
  // Linked to an [env](#Env).

  class World {
    constructor(env = new Env) {
      this.env = env;
      this.web3 = w3i(env.networkOrProvider)
      this.cache = {}
      this.history = [];
      this.createdAccounts = this.createAccounts(env.createAccounts)
      this.loadedAccounts = this.loadAccounts() // NB: async
      this.monkeyedWeb3 = this.monkeyWeb3() // NB: async
    }

    createAccounts(n, entropy) {
      // Create accounts locally, in the wallet (probably don't have ether)
      const accounts = this.web3.eth.accounts.wallet.create(n, entropy)
      const aliases = {}
      for (let i = 0; i < n; i++)
        aliases[`@${i}`] = select(accounts[i], ['address', 'privateKey'])
      this.env.assign(aliases, true, 'accounts')
      return accounts;
    }

    async loadAccounts() {
      // Load accounts remotely, on the node (hopefully have some ether)
      const accounts = await this.web3.eth.getAccounts()
      const aliases = {}
      for (let i = 0; i < accounts.length; i++)
        aliases[`$${i}`] = {address: accounts[i]}
      this.env.assign(aliases, true, 'accounts')
      return accounts;
    }

    async monkeyWeb3() {
      if (/ethereumjs/i.test(await this.web3.eth.getNodeInfo())) {
        this.ethereumjs = true;
        this.web3.eth.transactionConfirmationBlocks = 1;
        this.web3.eth.transactionBlockTimeout = 5;
      }
      return this.web3;
    }

    async network(readCache = true) {
      if (readCache && this.cache.network)
        return this.cache.network;

      const web3 = this.web3;
      const network = await web3.eth.net.getNetworkType(web3.currentProvider)
      return this.cache.network = (() => {
        switch (network) {
        case 'main':
          return 'mainnet'
        case 'private':
          const match = web3.currentProvider.host.match(/(\w*?)(-eth.compound.finance|\.infura\.io)/)
          if (match)
            return match[1]
        default:
          return network;
        }
      })();
    }

    async contractCode(addr) {
      const {address} = this.env.bindings()
      return this.rpc('eth_getCode', {params: [address(addr)]})
    }

    async lastBlock(readCache = true) {
      if (readCache && this.cache.lastBlock)
        return this.cache.lastBlock;
      return this.cache.lastBlock = await this.web3.eth.getBlock("latest")
    }

    async gasLimit(readCache = true) {
      const block = await this.lastBlock(readCache)
      return block ? block.gasLimit : 1e6;
    }

    async txOpts(given) {
      const opts = await resolve(given)
      const fallbackFrom = async () => {
        const nodeAccounts = await this.loadedAccounts;
        return nodeAccounts.length ? '$0' : '@0'
      }
      return {
        from: this.env.address(await unthunk(dfn(opts.from, this.env.defaultFrom, fallbackFrom))),
        gas: await unthunk(dfn(opts.gas, this.env.defaultGas, Math.floor(await this.gasLimit() * 0.9))),
        gasPrice: await unthunk(dfn(opts.gasPrice, this.env.defaultGasPrice, 0)),
        value: (await unthunk(dfn(opts.value, this.env.defaultValue, 0))).toString()
      }
    }

    async txReceipt(txHash) {
      return this.rpc('eth_getTransactionReceipt', {params: [txHash]})
    }

    async deploy(contractOrContractName, opts = {}, acc) {
      // Deploy a contract
      //  {args?, emits?, expect?, revert?, as?, force?, recycle?, ...txOpts?}

      // Just for logging
      const network = await this.network(), tag = `${network}${this.ethereumjs ? ' fork' : ''}`

      let contract;
      if (contractOrContractName.bin) {
        contract = contractOrContractName;
      } else if (!(contract = this.env.contracts[contractOrContractName])) {
        throw new Error(`contract not found: '${contractOrContractName}' has no bytecode available`)
      }

      if (opts.recycle && exists(opts.as, this.env.instances)) {
        const instance = this.env.instances[opts.as]
        const chainBin = await this.contractCode(opts.as)
        if (chainBin != '0x') {
          // TODO: should recycled deploys be in history? should we fetch logs, etc.?
          console.log(`[${tag}] Recyling deploy for '${contract.name}, found '${opts.as}'`, instance)
          return instance;
        }
      }

      const step = {deploy: contract.name, ...opts}
      const args = step.args = await unthunk(step.args || [], acc)
      const sendOptions = await this.txOpts(opts)
      const rawArgs = this.env.abi.encode(args)
      const data = `0x${contract.bin}${rawArgs.slice(2)}`
      const tx = Object.assign(sendOptions, {data})
      const deployed = this.web3.eth.sendTransaction(tx)
      const pending = new Promise((ok, err) => deployed.on('receipt', ok).on('error', err))
      const deployTx = await this.maybeRevert(pending, step)

      let result, logs;
      if (deployTx.matchedError) {
        console.log(`[${tag}] Successfully matched error on deploying '${contract.name}'`, deployTx)
        result = deployTx;
      } else {
        console.log(`[${tag}] Deployed '${contract.name}', awaiting receipt`, deployTx, args)
        const deployTxReceipt = await this.txReceipt(deployTx.transactionHash)
        console.log(`[${tag}] Received receipt for '${contract.name}'`, deployTxReceipt)
        result = {
          name: step.as,
          address: deployTxReceipt.contractAddress,
          rawArgs,
          deployBlock: deployTxReceipt.blockNumber,
          deployTx,
          deployTxReceipt,
          contractABI: contract.abi,
          contractBin: contract.bin,
          contractName: contract.name
        }
        logs = await this.maybeEmits(deployTxReceipt, opts)
      }

      await this.maybeExpect(result, opts)
      await this.maybeSaveInEnv(step.as, result, step.force, 'instances')
      this.history.push({...step, result, logs})
      return result;
    }

    async send(method, opts = {}, acc) {
      // Send a transaction
      //  {to, args?, emits?, expect?, revert?, assign?, force?, ...txOpts?}
      const step = {send: method, ...opts}
      const to = await assert(this.env.address(step.to), `must specify contract 'to' to send '${method}'`)
      const args = step.args = await unthunk(step.args || [], acc)
      const sendOptions = await this.txOpts(step)
      const data = this.env.abi.encodeFunctionCall(method, args)
      const tx = Object.assign(sendOptions, {to, data})
      const sent = this.web3.eth.sendTransaction(tx)
      const pending = new Promise((ok, err) => sent.on('receipt', ok).on('error', err))
      const result = await this.maybeRevert(pending, step)

      // Just for logging
      const network = await this.network(), tag = `${network}${this.ethereumjs ? ' fork' : ''}`
      console.log(`[${tag}] Sent '${method}' to '${step.to}'`, args, result)

      const logs = await this.maybeEmits(result, step)
      await this.maybeExpect(result, step)
      await this.maybeSaveInEnv(step.assign, result, step.force)
      this.history.push({...step, result, logs})
      return result;
    }

    async call(method, opts = {}, acc) {
      // Call a function without modifying the chain
      //  {on, args?, returns?, at?, expect?, revert?, assign?, force?, ...txOpts?}
      const step = {call: method, ...opts}
      const to = await assert(this.env.address(step.on), `must specify contract 'on' to call '${method}'`)
      const args = step.args = await unthunk(step.args || [], acc)
      const returns = step.returns ? (x => this.env.abi.decodeOne(x, step.returns)) : (x => x)
      const callOptions = await this.txOpts(opts)
      const data = this.env.abi.encodeFunctionCall(method, args)
      const tx = Object.assign(callOptions, {to, data})
      const block = await step.at;
      const pending = this.web3.eth.call(tx, block)
      const result = await returns(await this.maybeRevert(pending, step))
      await this.maybeExpect(result, opts)
      await this.maybeSaveInEnv(step.assign, result, step.force)
      this.history.push({...step, result})
      return result;
    }

    async rpc(method, opts = {}, acc) {
      // Make a jsonrpc to the provider
      //  {params?, returns?, expect?, assign?, force?}
      const step = {rpc: method, ...opts}
      const params = step.params = await unthunk(step.params || [], acc)
      const returns = step.returns || (x => x)
      const provider = this.web3.currentProvider
      const response = await promise(done => provider.send({method, params, jsonrpc: '2.0', id: 0}, done))
      if (response.error)
        throw new Error(`rpc error: ${response.error.message}`)
      const result = await returns(response.result)
      await this.maybeExpect(result, step)
      await this.maybeSaveInEnv(step.assign, result, step.force)
      this.history.push({...step, result})
      return result;
    }

    async eval(fn, opts = {}, acc) {
      // Just evaluate a fn, with the ability to save/expect
      //  {expect?, assign?, force?}
      const step = {eval: fn, ...opts}
      const result = fn(acc, step)
      await this.maybeExpect(result, step)
      await this.maybeSaveInEnv(step.assign, result, step.force)
      this.history.push({...step, result})
      return result;
    }

    async exec(steps, acc) {
      // Perform a sequence of instructions
      if (Array.isArray(steps)) {
        for (let step of steps)
          acc = await this.exec(step, acc);
        return acc;
      } else if (steps) {
        const step = steps;
        const ops = ['deploy', 'send', 'call', 'rpc', 'eval'], numOps = countKeys(step, ops)
        if (step instanceof Function) {
          return await step(this, acc)
        } else if (numOps == 0) {
          throw new Error(`bad instruction: ${str(step)} has none of ${str(ops)}`)
        } else if (numOps > 1) {
          throw new Error(`bad instruction: ${str(step)} has more than one of ${str(ops)}`)
        } else {
          try {
            if (step.deploy) return await this.deploy(step.deploy, step, acc)
            else if (step.send) return await this.send(step.send, step, acc)
            else if (step.call) return await this.call(step.call, step, acc)
            else if (step.rpc) return await this.rpc(step.rpc, step, acc)
            else if (step.eval) return await this.eval(step.eval, step, acc)
          } catch (e) {
            const summary = this.summarizeStep(step)
            console.error(`unexpected failure in ${summary}: ${e.message}`, e, step)
            throw e;
          }
        }
      } else {
        throw new Error(`bad instruction: exec cannot process step, got '${steps}'`)
      }
    }

    async fork(network, params) {
      // Another way of calling, just for convenience
      return fork(network, params, this)
    }

    async emits(sub, emits) {
      // Exec the sub then check that the logs produced match the emits spec
      const i = this.history.length;
      await this.exec(sub)
      const logs = this.history.slice(i).reduce((a, e) => a.concat(e.logs || []), [])
      return this.checkEmits(logs, emits)
    }

    async invariant(ac, b, d = 0) {
      // Assert an invariant holds before and after some events
      const prior = await this.exec(ac)
      await this.exec(b)
      const post = await this.exec(ac)
      if (d instanceof Function) {
        if (!d(prior, post))
          throw new Error(`invariant broken: (${str(prior)}, ${str(post)}) failed ${d}`)
      } else if (post - prior != d) {
        throw new Error(`invariant broken: ${str(post)} - ${str(prior)} == ${prior - post} != ${d}`)
      }
      return {prior, post}
    }

    async tail(contractNameOrAddress, topics = [], opts = {}) {
      // Get past logs for an address
      const network = await this.network()
      const address = this.env.address(contractNameOrAddress)
      let fromBlock, toBlock;
      if (opts.blocks != undefined) {
        const last = await this.lastBlock(false)
        fromBlock = last.number - opts.blocks;
        toBlock = last.number;
      } else {
        fromBlock = dfn(opts.fromBlock, 'earliest')
        toBlock = dfn(opts.toBlock, 'latest')
      }
      if (!Array.isArray(topics)) {
        const contractABI = await this.env.fetchContractABI(address, network)
        const eventTypes = (contractABI || []).reduce((acc, abi) => {
          if (abi.type == 'event') {
            const sig = `${abi.name}(${abi.inputs.map(i => i.type).join(',')})`;
            const tps = acc[abi.name] = acc[abi.name] || [];
            tps.push(this.env.keccak(sig))
          }
          return acc;
        }, {})
        topics = [eventTypes[topics]];
      }
      const logs = await this.web3.eth.getPastLogs({address, fromBlock, toBlock, topics})
      return this.env.decodeLogs(logs, network)
    }

    abiEqual(a, b) {
      return areEqual(this.env.abi.strip(a), this.env.abi.strip(b))
    }

    revertMessage(err) {
      return err.message.replace(/^Returned error: VM Exception while processing transaction: revert\s*/, '')
    }

    summarizeStep(step) {
      if (step.deploy) return `{deploy: '${step.deploy}' as: '${step.as}' args: ${str(step.args)}}`
      else if (step.send) return `{send: '${step.send}' to: '${step.to}' args: ${str(step.args)}}`
      else if (step.call) return `{call: '${step.call}' on: '${step.on}' args: ${str(step.args)}}`
      else if (step.rpc) return `{rpc: '${step.rpc}' params: ${str(step.params)}}`
      else if (step.eval) return `{eval: '${step.eval}'}`
      throw new Error(`not a step: ${str(step)}`)
    }

    async checkEmits(logs, emits, ctx) {
      if (emits instanceof Function) {
        if (await emits(logs, ctx) !== true)
          throw new Error(`unmet emission: ${str(logs)} failed ${emits}`)
      } else {
        const name = log => Object.keys(log)[0]
        let i, remaining = logs;
        for (const expected of [].concat(emits)) {
          if (typeof expected == 'string' && expected.startsWith('!')) { // check *all*, not just remaining
            const unwanted = logs.find(l => name(l) == expected.substr(1))
            if (unwanted)
              throw new Error(`unexpected log: ${str(expected)} but got ${str(unwanted)}`)
          } else {
            let found = false
            for (i = 0; i < remaining.length; i++) {
              const actual = remaining[i];
              if (typeof expected == 'string') {
                if (expected == name(actual)) {
                  found = true;
                  break;
                }
              } else {
                if (name(expected) == name(actual)) {
                  if (!this.abiEqual(expected, actual))
                    throw new Error(`bad log match: ${str(expected)} != ${str(actual)}`)
                  found = true;
                  break;
                }
              }
            }

            if (found) {
              remaining = remaining.slice(i + 1)
            } else {
              throw new Error(`unmatched log: ${str(expected)} not in ordered ${str(logs)}`)
            }
          }
        }
      }
      return logs;
    }

    async maybeRevert(pending, step) {
      // Revert can *only* match the exact revert message
      //  but expect can be used in conjunction!
      let result;
      try {
        result = await pending;
      } catch (error) {
        if (exists('revert', step)) {
          const revert = this.revertMessage(error)
          if (revert != step.revert) {
            throw new Error(`expected revert b/c "${step.revert}" but got "${revert}"`)
          }
          result = {step, matchedError: error}
        } else {
          throw new Error(`unexpected error "${error.message}"`)
        }
      }
      return result;
    }

    async maybeEmits(receipt, step) {
      // Emits can be a value or a function (*not* a thunk)
      //  same as expect, fns are require to return exactly 'true'
      const logs = await this.env.decodeLogs(receipt.logs || [], await this.network())
      if (exists('emits', step)) {
        const emits = await step.emits;
        await this.checkEmits(logs, emits, receipt)
      }
      return logs;
    }

    async maybeExpect(obj, step) {
      // Expect can be a value or a function (*not* a thunk)
      //  but fns required to return exactly 'true' to protect against thunking accidents
      if (exists('expect', step)) {
        const expect = await step.expect;
        if (expect instanceof Function) {
          if (await expect(obj) !== true) {
            throw new Error(`unmet expectation: ${str(obj)} failed ${expect}`)
          }
        } else if (!this.abiEqual(obj, expect)) {
          throw new Error(`unmet expectation: ${str(obj)} != ${str(expect)}`)
        }
      }
    }

    async maybeSaveInEnv(key, val, force, kind = 'variables') {
      if (key)
        await this.env.assign({[key]: val}, force, kind)
    }
  }


  // ## Common Libraries and Core Utilities

  // ### Env & World Helpers
  // Utilities for the [Env](#Env) and [World](#World) implementations.
  // These have no dependencies.

  class Maybe {
    constructor(just) {
      this.just = just;
    }
  }

  function maybe(x) {
    return new Maybe(x)
  }

  function all(X, pred = (x) => x) {
    return X.every(pred)
  }

  function dfn(value, fallback, ...rest) {
    if (value === undefined)
      return rest.length == 0 ? fallback : dfn(fallback, ...rest)
    return value;
  }

  function str(o) {
    return JSON.stringify(o, (k, v) => realType(v) === 'bigint' ? v.toString() : v)
  }

  function zip(A, B) {
    return A.map((a, i) => [a, B[i]])
  }

  function crumbs(p) {
    return `|${p.join('.')}|`
  }

  function exists(k, o) {
    return o.hasOwnProperty(k)
  }

  function isAddressLike(s) {
    return s.match(/0x[a-fA-F0-9]{40}/)
  }

  function isPojo(o) {
    return (o === null || typeof o !== 'object') ? false : Object.getPrototypeOf(o) === Object.prototype
  }

  function realType(o) {
    if (Array.isArray(o)) return 'array'
    if (o instanceof Function) return 'function'
    if (o instanceof Boolean) return 'boolean'
    if (o instanceof BigInt) return 'bigint'
    if (o instanceof Number) return 'number'
    if (o instanceof String) return 'string'
    return typeof o;
  }

  function areEqual(A, B) {
    if (Array.isArray(A))
      return Array.isArray(B) && A.length == B.length ? all(zip(A, B).map(([a, b]) => areEqual(a, b))) : false;

    if (typeof A == 'object') {
      if (!typeof B == 'object') return false;
      for (let k in A) if (!areEqual(A[k], B[k])) return false;
      for (let k in B) if (!areEqual(B[k], A[k])) return false;
      return true;
    }

    return A == B;
  }

  function countKeys(object, keys) {
    let count = 0;
    for (const key of keys)
      count += exists(key, object)
    return count;
  }

  function invert(object, fn = (x) => x) {
    const inverted = {}
    for (const key in object)
      inverted[object[key]] = fn(key)
    return inverted;
  }

  function filter(object, pred = () => true) {
    const view = {}
    for (const key in object)
      if (pred(key, object))
        view[key] = object[key];
    return view;
  }

  function reject(object, pred = () => false) {
    return filter(object, (...args) => !pred(...args))
  }

  function select(object, keys) {
    const view = {}
    for (const key of keys)
      if (exists(key, object))
        view[key] = object[key];
    return view;
  }

  function where(object, pred = (k, v) => v !== undefined) {
    const view = {}
    for (const [key, val] of Object.entries(object))
      if (pred(key, val))
        view[key] = val;
    return view;
  }

  function mapobj(object, fn = (v) => v) {
    const view = {}
    for (const [key, val] of Object.entries(object))
      view[key] = fn(val, key, object)
    return view;
  }

  async function promise(fn) {
    return new Promise((okay, fail) => fn((err, res) => err ? fail(err) : okay(res)))
  }

  async function resolve(object) {
    const copy = {}
    for (const key in object)
      copy[key] = await object[key];
    return copy;
  }

  async function unthunk(v, a, depth = 1) {
    if (Array.isArray(v) && depth > 0)
      return Promise.all(v.map(x => unthunk(x, a, depth - 1)))
    return v instanceof Function ? v(a) : v;
  }

  async function assert(test, reason = `failed assertion: ${test}`) {
    const pass = await unthunk(test)
    if (pass)
      return pass;
    throw new Error(reason)
  }

  function curry(fn, ...args) {
    return fn.bind(fn, ...args)
  }

  function pipe(v, f) {
    if (v instanceof Promise)
      return v.then(f)
    return f(v)
  }


  // ### ABI Encoding
  // Expose an interface for ABI encoding, the same as the Solidity one, where possible.

  class ABI {
    constructor(env) {
      this.env = env;
      this.coder = (new Web3).eth.abi;
    }

    decode(data, shape, strip = true) {
      // The shape passed in can refer to custom types
      //  use the resolved shape to decode, the unresolved one to cast
      if (shape instanceof Maybe)
        try { return this.decode(data, shape.just, strip) } catch (e) { return }
      const arr = (o) => Array(o.__length__).fill(0).map((_, i) => o[i])
      const raw = this.coder.decodeParameters(this.resolveTop(shape), data)
      const dec = this.cast(arr(raw), shape)
      return strip ? pipe(dec, v => this.strip(v)) : dec;
    }

    decodeOne(data, shape, strip = true) {
      if (shape instanceof Maybe)
        try { return this.decodeOne(data, shape.just, strip) } catch (e) { return }
      const raw = this.coder.decodeParameter(this.resolve(shape), data)
      const dec = this.cast(raw, shape)
      return strip ? pipe(dec, v => this.strip(v)) : dec;
    }

    encode(values) {
      // The shapes we generate are always in terms of primitives
      return this.coder.encodeParameters(this.resolveTop(this.shape(values)), this.strip(values))
    }

    encodeOne(value) {
      return this.coder.encodeParameter(this.resolve(this.shape(value)), this.strip(value))
    }

    encodePacked(value) {
      throw new Error(`TODO: implement encodePacked - does any other lib actually have it?`)
    }

    encodeConstructorArgs(contractABI, args) {
      const constructorABI = contractABI.find((x) => x.type === 'constructor')
      return constructorABI ? this.coder.encodeParameters(constructorABI.inputs, this.strip(args)) : '0x'
    }

    encodeFunctionCall(method, args) {
      return this.coder.encodeFunctionCall({name: method, inputs: this.resolveTop(this.shape(args).components)}, this.strip(args))
    }

    logDecoder(event) {
      return (log) => {
        const dec = this.coder.decodeLog(event.inputs, log.data, log.topics.slice(1))
        return {[event.name]: where(dec, k => !(isFinite(k) || k == '__length__'))}
      }
    }

    shape(value, name = null) {
      // Determine the type envelope of the value, for encoding
      //  does not fully resolve to primitive abi types

      // First check for an explict abiType
      if (value.abiType)
        return {type: value.abiType, name}

      // Then deal with Arrays, which are *tuples*, which are anonymous structs
      if (Array.isArray(value)) {
        return {type: 'tuple', components: value.map((v, i) => this.shape(v, i)), name}
      }

      // String('')-s like this are always bytes
      if (value instanceof String)
        return {type: 'bytes', name}

      // Finally try the primitive types we recognize
      switch (typeof value) {
      case 'boolean': return {type: 'bool', name}
      case 'bigint':
      case 'number':
        return {type: 'uint256', name}
      case 'string':
        // ''-strings which look like addrs are addrs
        //  otherwise let them be strings
        if (isAddressLike(value))
          return {type: 'address', name}
        return {type: 'string', name}
      }

      throw new Error(`indeterminate abi type for ${str(value)}`)
    }

    cast(data, shape) {
      // Cast the data according to the shape, for decoding
      //  data is assumed to already match the envelope
      if (Array.isArray(shape)) {
        return shape.map((s, i) => this.cast(data[i], s))
      } else if (shape instanceof Function) {
        return shape(data)
      } else if (typeof shape == 'string') {
        if (shape.match(/\[\d*\]$/)) {
          return this.cast(data, this.env.array(shape.slice(0, -2)))
        } else if (shape == 'address') {
          return this.env.address(data)
        } else if (shape == 'bool') {
          return this.env.bool(data)
        } else if (shape.startsWith('int')) {
          return this.env.int(data, shape.slice(3) || 256)
        } else if (shape.startsWith('uint')) {
          return this.env.uint(data, shape.slice(4) || 256)
        } else if (shape.startsWith('fixed')) {
          throw new Error(`TODO: implement fixed<M>x<N> (${shape})`)
        } else if (shape.startsWith('ufixed')) {
          throw new Error(`TODO: implement ufixed<M>x<N> (${shape})`)
        } else if (shape.startsWith('bytes')) {
          return this.env.bytes(data, shape.slice(5))
        } else if (shape == 'string') {
          return data;
        } else {
          const typedef = this.env.custom(shape)
          switch (typedef.meta) {
          case 'enum':
            return typedef(data)
          case 'struct':
          default:
            return typedef(mapobj(data, (v, k) => this.cast(v, shape[k])))
          }
        }
      } else if (shape.type) {
        if (shape.type == 'tuple') {
          return data.map((d, i) => this.cast(d, shape.components[i]))
        } else if (shape.type == 'tuple[]') {
          return data.map((d, i) => this.cast(d, {...shape, type: 'tuple'}))
        } else {
          return this.cast(data, shape.type)
        }
      } else if (typeof shape == 'object') {
        const components = Object.values(shape)
        if (isPojo(data)) {
          return this.cast(Object.keys(shape).map(k => data[k]), shape)
        } else if (Array.isArray(data)) {
          return data.map((d, i) => this.cast(d, components[i]))
        } else {
          return components.map(c => this.cast(data, c))
        }
      } else {
        console.error(`unrecognized shape`, shape, data)
        throw new Error(`unrecognized shape: ${shape}`)
      }
    }

    resolveTop(shape) {
      const resolved = this.resolve(shape)
      return resolved.components || resolved;
    }

    resolve(shape, name = null) {
      // Fully resolves the shape to an abi with primitive types
      if (Array.isArray(shape)) {
        return {type: 'tuple', components: shape.map((s, i) => this.resolve(s, i)), name}
      } else if (shape instanceof Function) {
        return this.resolve(this.shape(shape(0)), name || shape.name)
      } else if (shape instanceof Maybe) {
        return this.resolve(shape.just, name)
      } else if (typeof shape == 'string') {
        return this.resolveStr(shape, name)
      } else if (shape.type) {
        return this.resolveABI(shape, name || shape.name)
      } else {
        const fields = mapobj(shape, (v, k) => this.resolve(v, k))
        return {type: 'tuple', components: Object.values(fields), name}
      }
    }

    resolveABI(shape, name = shape.name) {
      // Resolve an ABI to its primitive types
      const typeInfo = this.typeInfo(shape.type)

      if (typeInfo.tuple)
        return {...shape, components: shape.components.map(c => this.resolveABI(c)), name}

      if (typeInfo.custom) {
        // custom types get all their information from just the type name
        return this.resolveStr(shape.type, shape.name)
      }

      return {...shape, name}
    }

    resolveStr(shape, name) {
      // Resolve a 'string' shape to an ABI with primitive types
      const typeInfo = this.typeInfo(shape)

      if (typeInfo.tuple)
        throw new Error(`missing components for 'tuple': supply the abi or use a custom type`)

      if (typeInfo.array) {
        if (typeInfo.basic) {
          return {type: shape, name}
        } else if (typeInfo.custom) {
          const typedef = this.env.custom(typeInfo.custom.baseType)
          switch (typedef.meta) {
          case 'enum':
            return {type: `${typedef(0).abiType}[]`, name}
          case 'struct':
          default:
            const fields = mapobj(typedef.defn, (v, k) => this.resolve(v, k))
            return {type: 'tuple[]', components: Object.values(fields), name}
          }
        } else {
          throw new Error(`unrecognized shape '${shape}' with type info: ${str(typeInfo)}`)
        }
      }

      if (typeInfo.basic)
        return {type: shape, name}

      if (typeInfo.custom) {
        const typedef = this.env.custom(typeInfo.custom.baseType)
        switch (typedef.meta) {
        case 'enum':
          return {type: typedef(0).abiType, name}
        case 'struct':
          const fields = mapobj(typedef.defn, (v, k) => this.resolve(v, k))
          return {type: 'tuple', components: Object.values(fields), name}
        }
      }

      throw new Error(`unrecognized shape '${shape}' (should not be possible)`)
    }

    typeInfo(str) {
      // abi types:
      //  array: *[]
      //  basic: address* | bool* | int* | uint* | fixed* | ufixed* | bytes* | string*
      //  tuple: tuple | tuple[]
      //  custom: !basic && !tuple
      //  primitive: !custom (i.e. basic || tuple)
      // basic, tuple, and custom types MAY also be arrays
      const patterns = {
        array: /^(?<baseType>.*)\[\]$/,
        basic: /^(?<baseType>address|bool|int|uint|fixed|ufixed|bytes|string).*$/,
        tuple: /^(?<baseType>tuple).*$/,
        custom: /^(?<baseType>.*?)(\[\])?$/
      }
      const groups = mapobj(mapobj(patterns, p => str.match(p)), m => m && m.groups)
      return {...groups, custom: !groups.basic && !groups.tuple && groups.custom}
    }

    strip(value) {
      // Strip away any boxing we did to preserve the abi type
      if (Array.isArray(value))
        return value.map(v => this.strip(v))
      if (value instanceof Boolean)
        return Boolean(value.valueOf())
      if (value instanceof BigInt)
        return BigInt(value.valueOf())
      if (value instanceof Number)
        return Number(value.valueOf())
      if (value instanceof String)
        return String(value.valueOf())
      if (typeof value == 'object')
        return mapobj(value, v => this.strip(v))
      return value;
    }
  }


  // ### Etherscan
  // Convenient primitives for fetching authoritative metadata from [Etherscan](https://etherscan.io).

  const DEFAULT_ETHERSCAN_API_KEY = 'K6KM4HKJ5DDH3FSUU9KYAPJWGFV4H1UAGY'

  const etherscan = ({
    link: (network, address) => {
      const host = network == 'mainnet' ? 'etherscan.io' : `${network}.etherscan.io`
      return `https://${host}/address/${address}`
    },

    endpoint: (network) => {
      const subdomain = network == 'mainnet' ? 'api' : `api-${network}`
      return `https://${subdomain}.etherscan.io/api`
    },

    getABI: async function (address, network = DEFAULT_NETWORK, api_key = DEFAULT_ETHERSCAN_API_KEY) {
      const json = await (await fetch(`${this.endpoint(network)}?module=contract&action=getabi&address=${address}&apikey=${api_key}`)).json()
      if (json.status == 0)
        throw new Error(json.result)
      return JSON.parse(json.result)
    },

    getSource: async function (address, network = DEFAULT_NETWORK, api_key = DEFAULT_ETHERSCAN_API_KEY) {
      const json = await (await fetch(`${this.endpoint(network)}?module=contract&action=getsourcecode&address=${address}&apikey=${api_key}`)).json()
      return json.result;
    }
  })


  // ### Web3
  // Expose a very limited set of globals for constructing web3 handles.

  function w3i(networkOrProvider) {
    if (typeof networkOrProvider == 'string' && networkOrProvider.match(/^\w+$/))
      return new Web3(new Web3.providers.HttpProvider(`https://${networkOrProvider}-eth.compound.finance`))
    return new Web3(networkOrProvider)
  }

  // ### Exponentials and Numbers
  // Syntactic sugar for creating exponentials and reading numbers from wherever.

  // Use [exp](#exp) to scale up and create exponentials (think *encoding*).
  // Use [num](#num) to scale down and normalize numbers (think *decoding*).

  function exp(fraction, digits = 18, capture = 6) {
    // Convert a fraction to an exponential, e.g. [fraction]e[digits]
    //  `fraction` keeps `capture` decimals before upscaling
    //   large numbers can get chopped if too large
    return BigInt(Math.floor(fraction * 10**capture)) * 10n**BigInt(digits - capture)
  }

  const num = Object.assign(
    function num(numOrPromise, decimals = 1) {
      return pipe(numOrPromise, n => n / 10**decimals)
    }, {
      wei: n => num(n, 18),
      hex: n => pipe(n, BigInt)
    }
  )

  // ### URLs
  // Conveniently generate common URLs.

  // #### GitHub

  const DEFAULT_GITHUB_REPO = 'compound-finance/compound-protocol'
  const DEFAULT_GITHUB_PATH = `networks/${DEFAULT_NETWORK}.json`
  const DEFAULT_GITHUB_BRANCH = 'master'

  function github(path = DEFAULT_GITHUB_PATH, repo = DEFAULT_GITHUB_REPO, branch = DEFAULT_GITHUB_BRANCH) {
    return `https://raw.githubusercontent.com/${repo}/${branch}/${path}`
  }


  // ## Standard Patch Library

  // ### Blocks and Time
  // Common patches for manipulating blocks and time in the EVM.

  function EVMLib({uint}) {
    const N = x => Number(uint(x))
    return {
      $blockNumber: () => ({rpc: 'eth_blockNumber', returns: Number}),
      $mineBlock: () => ({rpc: 'evm_mine'}),
      $mineBlockNumber: (blockNumber) => ({rpc: 'evm_mineBlockNumber', params: [N(blockNumber)]}),
      $minerStart: () => ({rpc: 'miner_start'}),
      $minerStop: () => ({rpc: 'miner_stop'}),
      $setTime: (date) => ({rpc: 'evm_setTime', params: [date]}), // note: ganache code looks broken
      $increaseTime: (seconds) => ({rpc: 'evm_increaseTime', params: [N(seconds)]}),
      $freezeTime: (seconds) => ({rpc: 'evm_freezeTime', params: [N(seconds)]}),
      $unfreezeTime: (seconds) => ({rpc: 'evm_unfreezeTime', params: [N(seconds)]}),

      $$advanceBlocks: (blocks) => [
        {rpc: 'eth_blockNumber'},
        {rpc: 'evm_mineBlockNumber', params: B => [Number(B) + N(blocks) - 1]}
      ]
    }
  }

  // ### Standard Tokens
  // EIP-20 interface patches.

  function ERC20Lib({address}) {
    return {
      $name: (token) => ({call: 'name', on: token, returns: 'string'}),
      $symbol: (token) => ({call: 'symbol', on: token, returns: 'string'}),
      $decimals: (token) => ({call: 'decimals', on: token, returns: Number}),
      $totalSupply: (token) => ({call: 'totalSupply', on: token, returns: BigInt}),
      $balanceOf: (token, owner) => ({call: 'balanceOf', on: token, args: [address(owner)], returns: BigInt}),
      $transfer: (token, to, value) => ({send: 'transfer', to: token, args: [address(to), value]}),
      $transferFrom: (token, from, to, value) => ({send: 'transferFrom', to: token, args: [address(from), address(to), value]}),
      $approve: (token, spender, amount) => ({send: 'approve', to: token, args: [address(spender), amount]}),
      $allowance: (token, owner, spender) => ({call: 'allowance', on: token, args: [address(owner), address(spender)], returns: BigInt})
    }
  }

  // ### State Forking
  // Seeding state from public networks.

  async function fork(networkOrProvider, params, world) {
    const {blockNumber, useProxy, unlocked_accounts, ...rest} = params || {};
    const base = w3i(useProxy ? proxy(networkOrProvider, useProxy) : networkOrProvider)
    const baseLastBlock = await base.eth.getBlock("latest")
    const options = await world.rpc('evm_reset', {params: [
      {
        allowUnlimitedContractSize: true,
        fork: base.currentProvider.host + (blockNumber ? `@${blockNumber}` : ''),
        gasLimit: await baseLastBlock.gasLimit, // maintain configured gas limit
        gasPrice: '20000',
        unlocked_accounts: (unlocked_accounts || []).map(a => world.env.address(a)),
        ...rest
      }
    ]})
    const accounts = await world.loadAccounts()
    return {accounts, options}
  }

  return {
    Env,
    World,

    proxy,
    GanacheEnv,
    MetaMaskEnv,
    MetaMaskProvider,

    Maybe,
    maybe,
    all,
    dfn,
    str,
    zip,
    crumbs,
    exists,
    isAddressLike,
    isPojo,
    realType,
    areEqual,
    countKeys,
    invert,
    filter,
    reject,
    select,
    where,
    mapobj,
    promise,
    resolve,
    unthunk,
    assert,
    curry,
    pipe,

    ABI,
    etherscan,
    github,

    w3i,
    exp,
    num,

    EVMLib,
    ERC20Lib,
    fork
  }
}
