# VELTRON Testnet deployment fee and gas review

Status: **calculation procedure documented; live numeric fee/gas values not yet approved**.

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

The live RPC values have **not** been retrieved and independently recorded in this review. Therefore no numeric deployment fee is claimed here.

## Step 2 — Initialize token

Initialization is a separate FunctionCall:

- Receiver: `veltron-token.testnet`
- Method: `new`
- Attached deposit: **0 NEAR**, consistent with the current initializer not being payable. Verify the compiled contract/source and exact wallet transaction before approval.
- Arguments: use the exact reviewed JSON in the deployer preview.
- Prepaid gas: must be selected from a reproducible execution estimate and then checked against the current Testnet protocol limit and wallet display. The initializer's actual execution gas has not yet been measured on Testnet.

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

No wallet transaction has been sent. This document adds no signing or transaction-submission capability.
