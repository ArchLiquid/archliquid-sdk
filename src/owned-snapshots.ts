import {
  address, getAddressDecoder, getBase64Decoder, getBase64Encoder,
  type Address, type Commitment, type GetGenesisHashApi, type GetMultipleAccountsApi,
  type ReadonlyUint8Array, type Rpc, type Slot,
} from "@solana/kit";
import { ARCH_CURVE_PROGRAM_ADDRESS, SOL_QUOTE_MINT_ADDRESS, USDC_QUOTE_MINT_ADDRESS } from "./addresses.js";
import { ARCHLIQUID_DEVNET_DEPLOYMENT, assertOwnedDeploymentGenesisHash } from "./deployment.js";
import { OwnedSdkError } from "./errors.js";
import {
  decodeCurveAccount, decodeLaunchConfigAccount, decodePoolAccount,
  decodeProtocolConfigAccount, decodeSwapConfigAccount, assertLaunchConfigActive, OWNED_ACCOUNT_LAYOUTS,
  type DecodedCurve, type DecodedLaunchConfig, type DecodedPool,
  type DecodedProtocolConfig, type DecodedSwapConfig,
} from "./owned-program-accounts.js";
import {
  assertCurveVaultAccounting, assertFixedSupplyLaunchMint, assertPermanentlyFixedLegacyMint,
  assertPoolLpMintAccounting, assertPoolVaultAccounting, decodeLegacyMint, decodeLegacyTokenAccount,
  type DecodedLegacyMint, type DecodedLegacyTokenAccount,
} from "./legacy-token-accounts.js";
import {
  deriveAssociatedTokenAddress, deriveCurveAddress, derivePoolAddress,
  derivePoolLpMintAddress, deriveProtocolConfigAddress, deriveSwapConfigAddress,
} from "./owned-program-pdas.js";

const MAX_U64 = (1n << 64n) - 1n;
const MAX_ACCOUNT_BYTES = 4_096;
const addressDecoder = getAddressDecoder();
const base64 = getBase64Encoder();
const base64String = getBase64Decoder();
const validatedSnapshots = new WeakSet<object>();

export type OwnedObservedAccount = Readonly<{
  address: string; owner: string; data: ReadonlyUint8Array; lamports: bigint; executable?: boolean;
}>;
export type OwnedAccountReadOptions = Readonly<{
  commitment: Commitment; minContextSlot?: Slot; abortSignal: AbortSignal;
}>;
/** Inject a trusted reader. Its responses still receive all SDK identity/accounting checks. */
export interface OwnedAccountReader {
  getGenesisHash(options: Readonly<{ abortSignal: AbortSignal }>): Promise<string>;
  getAccounts(addresses: readonly Address[], options: OwnedAccountReadOptions): Promise<Readonly<{
    slot: Slot; accounts: readonly (OwnedObservedAccount | null)[];
  }>>;
}
export type OwnedSnapshotOptions = Readonly<{
  commitment?: Commitment; minContextSlot?: Slot; abortSignal?: AbortSignal;
  timeoutMs?: number; retries?: number; retryDelayMs?: number;
}>;
type SnapshotContext = Readonly<{
  slot: Slot; observedAtUnixMs: number; commitment: Commitment;
  deployment: typeof ARCHLIQUID_DEVNET_DEPLOYMENT;
}>;
export type OwnedCurveSnapshot = SnapshotContext & Readonly<{
  venue: "curve"; curve: DecodedCurve; launchConfig: DecodedLaunchConfig; protocol: DecodedProtocolConfig;
  baseMint: DecodedLegacyMint; quoteMint: DecodedLegacyMint;
  baseVault: DecodedLegacyTokenAccount; quoteVault: DecodedLegacyTokenAccount;
}>;
export type OwnedPoolSnapshot = SnapshotContext & Readonly<{
  venue: "pool"; pool: DecodedPool; swapConfig: DecodedSwapConfig;
  baseMint: DecodedLegacyMint; quoteMint: DecodedLegacyMint; lpMint: DecodedLegacyMint;
  baseVault: DecodedLegacyTokenAccount; quoteVault: DecodedLegacyTokenAccount;
}>;
export type OwnedLaunchSnapshot = SnapshotContext & Readonly<{
  purpose: "launch"; protocol: DecodedProtocolConfig; launchConfig: DecodedLaunchConfig;
  quoteMint: DecodedLegacyMint;
}>;
export type OwnedSnapshot = OwnedCurveSnapshot | OwnedPoolSnapshot | OwnedLaunchSnapshot;

