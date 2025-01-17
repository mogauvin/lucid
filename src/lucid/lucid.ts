import { C } from '../core/index';
import Core from 'core/types';
import {
  costModel,
  utxoToCore,
  coreToUtxo,
  getAddressDetails,
  fromHex,
  toHex,
} from '../utils';
import {
  Address,
  Datum,
  ExternalWallet,
  Network,
  PrivateKey,
  Provider,
  Slot,
  TxHash,
  Unit,
  UTxO,
  Wallet,
  WalletProvider,
} from '../types';

export class Lucid {
  static txBuilderConfig: Core.TransactionBuilderConfig;
  static wallet: Wallet;
  static provider: Provider;
  static network: Network = 'Mainnet';

  static async initialize(provider: Provider, network?: Network) {
    if (this.txBuilderConfig && this.network === network) return;

    this.provider = provider;
    if (network) this.network = network;
    const protocolParameters = await provider.getProtocolParameters();
    this.txBuilderConfig = C.TransactionBuilderConfigBuilder.new()
      .coins_per_utxo_word(
        C.BigNum.from_str(protocolParameters.coinsPerUtxoWord.toString())
      )
      .fee_algo(
        C.LinearFee.new(
          C.BigNum.from_str(protocolParameters.minFeeA.toString()),
          C.BigNum.from_str(protocolParameters.minFeeB.toString())
        )
      )
      .key_deposit(C.BigNum.from_str(protocolParameters.keyDeposit.toString()))
      .pool_deposit(
        C.BigNum.from_str(protocolParameters.poolDeposit.toString())
      )
      .max_tx_size(protocolParameters.maxTxSize)
      .max_value_size(protocolParameters.maxValSize)
      .ex_unit_prices(
        C.ExUnitPrices.from_float(
          protocolParameters.priceMem,
          protocolParameters.priceStep
        )
      )
      .blockfrost(
        C.Blockfrost.new(
          provider.url + '/utils/txs/evaluate',
          provider.projectId
        )
      )
      .costmdls(costModel.plutusV1())
      .prefer_pure_change(true)
      .build();
  }

  static async currentSlot(): Promise<Slot> {
    return this.provider.getCurrentSlot();
  }

  static async utxosAt(address: Address): Promise<UTxO[]> {
    return this.provider.getUtxos(address);
  }

  static async utxosAtWithUnit(address: Address, unit: Unit): Promise<UTxO[]> {
    return this.provider.getUtxosWithUnit(address, unit);
  }

  static async awaitTx(txHash: TxHash): Promise<boolean> {
    return this.provider.awaitTx(txHash);
  }

  static async datumOf(utxo: UTxO): Promise<Datum> {
    if (!utxo.datumHash)
      throw new Error('This UTxO does not have a datum hash.');
    if (utxo.datum) return utxo.datum;
    utxo.datum = await this.provider.getDatum(utxo.datumHash);
    return utxo.datum;
  }

  /**
   * Cardano Private key in bech32; not the BIP32 private key or any key that is not fully derived
   */
  static async selectWalletFromPrivateKey(privateKey: PrivateKey) {
    const priv = C.PrivateKey.from_bech32(privateKey);
    const pubKeyHash = priv.to_public().hash();

    this.wallet = {
      address: async () =>
        C.EnterpriseAddress.new(
          this.network === 'Mainnet' ? 1 : 0,
          C.StakeCredential.from_keyhash(pubKeyHash)
        )
          .to_address()
          .to_bech32(),
      rewardAddress: async () => undefined,
      getCollateral: async () => {
        const utxos = await Lucid.utxosAt(await this.wallet.address());
        return utxos.filter(
          utxo =>
            Object.keys(utxo.assets).length === 1 &&
            utxo.assets.lovelace >= 5000000n
        );
      },
      getCollateralCore: async () => {
        const utxos = await Lucid.utxosAt(await this.wallet.address());
        return utxos
          .filter(
            utxo =>
              Object.keys(utxo.assets).length === 1 &&
              utxo.assets.lovelace >= 5000000n
          )
          .map(utxo => utxoToCore(utxo));
      },
      getUtxos: async () => {
        return await Lucid.utxosAt(await this.wallet.address());
      },
      getUtxosCore: async () => {
        const utxos = await Lucid.utxosAt(await this.wallet.address());
        const coreUtxos = C.TransactionUnspentOutputs.new();
        utxos.forEach(utxo => {
          coreUtxos.add(utxoToCore(utxo));
        });
        return coreUtxos;
      },
      signTx: async (tx: Core.Transaction) => {
        const witness = C.make_vkey_witness(
          C.hash_transaction(tx.body()),
          priv
        );
        const txWitnessSetBuilder = C.TransactionWitnessSetBuilder.new();
        txWitnessSetBuilder.add_vkey(witness);
        return txWitnessSetBuilder.build();
      },
      submitTx: async (tx: Core.Transaction) => {
        return await Lucid.provider.submitTx(tx);
      },
    };
  }

