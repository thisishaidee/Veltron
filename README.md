# VELTRON

**Commitment-aware treasury infrastructure for autonomous businesses, built on [NEAR Protocol](https://near.org/).**

VELTRON is designed to stop autonomous agents from spending treasury funds that have already been allocated to real business obligations.

An agent may have permission to make payments, but that does not mean every unit in the treasury is available to spend.

> The agent had permission to spend the money. It just wasn't supposed to spend that money.

## The problem

Autonomous businesses need agents that can pay contractors, suppliers, and service providers. But a general spending limit alone cannot protect money that has already been promised to someone else.

For example, an agent might stay below its transaction limit and still spend money reserved for payroll or an invoice.

VELTRON addresses this with an on-chain **Commitment Lock**.

## How Commitment Lock works

The treasury owner records obligations and their fixed recipients. VELTRON reserves those amounts in its internal accounting and calculates what remains available for discretionary agent payments.

```
Spendable balance =
  Treasury balance
  - Active commitments
  - Safety reserve
  - Pending discretionary payments
```

The smart contract enforces the accounting rules. The AI agent or frontend cannot override protected commitments.

## Current MVP

The first Rust contract implementation is in `contracts/treasury`.

It currently includes:

- A single configured NEP-141 fungible token.
- Owner-managed commitments with fixed recipients.
- An owner-managed safety reserve and agent transaction limit.
- Agent-initiated discretionary payment requests.
- Owner-initiated settlement of recorded commitments.
- Asynchronous token-transfer callbacks.
- Reservations for pending discretionary transfers until their outcomes are confirmed.
- Initial unit tests for accounting and reservation rules.

The current MVP supports one owner and one authorized agent. It does not yet support multiple tokens, recurring schedules, cross-chain transfers, or agent-controlled commitment changes.

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
├── .github/
│   └── workflows/
│       └── contract.yml
├── contracts/
│   └── treasury/
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs
├── docs/
│   └── CONTRACT-DESIGN.md
├── Cargo.toml
└── README.md
```

## Run the contract tests

With Rust and the required dependencies installed, run from the repository root:

```bash
cargo test -p veltron-treasury
```

GitHub Actions is configured to run the contract tests on relevant pushes and pull requests.

## Security and project status

VELTRON is an early hackathon MVP under active development. It has **not** been independently audited, deployed, or verified on NEAR testnet. Do not deposit real funds or use this implementation to manage production assets.

Before any testnet or production use, review [the contract design and limitations](docs/CONTRACT-DESIGN.md), verify NEP-141 transfer and callback behavior, and complete adversarial testing and an independent security review.

## Maintainer

Built by [@thisishaidee](https://github.com/thisishaidee).
