# VELTRON

**Commitment-aware treasury infrastructure for autonomous businesses, built on NEAR Protocol.**

VELTRON protects money already assigned to future business obligations before an autonomous agent can spend treasury funds.

> The agent had permission to spend the money. It just wasn't supposed to spend that money.

## Core mechanism: Commitment Lock

The treasury owner records obligations such as contractor invoices, supplier payments, or payroll. VELTRON reserves those amounts in its on-chain accounting and only authorizes agent payments from the remaining spendable balance.

```
Spendable = Treasury Balance
          - Active Commitments
          - Safety Reserve
          - Pending Discretionary Payments
```

The contract—not the AI agent or frontend—is the authority for payment decisions.

## MVP implementation

The Rust treasury contract is in `contracts/treasury`; the NEP-141 test token is in `contracts/test-token`.

- One configured NEP-141 fungible token.
- Deposits credited through the configured token's `ft_transfer_call` receiver.
- Owner-managed commitments with fixed recipients and bounded pagination.
- Owner-managed safety reserve and agent transaction limit.
- Agent-initiated discretionary payments.
- Owner-initiated commitment settlement.
- Asynchronous transfer callbacks; pending discretionary payments remain reserved until confirmed.
- Emergency pause for new outgoing transfers and commitment settlements.
- Read-only token balance audit and guarded reconciliation of observed surplus.
- Unit and NEAR Sandbox integration tests for accounting, permissions, transfers, failures, retries, and callback behavior.

Read [the contract design and limitations](docs/CONTRACT-DESIGN.md) before using the MVP.

For a controlled testnet preparation and verification process, see the [testnet deployment checklist](docs/TESTNET-DEPLOYMENT-CHECKLIST.md). It is a checklist, not authorization to deploy or use real funds.

## Example

A treasury holds 1,000 test-token units.

| Item | Amount |
|---|---:|
| Treasury balance | 1,000 |
| Contractor commitment | 400 |
| Supplier commitment | 200 |
| Safety reserve | 100 |
| **Spendable** | **300** |

Even if the agent's per-transaction limit is 500, a request for 450 is rejected. A request for 250 is within the spendable balance.

These figures describe test-token units, not real USDC or a live stablecoin balance.

## Network and track

- **Network:** NEAR Protocol (testnet development target)
- **Primary hackathon track:** Autonomous Business
- **Secondary relevance:** AI Security & Defense

## Current status

This is an early hackathon MVP under active development. It has not been audited, deployed, or verified on testnet. Do not deposit real funds.

## Local contract checks

Install the Rust toolchain and the `wasm32-unknown-unknown` target, then run these commands from the repository root:

Build the treasury WebAssembly contract:

```bash
cargo build --release -p veltron-treasury --target wasm32-unknown-unknown
```

Build the test-token WebAssembly contract:

```bash
cargo build --release -p veltron-test-token --target wasm32-unknown-unknown
```

Run the complete workspace and NEAR Sandbox integration tests:

```bash
cargo test --workspace
```

For a faster treasury-only test run:

```bash
cargo test -p veltron-treasury
```

GitHub Actions runs both WebAssembly builds and the full workspace/Sandbox test suite on relevant pushes and pull requests. A passing CI run verifies that commit's build and tests; it is not a security audit or deployment approval.
