# VELTRON Testnet deployment fee and gas review

Status: **read-only live Testnet preflight passed on 2026-11-07; modeled self-addressed DeployContract fee and storage projection recorded; final wallet quote and post-deployment storage remain unverified**.

This document is deliberately not a transaction recipe. It does not authorize deployment, initialization, or wallet signing.

## Artifact facts

The reviewed test-token artifact is:

- Account: `veltron-token.testnet`
- File: `veltron_test_token.wasm`
- Size: **325,106 bytes**
- SHA-256: `5d5041336cc8fc92cc9ca11fff1f0b1f7ead33c4826c6d12013f957ba1e7c95b`

The size and hash identify the previously verified CI artifact. Any newly built artifact must be measured and hashed again.

## Step 1 — DeployContract fee

NEAR charges the DeployContract action using the runtime's deployment base fee plus a per-byte fee. The byte count is the exact length of the WASM code, not the ZIP artifact size.

Conceptually, the action fee is calculated from the active runtime configuration:

`deploy_contract_cost + (325106 × deploy_contract_cost_per_byte)`

The runtime also charges the transaction's action-receipt creation fees. The signer pays the resulting gas-denominated fee at the gas price in effect for the included block.

Important distinctions:

- DeployContract does **not** have a user-specified prepaid-gas field like FunctionCall.
- Do not invent a DeployContract gas limit or attach a deposit to the action.
- The deployment transaction still incurs protocol fees, and the account must have sufficient balance.
- The exact numeric fee must be calculated from the current NEAR Testnet runtime fee configuration and gas price immediately before constructing the transaction.
- Re-read the target account state and code hash immediately before deployment. Do not overwrite unexpected code.

## Live Testnet inputs required before any signing implementation

Read from the official NEAR Testnet RPC, using a recent finalized block:

1. `EXPERIMENTAL_protocol_config` with the recent block identifier:
   - Record protocol version.
   - Record `runtime_config.transaction_costs.action_creation_config.deploy_contract_cost`.
   - Record `deploy_contract_cost_per_byte`.
   - Record the relevant action receipt creation fees.
2. `block` for a recent finalized block:
   - Record the block hash and height.
   - Record its `header.gas_price`.
3. Calculate the deployment fee from those exact values and the verified 325,106-byte WASM.
4. Convert gas to yoctoNEAR using the returned gas price. Show both gas units and NEAR amount in the review.
5. Repeat immediately before signing if the configuration/block has changed. Do not reuse a stale quote.

### Captured read-only Testnet sample