/** Adapt Solana Kit's getMultipleAccounts/base64 response to the injectable reader interface. */
export function createOwnedAccountReader(rpc: Rpc<GetGenesisHashApi & GetMultipleAccountsApi>): OwnedAccountReader {
  return Object.freeze({
    async getGenesisHash({ abortSignal }: Readonly<{ abortSignal: AbortSignal }>) {
      return rpc.getGenesisHash().send({ abortSignal });
    },
    async getAccounts(addresses: readonly Address[], options: OwnedAccountReadOptions) {
      const result = await rpc.getMultipleAccounts(addresses, {
        encoding: "base64", commitment: options.commitment,
        ...(options.minContextSlot === undefined ? {} : { minContextSlot: options.minContextSlot }),
      }).send({ abortSignal: options.abortSignal });
      if (!result || !result.context || !Array.isArray(result.value) || result.value.length !== addresses.length) {
        throw new OwnedSdkError("invalid_snapshot", "RPC returned an invalid account response envelope");
      }
      return {
        slot: result.context.slot,
        accounts: result.value.map((account, index) => {
          if (!account) return null;
          if (!Array.isArray(account.data) || account.data.length !== 2 || account.data[1] !== "base64" ||
              typeof account.data[0] !== "string" || account.data[0].length > Math.ceil(MAX_ACCOUNT_BYTES / 3) * 4 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(account.data[0])) {
            throw new OwnedSdkError("invalid_snapshot", "RPC account encoding or size is unsupported");
          }
          const data = base64.encode(account.data[0]);
          if (data.length > MAX_ACCOUNT_BYTES || base64String.decode(data) !== account.data[0]) {
            throw new OwnedSdkError("invalid_snapshot", "RPC account base64 data is noncanonical or too large");
          }
          return {
            address: addresses[index]!, owner: account.owner, lamports: account.lamports,
            executable: account.executable, data,
          };
        }),
      };
    },
  });
}

function checkedSlot(value: Slot, fromResponse = false): void {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    throw new OwnedSdkError(fromResponse ? "invalid_snapshot" : "invalid_input", "Snapshot slot must be an unsigned u64 bigint");
  }
}

