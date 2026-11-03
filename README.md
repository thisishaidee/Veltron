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

The first Rust contract crate is in `contracts/treasury`.

- One configured NEP-141 fungible token.
- Owner-managed commitments with fixed recipients.
- Owner-managed safety reserve and agent transaction limit.
- Agent-initiated discretionary payments.
- Owner-initiated commitment settlement.
- Asynchronous transfer callbacks; pending discretionary payments remain reserved until confirmed.
- Unit tests for the initial accounting and reservation rules.

Read [the contract design and limitations](docs/CONTRACT-DESIGN.md) before using the MVP.

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

From the repository root, run:

```bash
cargo test -p veltron-treasury
```

A GitHub Actions workflow also runs the contract tests on relevant pushes and pull requests.