CI workflow run [42386873087](https://github.com/thisishaidee/Veltron/actions/runs/42386873087) completed successfully on 2026-11-07. The fee-preflight script queried the official Testnet RPC and recorded:

- Finalized block height: **276650750**
- Finalized block hash: `PNyChhp2PFfQnN57z72okHqvpk6v7b7APEueKuQA4rv`
- Protocol version: **88**
- Sampled gas price: **100,000,000 yoctoNEAR/gas**
- DeployContract base `send_sir`: **184,765,750,000 gas**
- DeployContract per-byte `send_sir`: **6,812,999 gas/byte**
- Verified code size used in calculation: **325,106 bytes**
- Calculated DeployContract action gas: **2,399,712,602,894 gas**
- DeployContract action fee at sampled gas price: **239,971,260,289,400,000,000 yoctoNEAR = 0.000239971260 NEAR**
- Action receipt creation configuration: **108,059,500,000 gas** for each of `execution`, `send_not_sir`, and `send_sir`; at the sampled gas price, one such configured fee corresponds to **0.000010805950 NEAR**.

The receipt-creation configuration is recorded separately. Do not simply add one receipt fee and label the result the all-in transaction cost: the applicable receipt count and complete transaction/receipt path must be established for the actual submitted transaction. Other applicable costs and protocol behavior must also be checked.

The returned `storage_usage_config` contained `num_bytes_account=100` and `num_extra_bytes_record=40`, but did **not** expose `storage_amount_per_byte`. Therefore this run cannot produce a reliable code-storage stake estimate. Do not infer the storage stake from those two fields.

This is a sampled live configuration, not a guaranteed future quote. Re-read the finalized block and protocol configuration immediately before any wallet prompt. The numeric DeployContract action component is now reproducible from the recorded inputs, but **no final all-in deployment cost or required balance is approved**.

### Latest corrected preflight — 2026-11-07

The corrected script passed in Contract checks workflow run [42400914561](https://github.com/thisishaidee/Veltron/actions/runs/42400914561) on PR #5's merge test commit. The separate mobile/desktop browser checks passed in [42400914589](https://github.com/thisishaidee/Veltron/actions/runs/42400914589). This validates the automated build, Sandbox tests, read-only RPC script, and browser test suite; it does **not** validate a real wallet signature or transaction.

The script models `veltron-token.testnet` signing its own `DeployContract` action. NEAR requires the DeployContract predecessor/signer to match the receiver; do not use `haideedotxyz.testnet` as signer for a direct DeployContract to `veltron-token.testnet`.

Live read-only sample from finalized block:

- Height: **276667470**
- Hash: `BK3HKkaqHVhFwEVZ3Hyy4DMovgmxpcirtdyzHqhJCvJN`
- Protocol version: **88**
- Gas price: **100,000,000 yoctoNEAR/gas**
- DeployContract `send_sir` action component: **2,399,712,602,894 gas = 0.000239971260 NEAR**
- Modeled one-action transaction fee (receipt send + DeployContract send + receipt execution + DeployContract execution): **23,793,648,884,958 gas = 0.002379364888 NEAR**
- Runtime storage amount: **10,000,000,000,000,000,000 yoctoNEAR/byte**
- WASM code-byte reserve estimate: **3.251060000 NEAR**
- Target account balance: **5.319866090 NEAR**
- Target account storage usage before deployment: **182 bytes**
- Approximate projected storage usage after deployment: **325,288 bytes**
- Approximate projected storage-backed balance: **3.252880000 NEAR**
- Contract code at target account: **absent**

The modeled fee is an estimate, not a final all-in wallet quote. It excludes signature-verification gas where applicable, and the storage projection assumes adding the WASM byte count to current storage usage. Actual post-deployment storage usage and balance must be read again from Testnet. Do not interpret the apparent balance headroom as authorization to deploy.

## Sandbox initializer measurement

CI run [42386873087](https://github.com/thisishaidee/Veltron/actions/runs/42386873087) completed successfully. The current run repeated the exact token initializer measurement and verified its post-initialization views. The test deployed the exact test-token WASM in NEAR Sandbox and called `new` with the approved token metadata, owner and raw supply.

- Aggregate initializer receipt gas burnt: **2,043,249,965,121 gas units** (**2.043249965121 Tgas**).
- Test: `sandbox_measures_approved_token_initializer_and_verifies_supply` — passed.
- Post-initialization views verified metadata, total supply and owner balance.

This is an observed Sandbox execution measurement, not a Testnet fee quote or a final prepaid-gas setting. In the same successful run, the treasury suite passed **74 unit tests** and **15 Sandbox integration tests**; the token initializer Sandbox test passed **1/1**. Additional measurements recorded 2.852352376836 Tgas for a success callback at 256 commitments, 2.139992823416 Tgas for a failure callback at 255 commitments, and 2.852914884878 Tgas for a retry callback at 255 commitments. These are separate treasury callback paths, not token initializer gas. A provisional candidate for review is **3 Tgas**: this is approximately 47% headroom above the measured 2.04325 Tgas. It is not yet approved for use. Before adopting it, confirm current Testnet transaction/function-call gas limits and ensure the exact Meteor transaction preview accepts and displays 3 Tgas. If the current protocol limit or wallet behavior differs, stop and recalculate. This Sandbox measurement is a benchmark; it does not guarantee identical Testnet execution.

## Step 2 — Initialize token

Initialization is a separate FunctionCall:

- Receiver: `veltron-token.testnet`
- Method: `new`
- Attached deposit: **0 NEAR**, consistent with the current initializer not being payable. Verify the compiled contract/source and exact wallet transaction before approval.
- Arguments: use the exact reviewed JSON in the deployer preview.
- Prepaid gas: provisional candidate **3 Tgas**, pending verification against current Testnet protocol limits and the exact Meteor transaction preview. The 2.04325 Tgas figure is from Sandbox, not Testnet.

A generic `100 Tgas` value is not evidence that this initializer needs or should receive that amount. First run the initializer in NEAR Sandbox against the exact WASM and arguments, record gas burnt/used, and select a justified safety margin that remains within current protocol limits. Then independently validate the transaction parameters before any wallet prompt.

The initializer is one-time. Do not combine deployment and initialization into one opaque approval. Verify the on-chain code hash after deployment; only then prepare a separate initialization transaction.

## Stop conditions

Stop without signing if any of the following is true:

- The account, network, code state, artifact size, or hash differs from this review.
- Current Testnet protocol configuration or gas price cannot be retrieved.
- The fee calculation cannot be reproduced from recorded inputs.
- Sandbox initialization measurement is missing or exceeds protocol limits.
- The wallet's exact receiver, action, arguments, gas, or deposit differs from the reviewed values.
- The wallet's active network cannot be independently confirmed.

## References

- NEAR runtime fee specification: https://github.com/near/nearcore/blob/master/docs/RuntimeSpec/Fees/Fees.md
- NEAR gas-cost model: https://near.github.io/nearcore/architecture/gas/index.html
- NEAR gas flow and gas-price explanation: https://near.github.io/nearcore/architecture/how/gas.html

No wallet transaction has been sent. PR #5 remains a draft and unmerged. This document adds no signing or transaction-submission capability.