function captureSnapshotOptions(options: OwnedSnapshotOptions): OwnedSnapshotOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new OwnedSdkError("invalid_input", "Snapshot options must be an object");
  }
  try {
    // Read each field once. The caller may reuse or mutate its options while an
    // RPC promise is pending; that must not alter validated context or cleanup.
    const { commitment, minContextSlot, abortSignal, timeoutMs, retries, retryDelayMs } = options;
    if (abortSignal !== undefined && (!abortSignal || typeof abortSignal !== "object" ||
        typeof abortSignal.aborted !== "boolean" || typeof abortSignal.addEventListener !== "function" ||
        typeof abortSignal.removeEventListener !== "function")) {
      throw new OwnedSdkError("invalid_input", "Snapshot abortSignal is invalid");
    }
    return Object.freeze({
      ...(commitment === undefined ? {} : { commitment }),
      ...(minContextSlot === undefined ? {} : { minContextSlot }),
      ...(abortSignal === undefined ? {} : { abortSignal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(retries === undefined ? {} : { retries }),
      ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    });
  } catch (cause) {
    if (cause instanceof OwnedSdkError) throw cause;
    throw new OwnedSdkError("invalid_input", "Snapshot options could not be read", { cause });
  }
}

async function withReads<T>(options: OwnedSnapshotOptions, operation: (
  read: <R>(request: (signal: AbortSignal) => Promise<R>) => Promise<R>, signal: AbortSignal,
) => Promise<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 0;
  const retryDelayMs = options.retryDelayMs ?? 100;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000 ||
      !Number.isInteger(retries) || retries < 0 || retries > 3 ||
      !Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5_000) {
    throw new OwnedSdkError("invalid_input", "Snapshot timeout/retry options are outside their bounded ranges");
  }
  if (options.minContextSlot !== undefined) checkedSlot(options.minContextSlot);
  if (options.commitment !== undefined && !["processed", "confirmed", "finalized"].includes(options.commitment)) {
    throw new OwnedSdkError("invalid_input", "Snapshot commitment is invalid");
  }
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(options.abortSignal?.reason);
  if (options.abortSignal?.aborted) abort();
  options.abortSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abortError = () => new OwnedSdkError(timedOut ? "timeout" : "aborted", timedOut ? "Snapshot read timed out" : "Snapshot read was aborted");
  const read = async <R>(request: (signal: AbortSignal) => Promise<R>): Promise<R> => {
    for (let attempt = 0; ; attempt++) {
      if (controller.signal.aborted) throw abortError();
      try {
        return await new Promise<R>((resolve, reject) => {
          const onAbort = () => reject(abortError());
          controller.signal.addEventListener("abort", onAbort, { once: true });
          Promise.resolve().then(() => request(controller.signal)).then(resolve, reject).finally(() => {
            controller.signal.removeEventListener("abort", onAbort);
          });
        });
      } catch (cause) {
        if (controller.signal.aborted) throw abortError();
        if (cause instanceof OwnedSdkError) throw cause;
        if (attempt >= retries) throw new OwnedSdkError("rpc_error", "RPC account read failed", { cause });
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(delay); reject(abortError()); };
          const delay = setTimeout(() => { controller.signal.removeEventListener("abort", onAbort); resolve(); }, retryDelayMs * (attempt + 1));
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  };
  try {
    const result = await operation(read, controller.signal);
    if (controller.signal.aborted) throw abortError();
    return result;
  }
  finally { clearTimeout(timer); options.abortSignal?.removeEventListener("abort", abort); }
}

function validateRead(
  requested: readonly Address[], response: Awaited<ReturnType<OwnedAccountReader["getAccounts"]>>, minimum?: Slot,
): Readonly<{ slot: Slot; accounts: OwnedObservedAccount[] }> {
  if (!response || typeof response !== "object") {
    throw new OwnedSdkError("invalid_snapshot", "RPC returned an invalid account response envelope");
  }
  const { slot, accounts } = response;
  checkedSlot(slot, true);
  if (minimum !== undefined && slot < minimum) throw new OwnedSdkError("stale_context", "RPC returned a context older than requested");
  if (!Array.isArray(accounts) || accounts.length !== requested.length) {
    throw new OwnedSdkError("invalid_snapshot", "RPC returned an unexpected account count");
  }
  const validated = requested.map((expectedAddress, index) => {
    const account = accounts[index];
    if (!account) throw new OwnedSdkError("missing_account", "A required SDK account does not exist", { context: { address: requested[index] } });
    // Capture scalar fields and binary data before asynchronous account decoding.
    const { address: accountAddress, owner, data, lamports, executable } = account;
    if (accountAddress !== expectedAddress || !(data instanceof Uint8Array) ||
        data.length > MAX_ACCOUNT_BYTES || typeof lamports !== "bigint" ||
        lamports < 0n || lamports > MAX_U64 || typeof owner !== "string" ||
        (executable !== undefined && executable !== false)) {
      throw new OwnedSdkError("invalid_snapshot", "RPC account identity, data or lamports are invalid");
    }
    try { address(owner); }
    catch (cause) {
      throw new OwnedSdkError("invalid_snapshot", "RPC account owner address is invalid", { cause });
    }
    return { address: accountAddress, owner, lamports, data: new Uint8Array(data),
      ...(executable === undefined ? {} : { executable }) };
  });
  return Object.freeze({ slot, accounts: validated });
}

function freezeSnapshot<T extends OwnedSnapshot>(snapshot: T): T {
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object" && !(value instanceof Uint8Array) && !Object.isFrozen(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (child instanceof Uint8Array) {
          // Typed arrays cannot be frozen; a getter prevents mutation of stored validated bytes.
          const bytes = new Uint8Array(child);
          Object.defineProperty(value, key, {
            enumerable: true, configurable: false, get: () => new Uint8Array(bytes),
          });
        } else freeze(child);
      }
      Object.freeze(value);
    }
  };
  freeze(snapshot);
  validatedSnapshots.add(snapshot);
  return snapshot;
}

/** Validate provenance for a plan: snapshots must have completed one of the SDK loaders. */
export function assertOwnedSnapshot(snapshot: OwnedSnapshot): void {
  if (!snapshot || !validatedSnapshots.has(snapshot)) {
    throw new OwnedSdkError("invalid_snapshot", "Transaction plans require an SDK-loaded validated snapshot");
  }
}

function quoteMintAddress(value: Address, fromResponse = false): void {
  if (value !== SOL_QUOTE_MINT_ADDRESS && value !== USDC_QUOTE_MINT_ADDRESS) {
    throw new OwnedSdkError(fromResponse ? "invalid_snapshot" : "invalid_input", "Quote mint is not supported by this deployment");
  }
}

function validateQuoteMint(mint: DecodedLegacyMint): void {
  quoteMintAddress(mint.address, true);
  const expectedDecimals = mint.address === SOL_QUOTE_MINT_ADDRESS ? 9 : 6;
  if (mint.decimals !== expectedDecimals) {
    throw new OwnedSdkError("invalid_snapshot", "Quote mint decimals do not match the supported deployment");
  }
}