  static async selectWallet(walletProvider: WalletProvider) {
    if (!window?.cardano?.[walletProvider]) {
      throw new Error('Wallet not installed or not in a browser environment');
    }
    const api = await window.cardano[walletProvider].enable();

    this.wallet = {
      address: async () =>
        C.Address.from_bytes(
          fromHex((await api.getUsedAddresses())[0])
        ).to_bech32(),
      rewardAddress: async () => {
        const [rewardAddressHex] = await api.getRewardAddresses();
        const rewardAddress =
          rewardAddressHex ??
          C.RewardAddress.from_address(
            C.Address.from_bytes(fromHex(rewardAddressHex))
          )!
            .to_address()
            .to_bech32();
        return rewardAddress;
      },
      getCollateral: async () => {
        const utxos = (await api.experimental.getCollateral()).map(utxo => {
          const parsedUtxo = C.TransactionUnspentOutput.from_bytes(
            fromHex(utxo)
          );
          return coreToUtxo(parsedUtxo);
        });
        return utxos;
      },
      getCollateralCore: async () => {
        const utxos = (await api.experimental.getCollateral()).map(utxo => {
          return C.TransactionUnspentOutput.from_bytes(fromHex(utxo));
        });
        return utxos;
      },
      getUtxos: async () => {
        const utxos = ((await api.getUtxos()) || []).map(utxo => {
          const parsedUtxo = C.TransactionUnspentOutput.from_bytes(
            fromHex(utxo)
          );
          return coreToUtxo(parsedUtxo);
        });
        return utxos;
      },
      getUtxosCore: async () => {
        const utxos = C.TransactionUnspentOutputs.new();
        ((await api.getUtxos()) || []).forEach(utxo => {
          utxos.add(C.TransactionUnspentOutput.from_bytes(fromHex(utxo)));
        });
        return utxos;
      },
      signTx: async (tx: Core.Transaction) => {
        const witnessSet = await api.signTx(toHex(tx.to_bytes()), true);
        return C.TransactionWitnessSet.from_bytes(fromHex(witnessSet));
      },
      submitTx: async (tx: Core.Transaction) => {
        const txHash = await api.submitTx(toHex(tx.to_bytes()));
        return txHash;
      },
    };
  }

  /**
   * Emulates a CIP30 wallet by constructing it
   * with the UTxOs, collateral and addresses.
   *
   * If utxos are not set, utxos are fetched from the provided address
   */
  static async selectWalletFromUtxos({
    address,
    utxos,
    collateral,
    rewardAddress,
  }: ExternalWallet) {
    const addressDetails = getAddressDetails(address);
    this.wallet = {
      address: async () => address,
      rewardAddress: async () => {
        const rewardAddr =
          !rewardAddress && addressDetails.stakeCredential
            ? (() => {
                if (addressDetails.stakeCredential.type === 'Key') {
                  return C.RewardAddress.new(
                    Lucid.network === 'Mainnet' ? 1 : 0,
                    C.StakeCredential.from_keyhash(
                      C.Ed25519KeyHash.from_hex(
                        addressDetails.stakeCredential.hash
                      )
                    )
                  )
                    .to_address()
                    .to_bech32();
                }
                return C.RewardAddress.new(
                  Lucid.network === 'Mainnet' ? 1 : 0,
                  C.StakeCredential.from_scripthash(
                    C.ScriptHash.from_hex(addressDetails.stakeCredential.hash)
                  )
                )
                  .to_address()
                  .to_bech32();
              })()
            : rewardAddress;
        return rewardAddr;
      },
      getCollateral: async () => {
        return collateral ? collateral : [];
      },
      getCollateralCore: async () => {
        return collateral ? collateral.map(utxo => utxoToCore(utxo)) : [];
      },
      getUtxos: async () => {
        return utxos ? utxos : await this.utxosAt(address);
      },
      getUtxosCore: async () => {
        const coreUtxos = C.TransactionUnspentOutputs.new();
        (utxos ? utxos : await this.utxosAt(address)).forEach(utxo =>
          coreUtxos.add(utxoToCore(utxo))
        );
        return coreUtxos;
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      signTx: async (_: Core.Transaction) => {
        throw new Error('Not implemented');
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      submitTx: async (_: Core.Transaction) => {
        throw new Error('Not implemented');
      },
    };
  }
}

if (typeof window === 'undefined') {
  const fetch = await import(/* webpackIgnore: true */ 'node-fetch');
  // @ts-ignore
  global.fetch = fetch.default;
  // @ts-ignore
  global.Headers = fetch.Headers;
  // @ts-ignore
  global.Request = fetch.Request;
  // @ts-ignore
  global.Response = fetch.Response;
}
