# VELTRON

**Commitment-aware treasury infrastructure for autonomous businesses, built on [NEAR Protocol](https://near.org/).**

VELTRON protects money already assigned to future business obligations before an autonomous agent can spend treasury funds.

> The agent had permission to spend the money. It just wasn't supposed to spend that money.

## The problem

Autonomous businesses need agents that can pay contractors, suppliers, and service providers. A general spending limit alone cannot protect money already promised to someone else. An agent could stay below its transaction limit and still spend funds reserved for payroll or an invoice.

## Core mechanism: Commitment Lock

The treasury owner records obligations such as contractor invoices, supplier payments, or payroll, including each obligation's fixed recipient. VELTRON reserves those amounts in its on-chain accounting and only authorizes agent payments from the remaining spendable balance.

```
Spendable balance =
  Treasury balance
  - Active commitments
  - Safety reserve
  - Pending discretionary payments
```

The smart contract—not the AI agent or frontend—is the authority for payment decisions. An agent cannot edit or cancel commitments or change their recipients.

## Current MVP

The Rust contracts are in `contracts/treasury` and `contracts/test-token`.

- One configured NEP-141 fungible token.
- Owner-managed commitments with fixed recipients, bounded pagination, and aggregate reservation accounting.
- Owner-managed safety reserve and agent transaction limit.
- Agent-initiated discretionary payments.
- Owner-initiated commitment settlement.
- Asynchronous NEP-141 transfer callbacks, with pending transfers reserved until their outcomes are confirmed.
- Emergency pause for new outgoing payments and commitment settlements.
- Read-only token-balance audit and guarded reconciliation of observed surplus.
- Unit tests and NEAR Sandbox integration tests using a test NEP-141 token.

The MVP supports one owner, one authorized agent, and one configured token. It does not yet support multiple tokens, recurring schedules, cross-chain transfers, or agent-controlled commitment changes.

## Example

Imagine the treasury has 1,000 test-token units:

| Allocation | Amount |
|---|---:|
| Treasury balance | 1,000 |
| Contractor commitment | 400 |
| Supplier commitment | 200 |
| Safety reserve | 100 |
| **Available to spend** | **300** |

Even if the agent's per-transaction limit is 500, a request for 450 is rejected because it would use protected funds. A request for 250 is within the available balance.

These are illustrative test-token units, not a live USDC balance.

## Network and hackathon focus

- **Network:** NEAR Protocol
- **Primary track:** Autonomous Business
- **Related track:** AI Security & Defense

## Repository structure

```
.
├── .github/workflows/contract.yml
├── contracts/
│   ├── test-token/
│   └── treasury/
│       ├── src/lib.rs
│       └── tests/sandbox.rs
├── docs/CONTRACT-DESIGN.md
├── Cargo.toml
└── README.md
```

## Run the full contract checks locally

The sandbox integration tests embed the compiled WebAssembly files for both contracts. From the repository root, install the target, build both contracts, and then run the workspace tests:

```bash
rustup target add wasm32-unknown-unknown

cargo build --release -p veltron-treasury --target wasm32-unknown-unknown
cargo build --release -p veltron-test-token --target wasm32-unknown-unknown

cargo test --workspace
```

The GitHub Actions workflow performs these same WebAssembly builds and runs the workspace tests on relevant pushes and pull requests. The shorter `cargo test -p veltron-treasury` command runs the treasury crate's tests, but it does not replace the full WebAssembly build plus workspace/sandbox check above.

## Security and project status

VELTRON is an early hackathon MVP under active development. It has **not** been independently audited, deployed, or verified on NEAR testnet. Do not deposit real funds or use this implementation to manage production assets.

Before testnet or production use, review [the contract design and limitations](docs/CONTRACT-DESIGN.md), verify NEP-141 transfer and callback behavior, complete adversarial testing, and obtain an independent security review.

## Maintainer

Built by [@thisishaidee](https://github.com/thisishaidee).