/** Load the currently enabled launch configuration and quote mint without creating or sending a transaction. */
export async function loadLaunchSnapshot(reader: OwnedAccountReader, quoteMintValue: string, options: OwnedSnapshotOptions = {}): Promise<OwnedLaunchSnapshot> {
  options = captureSnapshotOptions(options);
  const quoteAddress = address(quoteMintValue);
  quoteMintAddress(quoteAddress);
  return withReads(options, async (read, signal) => {
    assertOwnedDeploymentGenesisHash(await read((abortSignal) => reader.getGenesisHash({ abortSignal })));
    const protocolAddress = (await deriveProtocolConfigAddress()).address;
    const commitment = options.commitment ?? "confirmed";
    const discoveryResponse = await read((abortSignal) => reader.getAccounts([protocolAddress], { commitment, abortSignal,
      ...(options.minContextSlot === undefined ? {} : { minContextSlot: options.minContextSlot }) }));
    const discovery = validateRead([protocolAddress], discoveryResponse, options.minContextSlot);
    const preliminary = discovery.accounts[0]!;
    try {
      const initialProtocol = await decodeProtocolConfigAccount(preliminary);
      const launchAddress = quoteAddress === SOL_QUOTE_MINT_ADDRESS
        ? initialProtocol.activeSolLaunchConfig : initialProtocol.activeUsdcLaunchConfig;
      if (!initialProtocol.launchesEnabled) throw new Error("New curve launches are disabled");
      const requested = [protocolAddress, launchAddress, quoteAddress];
      const response = await read((abortSignal) => reader.getAccounts(requested, { commitment, minContextSlot: discovery.slot, abortSignal }));
      const batch = validateRead(requested, response, discovery.slot);
      const accounts = batch.accounts;
      const protocol = await decodeProtocolConfigAccount(accounts[0]!);
      const launchConfig = await decodeLaunchConfigAccount(accounts[1]!);
      const quoteMint = decodeLegacyMint(accounts[2]!);
      if (!protocol.launchesEnabled || launchConfig.quoteMint !== quoteAddress) throw new Error("Launch configuration is disabled or substituted");
      assertLaunchConfigActive(protocol, launchConfig);
      validateQuoteMint(quoteMint);
      return freezeSnapshot({ purpose: "launch", protocol, launchConfig, quoteMint, slot: batch.slot,
        commitment, observedAtUnixMs: Date.now(), deployment: ARCHLIQUID_DEVNET_DEPLOYMENT });
    } catch (cause) {
      if (cause instanceof OwnedSdkError) throw cause;
      throw new OwnedSdkError("invalid_snapshot", "Launch snapshot validation failed", { cause });
    }
  });
}

/** Discovery locates the immutable launch config; the final batch revalidates all related accounts together. */
export async function loadCurveSnapshot(reader: OwnedAccountReader, baseMintValue: string, options: OwnedSnapshotOptions = {}): Promise<OwnedCurveSnapshot> {
  options = captureSnapshotOptions(options);
  const baseMintAddress = address(baseMintValue);
  return withReads(options, async (read, signal) => {
    assertOwnedDeploymentGenesisHash(await read((abortSignal) => reader.getGenesisHash({ abortSignal })));
    const curveAddress = (await deriveCurveAddress(baseMintAddress)).address;
    const readOptions = { commitment: options.commitment ?? "confirmed", abortSignal: signal,
      ...(options.minContextSlot === undefined ? {} : { minContextSlot: options.minContextSlot }) } as const;
    const discoveryResponse = await read((abortSignal) => reader.getAccounts([curveAddress], { ...readOptions, abortSignal }));
    const discovery = validateRead([curveAddress], discoveryResponse, options.minContextSlot);
    const preliminary = discovery.accounts[0]!;
    if (preliminary.owner !== ARCH_CURVE_PROGRAM_ADDRESS || preliminary.data.length !== OWNED_ACCOUNT_LAYOUTS.curve.size ||
        !OWNED_ACCOUNT_LAYOUTS.curve.discriminator.every((byte, index) => preliminary.data[index] === byte)) {
      throw new OwnedSdkError("invalid_snapshot", "Curve discovery account is invalid");
    }
    const launchAddress = addressDecoder.decode(preliminary.data.slice(19, 51));
    const quoteAddress = addressDecoder.decode(preliminary.data.slice(115, 147));
    quoteMintAddress(quoteAddress, true);
    const [protocolAddress, baseVaultAddress, quoteVaultAddress] = await Promise.all([
      deriveProtocolConfigAddress(), deriveAssociatedTokenAddress(curveAddress, baseMintAddress), deriveAssociatedTokenAddress(curveAddress, quoteAddress),
    ]);
    const requested = [protocolAddress.address, launchAddress, curveAddress, baseMintAddress, quoteAddress, baseVaultAddress.address, quoteVaultAddress.address];
    const response = await read((abortSignal) => reader.getAccounts(requested, { ...readOptions, minContextSlot: discovery.slot, abortSignal }));
    const batch = validateRead(requested, response, discovery.slot);
    const accounts = batch.accounts;
    try {
      const protocol = await decodeProtocolConfigAccount(accounts[0]!);
      const launchConfig = await decodeLaunchConfigAccount(accounts[1]!);
      const curve = await decodeCurveAccount(accounts[2]!, launchConfig);
      const baseMint = decodeLegacyMint(accounts[3]!);
      const quoteMint = decodeLegacyMint(accounts[4]!);
      const baseVault = decodeLegacyTokenAccount(accounts[5]!);
      const quoteVault = decodeLegacyTokenAccount(accounts[6]!);
      assertFixedSupplyLaunchMint(baseMint, curve);
      validateQuoteMint(quoteMint);
      assertCurveVaultAccounting(curve, baseVault, quoteVault);
      return freezeSnapshot({ venue: "curve", slot: batch.slot, commitment: readOptions.commitment,
        observedAtUnixMs: Date.now(), deployment: ARCHLIQUID_DEVNET_DEPLOYMENT, protocol, launchConfig, curve,
        baseMint, quoteMint, baseVault, quoteVault });
    } catch (cause) {
      throw new OwnedSdkError("invalid_snapshot", "Curve snapshot validation failed", { cause });
    }
  });
}

/** All pool, config, mint and vault accounts are validated from a single batched response. */
export async function loadPoolSnapshot(reader: OwnedAccountReader, baseMintValue: string, quoteMintValue: string, options: OwnedSnapshotOptions = {}): Promise<OwnedPoolSnapshot> {
  options = captureSnapshotOptions(options);
  const baseMintAddress = address(baseMintValue);
  const quoteAddress = address(quoteMintValue);
  quoteMintAddress(quoteAddress);
  return withReads(options, async (read, signal) => {
    assertOwnedDeploymentGenesisHash(await read((abortSignal) => reader.getGenesisHash({ abortSignal })));
    const poolAddress = (await derivePoolAddress(baseMintAddress, quoteAddress)).address;
    const [swapAddress, lpAddress, baseVaultAddress, quoteVaultAddress] = await Promise.all([
      deriveSwapConfigAddress(), derivePoolLpMintAddress(poolAddress),
      deriveAssociatedTokenAddress(poolAddress, baseMintAddress), deriveAssociatedTokenAddress(poolAddress, quoteAddress),
    ]);
    const requested = [swapAddress.address, poolAddress, baseMintAddress, quoteAddress, lpAddress.address, baseVaultAddress.address, quoteVaultAddress.address];
    const commitment = options.commitment ?? "confirmed";
    const response = await read((abortSignal) => reader.getAccounts(requested, { commitment, abortSignal,
      ...(options.minContextSlot === undefined ? {} : { minContextSlot: options.minContextSlot }) }));
    const batch = validateRead(requested, response, options.minContextSlot);
    const accounts = batch.accounts;
    try {
      const swapConfig = await decodeSwapConfigAccount(accounts[0]!);
      const pool = await decodePoolAccount(accounts[1]!, swapConfig);
      const baseMint = decodeLegacyMint(accounts[2]!);
      const quoteMint = decodeLegacyMint(accounts[3]!);
      const lpMint = decodeLegacyMint(accounts[4]!);
      const baseVault = decodeLegacyTokenAccount(accounts[5]!);
      const quoteVault = decodeLegacyTokenAccount(accounts[6]!);
      assertPermanentlyFixedLegacyMint(baseMint, pool.baseMint);
      validateQuoteMint(quoteMint);
      assertPoolLpMintAccounting(pool, lpMint);
      assertPoolVaultAccounting(pool, baseVault, quoteVault);
      return freezeSnapshot({ venue: "pool", slot: batch.slot, commitment, observedAtUnixMs: Date.now(),
        deployment: ARCHLIQUID_DEVNET_DEPLOYMENT, swapConfig, pool, baseMint, quoteMint, lpMint, baseVault, quoteVault });
    } catch (cause) {
      throw new OwnedSdkError("invalid_snapshot", "Pool snapshot validation failed", { cause });
    }
  });
}
